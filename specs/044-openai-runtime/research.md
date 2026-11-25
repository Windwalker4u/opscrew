# 044 OpenAI API keys beside Anthropic's: research

Read 2026-11-25 from OpenAI's official documentation and package metadata (`openai`, `@openai/agents`), OpenRouter's official Responses API docs, and this repository's `specs/032-codex-plugin/research.md` and `packages/runtime-claude/`.

## R1. Official SDK options

| Option | Package & version (2026-11-25) | Licence | Transitive runtime deps | Tool control |
|---|---|---|---|---|
| **OpenAI Node SDK (Responses API)** | `openai` `7.64.0` | Apache-2.0 | Minimal (Node >= 22, native `fetch`) | Full: OpsCrew defines only `type: "function"` tools and runs the loop itself. |
| **OpenAI Agents SDK** | `@openai/agents` `0.22.0` | MIT | `@openai/agents-core`, `@openai/agents-openai`, `@openai/agents-realtime`, `openai` | Higher-level runner/handoffs/guardrails abstraction with extra surface OpsCrew does not use; still wraps `openai`. |
| **Codex (032)** | Codex CLI / plugin (`specs/032-codex-plugin/research.md`) | — | Separate host binary | Not a Node runtime SDK: Codex is an interactive agent host that consumes OpsCrew as an MCP plugin, with its own sandbox and approval loop (`sandbox_mode`, `approval_policy`). It cannot be driven as an in-process `AgentRuntime` behind `DefaultToolPolicy`. |

**Decision: use `openai` (`^7.64.0`) directly with the Responses API (`client.responses.create`).**
- **Rationale:**
  1. Single Apache-2.0 dependency matching OpsCrew's own licence and Node >= 22 runtime (constitution X).
  2. OpsCrew owns every line of the agent loop. No OpenAI hosted tools (`web_search`, `file_search`, `code_interpreter`, `shell`, `computer_use`, `apply_patch`) are ever declared or invoked, so nothing can bypass `DefaultToolPolicy` (constitution I).
  3. Built-in `fetch` override (`new OpenAI({ apiKey, baseURL, fetch, maxRetries })`) and an injectable Responses transport make unit tests 100% deterministic with zero network calls (constitution VII).
  4. Calling `responses.create` statelessly (`store: false`, sending full `input` history on each turn, including returned `reasoning` and `function_call` items) works both directly against OpenAI (`https://api.openai.com/v1`) and against stateless OpenAI-compatible gateways such as OpenRouter (`OPENAI_BASE_URL=https://openrouter.ai/api/v1`), and avoids persisting repository contents on OpenAI servers.
- **Rejected:** `@openai/agents` (brings realtime/handoff/multi-agent packages OpsCrew does not need while still requiring OpsCrew to wrap every tool with `DefaultToolPolicy` and `ApprovalHandler`); Codex CLI (host-side plugin consumer, not a programmatic runtime).

## R2. Responses API mechanics

From OpenAI's official Responses API docs and `openai-node` (`7.64.0`):
- **Endpoint:** `POST {baseURL}/responses` via `client.responses.create(params, { signal })`.
- **System instructions:** `instructions: string` (redacted before sending).
- **Conversation input:** array of input items. Turn 1 sends `[{ role: "user", content: redactedPrompt }]`. When the response contains `function_call` output items, the runtime appends all response `output` items (preserving `reasoning` items alongside `function_call` items as required by the Responses API) plus one `{ type: "function_call_output", call_id, output }` item per tool call, and issues the next turn.
- **Tools:** each enabled `BuiltinTool` (`Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash`, filtered by `PROFILE_TOOLS[request.profile]` and `request.builtinTools`) is declared as `{ type: "function", name, description, parameters, strict: false }`, using the exact argument field names `DefaultToolPolicy` inspects (`file_path`, `pattern`, `path`, `glob`, `command`).
- **Structured output:** when `request.output` is set, passed via `text.format`:
  ```ts
  text: {
    format: {
      type: "json_schema",
      name: safeName,
      description: request.output.description,
      schema: z.toJSONSchema(request.output.schema, { target: "draft-07" }),
      strict: false,
    },
  }
  ```
  - *Why `strict: false` + zod validation:* OpenAI's `strict: true` subset rejects standard JSON Schema keywords that OpsCrew's existing phase schemas use (`minLength`, `maxLength`, `maxItems`, `minimum`, `maximum`, `pattern`, optional non-nullable properties — see `AnalystOutputSchema` and `CodeChangeReportSchema`), and several compatible gateways do not implement strict-mode grammar compilation. Using `strict: false` preserves the full schema hints for the model, works across gateways, and OpsCrew always validates the final JSON with `request.output.schema.safeParse(...)`, returning `stopReason: "invalid_output"` on any mismatch (constitution V).
- **Refusals:** a response output message containing a `refusal` content part (or `status === "incomplete"` with content-filter reason) maps to `stopReason: "refused"`.
- **Errors:** HTTP `401` / `403` authentication errors map to plain-English errors explaining `OPENAI_API_KEY` (and `OPENAI_BASE_URL` when set), passed through the redactor so the key never appears.

## R3. Default models, effort, and pricing

From OpenAI's official API pricing page (checked 2026-11-25):

| Model | Input ($ / 1M) | Cached input ($ / 1M) | Output ($ / 1M) | Role in OpsCrew |
|---|---|---|---|---|
| `gpt-5-mini` | 0.25 | 0.025 | 2.00 | Default for `analyze` (read-only Analyst, analogous to `claude-haiku-5-5`) |
| `gpt-5` | 1.25 | 0.125 | 10.00 | Default for `adapt` (Code-change agent, analogous to `claude-opus-5-5`) and runtime fallback |
| `gpt-5-nano` | 0.05 | 0.005 | 0.40 | Pricing table entry |
| `gpt-4.1` | 2.00 | 0.50 | 8.00 | Pricing table entry |
| `gpt-4.1-mini` | 0.40 | 0.10 | 1.60 | Pricing table entry |
| `gpt-4.1-nano` | 0.10 | 0.025 | 0.40 | Pricing table entry |
| `gpt-4o` | 2.50 | 1.25 | 10.00 | Pricing table entry |
| `gpt-4o-mini` | 0.15 | 0.075 | 0.60 | Pricing table entry |
| `o3` | 2.00 | 0.50 | 8.00 | Pricing table entry |
| `o4-mini` | 1.10 | 0.275 | 4.40 | Pricing table entry |

- **Token accounting:** Responses API `usage` reports `input_tokens` (inclusive of cached tokens), `input_tokens_details.cached_tokens`, and `output_tokens` (inclusive of reasoning tokens). Uncached input = `max(0, input_tokens - cached_tokens)`.
  - If a gateway (such as OpenRouter) reports a finite non-negative `usage.cost` directly in USD, OpsCrew uses that figure; otherwise it computes the cost from the dated price table above (stripping provider prefixes like `openai/` and dated snapshot suffixes like `-2025-08-07`). Unknown custom models price at `$0` rather than crashing.
- **Reasoning effort:** OpsCrew's `Effort` type is `"low" | "medium" | "high" | "xhigh" | "max"`.
  - Sent as `reasoning: { effort }` only for reasoning-capable models (`gpt-5*`, `gpt-6*`, `o1*`, `o3*`, `o4*`) so non-reasoning models (`gpt-4.1*`, `gpt-4o*`) and gateways do not reject unknown parameters.
  - `"low"`, `"medium"`, `"high"` pass through directly; `"xhigh"` and `"max"` map to `"high"` (the highest widely supported Responses API effort across GPT-5 / o-series models and gateways).
- **Phase model selection (`AgentRuntime.defaultModelFor?`):**
  - Currently `packages/agents/src/analyze/run.ts` defaults to `DEFAULT_ANALYST_MODEL` (`"claude-haiku-5-5"`) and `packages/agents/src/adapt/run.ts` defaults to `CODE_CHANGE_MODEL` (`"claude-opus-5-5"`).
  - Adding an optional `defaultModelFor?(phase: PhaseName): string` method to `AgentRuntime` lets `OpenAIAgentRuntime` return `"gpt-5-mini"` for `"analyze"` and `"gpt-5"` for `"adapt"` (or its configured `defaultModel` when `--model` / `OPSCREW_MODEL` is set), while leaving `ClaudeAgentRuntime`, `FakeAgentRuntime`, and all existing tests unchanged.

## R4. Tool loop and safety boundary

Every tool call executes inside `@opscrew/runtime-openai`:
1. Parse JSON arguments safely; invalid JSON or non-object input fails closed with a denial.
2. Evaluate `policy.evaluate({ tool, input, phase, profile, projectRoot })`:
   - `deny` → audit `tool-denied` (`decision: "deny"`), emit `tool-denied`, return denial text to the model.
   - `ask` → request `approvals.request({ kind: "tool-call", title, details })` (including GitHub Actions file content preview, matching `runtime-claude`). Without `approvals` or on refusal → audit `tool-denied`, emit `tool-denied`, return refusal text.
   - `allow` / approved → emit `tool-call`, execute OpsCrew's local tool implementation inside `projectRoot`, audit `tool-call` (`decision: "allow" | "approved"`), emit `tool-result`, pass the entire output through `redact(...)`, and return it as `function_call_output`.
3. **Defense in depth in local tool executors:**
   - `Read`, `Write`, `Edit` resolve paths relative to `projectRoot`, check `realpath` against `projectRoot` (blocking symlinks that escape the root), and never read/write secret paths (`isSecretPath`).
   - `Glob` and `Grep` skip secret paths (`isSecretPath`) and never follow symlinks escaping `projectRoot`, even if an approval was granted.
   - `Bash` runs via an injectable `CommandRunner` (`NodeCommandRunner` by default) with `cwd: projectRoot` and `env: sanitizeAgentEnv(env)` — which strips `OPENAI_API_KEY` as well as all cloud/provider credentials, because the OpenAI client runs in-process and child shells never need the key.

## R5. Runtime selection and documentation

- **Selection in `packages/cli/src/deps.ts`:**
  1. `--no-ai` (`options.ai === false`) → no runtime (`undefined`).
  2. Injected `services.runtime` (tests) → used as-is.
  3. `OPSCREW_RUNTIME` (trimmed, lowercased):
     - `"openai"` → `OpenAIAgentRuntime` (even if `OPENAI_API_KEY` is missing, so `isConfigured()` surfaces the plain-English OpenAI setup hint rather than silently falling back to Anthropic).
     - `"claude"` or `"anthropic"` → `ClaudeAgentRuntime` when Claude credentials exist (or when explicitly selected so `isConfigured()` surfaces the Claude setup hint).
     - unset / empty → `ClaudeAgentRuntime` if Claude credentials exist, else `OpenAIAgentRuntime` if `OPENAI_API_KEY` is set, else `undefined`.
- **Environment variables:** `OPENAI_API_KEY`, `OPENAI_BASE_URL` (optional compatible gateway URL), `OPSCREW_RUNTIME` (`claude` | `openai`), `OPSCREW_MODEL` (model override for either runtime).
- **Guide:** no existing page in `docs/guide/` covered AI keys (`grep -rl ANTHROPIC_API_KEY docs/guide` had zero matches). Add `docs/guide/ai-models.md` linked from `docs/guide/index.md` and update `README.md` Quickstart.

## Sources (2026-11-25)

- OpenAI Node SDK (`openai` 7.64.0 on npm, Apache-2.0): https://github.com/openai/openai-node
- OpenAI Responses API & Structured Outputs: https://platform.openai.com/docs/api-reference/responses
- OpenAI API Pricing: https://openai.com/api/pricing
- OpenRouter Responses API: https://openrouter.ai/docs/api-reference/responses
- OpsCrew Codex plugin research: `specs/032-codex-plugin/research.md`

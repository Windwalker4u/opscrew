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

From OpenAI's official API pricing page and `openai@7.64.0`'s official model list (checked 2026-11-25):

| Model | Input ($ / 1M) | Cached input ($ / 1M) | Output ($ / 1M) | Role in OpsCrew |
|---|---|---|---|---|
| `gpt-6-luna` | 0.10 | 0.005 | 0.50 | Default for `analyze` (read-only Analyst, fast & low-cost within the $0.50 cap) |
| `gpt-6.2-sol` | 2.00 | 0.10 | 10.00 | Default for `adapt` (Code-change agent: current balanced coding flagship, fits well inside the $3.00 cap, unlike `gpt-6.2-astra` at $8/$40) and runtime fallback |
| `gpt-6.2-astra` / `gpt-6-astra` | 8.00 | 0.40 | 40.00 | Pricing table entry |
| `gpt-6.1-terra` | 1.00 | 0.05 | 5.00 | Pricing table entry |
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | 4.00 / 1.50 / 0.20 | 0.40 / 0.15 / 0.02 | 20.00 / 7.50 / 1.20 | Pricing table entries |
| `gpt-5.5` / `gpt-5.5-pro` | 5.00 / 30.00 | 0.50 / 30.00 | 30.00 / 180.00 | Pricing table entries |
| `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.4-nano` / `gpt-5.4-pro` | 2.50 / 0.75 / 0.20 / 30.00 | 0.25 / 0.075 / 0.02 / 30.00 | 15.00 / 4.50 / 1.25 / 180.00 | Pricing table entries |
| `gpt-5.2` / `gpt-5.2-pro` | 1.75 / 21.00 | 0.175 / 21.00 | 14.00 / 168.00 | Pricing table entries |
| `gpt-5` / `gpt-5-mini` / `gpt-5-nano` / `gpt-5-pro` | 1.25 / 0.25 / 0.05 / 15.00 | 0.125 / 0.025 / 0.005 / 15.00 | 10.00 / 2.00 / 0.40 / 120.00 | Pricing table entries |
| `gpt-4.1` / `gpt-4.1-mini` / `gpt-4.1-nano` | 2.00 / 0.40 / 0.10 | 0.50 / 0.10 / 0.025 | 8.00 / 1.60 / 0.40 | Pricing table entries |
| `gpt-4o` / `gpt-4o-mini` | 2.50 / 0.15 | 1.25 / 0.075 | 10.00 / 0.60 | Pricing table entries |
| `o3` / `o3-pro` / `o3-mini` / `o4-mini` / `o1` / `o1-pro` | 2.00 / 20.00 / 1.10 / 1.10 / 15.00 / 150.00 | 0.50 / 20.00 / 0.55 / 0.275 / 7.50 / 150.00 | 8.00 / 80.00 / 4.40 / 4.40 / 60.00 / 600.00 | Pricing table entries |

- **Token accounting & fail-closed budgets:** Responses API `usage` reports `input_tokens` (inclusive of cached tokens), `input_tokens_details.cached_tokens`, and `output_tokens` (inclusive of reasoning tokens). Models are matched by **exact normalized id** (stripping optional `openai/` prefix and `-YYYY-MM-DD` date) so Pro tiers like `gpt-5-pro` never fall through to cheaper prefixes. If a gateway (such as OpenRouter) reports a finite non-negative `usage.cost`, OpsCrew uses it. If a model has no price in the table and the gateway reports no `usage.cost`, runs with `maxBudgetUsd` **fail closed** instead of silently bypassing the budget cap.
- **Stateless multi-turn reasoning (`store: false`):** for reasoning models, requests include `include: ["reasoning.encrypted_content"]`. Returned reasoning items with `encrypted_content` are replayed with `encrypted_content` unredacted (while redacting any `summary` text); reasoning items without `encrypted_content` are dropped so OpenAI never returns 404 (`Item with id 'rs_...' not found`).
- **Reasoning effort:** OpsCrew's `Effort` (`"low" | "medium" | "high" | "xhigh" | "max"`) maps 1:1 to `openai@7.64.0`'s `ReasoningEffort`, sent only for reasoning-capable models (explicitly excluding `*-chat*` models such as `gpt-5-chat-latest` and non-reasoning `gpt-4.*` models).
- **Phase model selection (`AgentRuntime.defaultModelFor?`):** `OpenAIAgentRuntime` returns `"gpt-6-luna"` for `"analyze"` and `"gpt-6.2-sol"` for `"adapt"` (or its configured `defaultModel` when `--model` / `OPSCREW_MODEL` is set).

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

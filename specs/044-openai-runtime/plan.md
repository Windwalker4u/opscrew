# Implementation Plan: OpenAI API keys beside Anthropic's

**Branch**: `044-openai-runtime` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)
**Input**: [spec.md](spec.md), [research.md](research.md), issue `#25`.

## Summary

Add `@opscrew/runtime-openai` (`packages/runtime-openai`) implementing `AgentRuntime` on top of the official `openai` SDK's Responses API (`responses.create`, stateless `store: false`) with OpsCrew's own local `Read`/`Glob`/`Grep`/`Edit`/`Write`/`Bash` executors gated by `DefaultToolPolicy`, `ApprovalHandler`, `AuditLog`, and `Redactor`. Wire runtime selection in `packages/cli/src/deps.ts`, optional per-phase default models via `AgentRuntime.defaultModelFor?`, `opscrew init`'s model check, and the user guide (`docs/guide/ai-models.md`).

## Technical Context

- **Language & tooling**: TypeScript strict ESM, Node >= 22.9, pnpm 10, Turborepo, Vitest, zod 4, Biome.
- **New dependency**: `openai` (`^7.64.0`, Apache-2.0) in `packages/runtime-openai/package.json` (and `packages/cli/package.json` runtime dependencies so `tsup` keeps it external for the bundled CLI, matching `yaml`, `zod`, `ignore`, etc.).
- **Testing**: 100% fake-based unit tests (injected Responses transport or fake `fetch`, fake `CommandRunner`, temp directories for file tool tests, `fakeSecret()` from `@opscrew/core/testing`). No network calls, no real API keys. Live OpenAI verification steps are documented in the PR for the founder.

## Constitution Check

- **I. Safety Gate on Every Mutation**: Every tool call goes through `ToolPolicy.evaluate()` before execution; `ask` goes through `ApprovalHandler` (with `.github/` / `action.yml` content preview); `deny` and refusals never execute and are audited. No hosted OpenAI tools are declared. ✅
- **II. The User Owns Everything**: No hidden state or lock-in; `store: false` avoids storing repo contents server-side. ✅
- **IV. Secrets Never Leak**: Prompts, system prompts, tool outputs, streamed events, final text, audit details, and errors pass through `redact`. `Bash` receives `sanitizeAgentEnv(env)` (which strips `OPENAI_API_KEY` and all cloud/provider secrets). Fixtures use `fakeSecret()`. ✅
- **V. Deterministic First, LLM Where It Adds Judgment**: `--no-ai` continues to bypass all runtimes; structured output is validated with zod (`invalid_output` on failure). ✅
- **VI. Contracts-First Package Boundaries**: One additive optional method `defaultModelFor?(phase: PhaseName): string` on `AgentRuntime` in `@opscrew/contracts` (reported on `#25`). All cross-package imports use package roots only. ✅
- **VII. Test-First and Verifiable**: Every module built test-first with explicit `Verify:` commands; no network calls in tests. ✅
- **X. Simplicity and Lean Dependencies**: One official Apache-2.0 dependency (`openai`). ✅

## Design

### 1. Contract (`packages/contracts/src/runtime.ts`)
Add one optional method to `AgentRuntime`:
```ts
/** Default model id for `phase` when the caller did not specify `--model` or `OPSCREW_MODEL`. */
defaultModelFor?(phase: PhaseName): string;
```
`analyze/run.ts` and `adapt/run.ts` resolve the model as:
`options.model ?? deps.runtime?.defaultModelFor?.(phase) ?? DEFAULT_ANALYST_MODEL` (or `CODE_CHANGE_MODEL`).
`ClaudeAgentRuntime` and `FakeAgentRuntime` omit it, keeping their behaviour and tests identical.

### 2. Package `packages/runtime-openai` (`@opscrew/runtime-openai`)
- `src/pricing.ts`: dated OpenAI list-price table (`PRICING_DATE = "2026-11-25"`), `resolveModelPrice(model)`, `calculateUsageCostUsd(model, usage)` (preferring finite non-negative `usage.cost` if a gateway supplies it, otherwise computing `(uncachedInput * input + cachedInput * cachedInput + output * output) / 1_000_000`).
- `src/tools.ts`:
  - `toolDefinitionsFor(builtins)`: OpenAI Responses API `FunctionTool` definitions for `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash` matching `DefaultToolPolicy`'s exact input keys (`file_path`, `pattern`, `path`, `glob`, `command`).
  - `executeBuiltinTool(tool, input, context)`: safe local implementations bounded to `projectRoot`, checking `realpath` and `isSecretPath` as defense in depth, running `Bash` via injected `CommandRunner` with `sanitizeAgentEnv(env)`, capping outputs, respecting `AbortSignal`.
- `src/runtime.ts`:
  - `OpenAIAgentRuntime implements AgentRuntime` (`id = "openai-responses"`).
  - `DEFAULT_OPENAI_ANALYST_MODEL = "gpt-5-mini"`, `DEFAULT_OPENAI_MODEL = "gpt-5"`.
  - `isConfigured()`: checks non-empty `OPENAI_API_KEY`; returns plain-English reason and hint naming `OPENAI_API_KEY` and optional `OPENAI_BASE_URL`.
  - `defaultModelFor(phase)`: returns `this.#defaultModel` if explicitly configured, else `"gpt-5-mini"` for `"analyze"` and `"gpt-5"` otherwise.
  - `runPhase(request)`:
    - Stateless Responses API loop (`store: false`) with `instructions`, `input`, `tools` (omitted for `none`), `reasoning` (for reasoning models when `effort` is set), and `text.format` (`json_schema`, `strict: false`, `z.toJSONSchema(schema, { target: "draft-07" })`).
    - Turn limit (`maxTurns`), spend limit (`maxBudgetUsd`), abort handling (`AbortSignal`), refusal detection, auth error mapping (401/403), structured-output parsing + zod validation (`invalid_output`), `costLedger.append`, and `audit.append` for every tool call, denial, and phase summary.
- `src/index.ts`: public exports (`OpenAIAgentRuntime`, types, default model constants, pricing helpers).

### 3. CLI & Agents wiring
- `packages/agents/src/analyze/run.ts` & `packages/agents/src/adapt/run.ts`: resolve default model via `runtime.defaultModelFor?.(phase)`.
- `packages/agents/src/init/checks.ts`: recognize `OPENAI_API_KEY` in `checkModel` and update `MODEL_HINT`.
- `packages/cli/src/deps.ts`:
  - Add `openaiConfigured(env)` and runtime selection logic (`--no-ai` > `extra.runtime` > `OPSCREW_RUNTIME` > Anthropic > OpenAI > `undefined`).
  - Pass `policy: new DefaultToolPolicy({ realpath: nodeRealpath })`, `audit`, `redact`, `approvals`, `runner`, `fetch`, `env`, and optional `defaultModel`.
  - Update `MODEL_SETUP_HINT` to mention `OPENAI_API_KEY` (and `OPENAI_BASE_URL` / `OPSCREW_RUNTIME=openai`).
- `packages/cli/src/commands/analyze.ts` & `adapt.ts`: update `--model` help descriptions.
- `packages/cli/package.json` & `packages/cli/tsup.config.ts`: add `@opscrew/runtime-openai` (`devDependencies`) and `openai` (`dependencies`, external in `tsup`).

### 4. Documentation
- `docs/guide/ai-models.md`: new guide page for AI model setup (Anthropic, OpenAI, OpenRouter / `OPENAI_BASE_URL`, `OPSCREW_RUNTIME`, `--model` / `OPSCREW_MODEL`, `--no-ai`, safety and cost ledger).
- `docs/guide/index.md`: link `ai-models.md` under `Using OpsCrew`.
- `README.md`: mention `OPENAI_API_KEY` beside `ANTHROPIC_API_KEY` in Quickstart.

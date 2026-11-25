# Tasks: OpenAI API keys beside Anthropic's

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), issue `#25`.

## Wave 1: Contract and package foundation

- [x] T4401 [US1] Add optional `defaultModelFor?(phase: PhaseName): string` to `AgentRuntime` (`packages/contracts/src/runtime.ts`)
  - **Owns:** `packages/contracts/src/runtime.ts`
  - **Depends:** none (additive optional method; reported on `#25`)
  - **Accept:** `AgentRuntime` declares `defaultModelFor?(phase: PhaseName): string`; all existing implementations (`ClaudeAgentRuntime`, `FakeAgentRuntime`) typecheck unchanged.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/contracts`

- [x] T4402 [US1] [US3] Scaffold `packages/runtime-openai` with `openai` dependency and pricing module (test-first)
  - **Owns:** `packages/runtime-openai/{package.json,tsconfig.json,vitest.config.ts}`, `packages/runtime-openai/src/pricing.ts`, `packages/runtime-openai/src/pricing.test.ts`, `pnpm-lock.yaml`
  - **Depends:** none
  - **Accept:** Dated OpenAI pricing table covers GPT-5, GPT-5-mini, GPT-5-nano, GPT-4.1 family, GPT-4o family, o3, o4-mini; accounts for cached input tokens; strips provider prefix (`openai/`) and snapshot dates; honours gateway `usage.cost` when present; unknown models cost `$0`.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/runtime-openai`

## Wave 2: Local tool executors and OpenAI runtime loop

- [x] T4403 [US2] Implement local `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash` tool schemas and executors (test-first)
  - **Owns:** `packages/runtime-openai/src/tools.ts`, `packages/runtime-openai/src/tools.test.ts`
  - **Depends:** T4402
  - **Accept:** Tool schemas match `DefaultToolPolicy` parameter names (`file_path`, `pattern`, `path`, `glob`, `command`); file tools enforce `projectRoot` boundary and reject escaping symlinks and secret paths; `Glob`/`Grep` skip secret paths; `Bash` uses injected `CommandRunner` with `sanitizeAgentEnv(env)` (no `OPENAI_API_KEY` or cloud secrets in child env).
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/runtime-openai`

- [x] T4404 [US1] [US2] [US3] Implement `OpenAIAgentRuntime` on Responses API (test-first)
  - **Owns:** `packages/runtime-openai/src/runtime.ts`, `packages/runtime-openai/src/runtime.test.ts`, `packages/runtime-openai/src/index.ts`
  - **Depends:** T4401, T4402, T4403
  - **Accept:**
    - `isConfigured()` validates `OPENAI_API_KEY` and returns plain-English reason/hint when absent.
    - Stateless Responses API loop (`store: false`), forwarding `OPENAI_BASE_URL` and `reasoning.effort` (for reasoning models only).
    - Every tool call gated by `ToolPolicy` + `ApprovalHandler` (with `.github/` content preview on `ask`), audited (`tool-call` / `tool-denied` / `phase`), and outputs redacted before leaving the machine.
    - All `PhaseStopReason` values (`completed`, `max_turns`, `budget_exceeded`, `refused`, `invalid_output`, `aborted`, `error`) tested against fake transport; 401/403 maps to plain-English key error; zod validation enforced on `request.output`; `costLedger.append` called with computed `costUsd`.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/runtime-openai`

## Wave 3: Agents, CLI wiring, and documentation

- [x] T4405 [US1] [US4] Wire `defaultModelFor` in `analyze`/`adapt` and `OPENAI_API_KEY` in `init` (test-first)
  - **Owns:** `packages/agents/src/analyze/run.ts`, `packages/agents/src/analyze/analyze.test.ts`, `packages/agents/src/adapt/run.ts`, `packages/agents/src/adapt/run.test.ts`, `packages/agents/src/init/checks.ts`, `packages/agents/src/init/init.test.ts`
  - **Depends:** T4401
  - **Accept:** `analyze` and `adapt` use `runtime.defaultModelFor?.(phase)` when `options.model` is omitted (Claude/fake defaults unchanged); `init`'s model check passes with `OPENAI_API_KEY` and mentions both keys in its hint.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/agents`

- [x] T4406 [US1] Wire `OpenAIAgentRuntime` selection in CLI `deps.ts`, command help, and CLI bundle (test-first)
  - **Owns:** `packages/cli/package.json`, `packages/cli/tsup.config.ts`, `packages/cli/src/deps.ts`, `packages/cli/src/deps.test.ts`, `packages/cli/src/commands/{analyze,adapt}.ts`
  - **Depends:** T4404, T4405
  - **Accept:** Selection rules hold: Anthropic wins when both set; OpenAI used when only `OPENAI_API_KEY` is set; `OPSCREW_RUNTIME=openai` selects OpenAI even when Anthropic is set; `--no-ai` disables both; `OPENAI_BASE_URL` passed through; `pnpm --filter opscrew build` succeeds.
  - **Verify:** `pnpm turbo run typecheck test build --filter=opscrew`

- [x] T4407 [US4] Write user documentation for OpenAI and compatible gateways
  - **Owns:** `docs/guide/ai-models.md`, `docs/guide/index.md`, `README.md`
  - **Depends:** T4406
  - **Accept:** `docs/guide/ai-models.md` covers Anthropic, OpenAI, OpenRouter/`OPENAI_BASE_URL`, `OPSCREW_RUNTIME`, `--model`/`OPSCREW_MODEL`, `--no-ai`, and cost tracking; linked in `docs/guide/index.md`; `README.md` Quickstart mentions `OPENAI_API_KEY`.
  - **Verify:** `pnpm check`

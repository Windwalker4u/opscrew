# Feature Specification: OpenAI API keys beside Anthropic's

**Feature Branch**: `044-openai-runtime` (feature directory `specs/044-openai-runtime`)
**Created**: 2026-11-25
**Status**: In progress
**Input**: Roadmap entry `044 OpenAI API keys beside Anthropic's`, issue `#25`, and [research.md](research.md).

## Why

OpsCrew's LLM-backed phases (`analyze` for the read-only Analyst and `adapt` for the Code-change agent) currently require Anthropic / Claude credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or Bedrock/Vertex/Foundry). Users who already have an OpenAI API key — or route models through an OpenAI-compatible gateway such as OpenRouter — cannot run AI-assisted analysis or code adaptation without creating an Anthropic account.

Adding `@opscrew/runtime-openai` behind the existing `AgentRuntime` contract (`@opscrew/contracts`) lets users run `opscrew analyze` and `opscrew adapt` with `OPENAI_API_KEY` (and optional `OPENAI_BASE_URL`) under the exact same tool policy, approval gates, redaction, structured-output validation, and cost ledger as `@opscrew/runtime-claude`.

## User Scenarios & Testing

### User Story 1 - Run `analyze` and `adapt` with `OPENAI_API_KEY` (Priority: P1)

**Independent Test**: Against a fake OpenAI Responses API transport (no network, no real key), `OpenAIAgentRuntime` executes multi-turn tool calls (`Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash`), enforces `DefaultToolPolicy` and `ApprovalHandler`, redacts prompts/tool results/outputs, validates structured output with zod, and records phase spend in the cost ledger.

**Acceptance Scenarios**:

1. **Given** `OPENAI_API_KEY` is set and no Anthropic credentials are set, **When** the user runs `opscrew analyze` or `opscrew adapt`, **Then** OpsCrew selects `OpenAIAgentRuntime`, uses `gpt-5-mini` for `analyze` and `gpt-5` for `adapt` (unless `--model` or `OPSCREW_MODEL` overrides it), and completes the phase with validated structured output.
2. **Given** both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set, **When** `OPSCREW_RUNTIME` is unset, **Then** OpsCrew selects `ClaudeAgentRuntime`. **When** `OPSCREW_RUNTIME=openai`, **Then** OpsCrew selects `OpenAIAgentRuntime`.
3. **Given** `--no-ai` is passed, **When** `OPENAI_API_KEY` is set (even with `OPSCREW_RUNTIME=openai`), **Then** no runtime is created and the command runs deterministically with zero model spend.
4. **Given** `OPENAI_BASE_URL` is set (for example `https://openrouter.ai/api/v1`), **When** `OpenAIAgentRuntime` runs a phase, **Then** requests go to that base URL statelessly (`store: false`, full input history).
5. **Given** `OPENAI_API_KEY` is missing or blank, **When** `isConfigured()` is called (or the API rejects the key with 401/403), **Then** OpsCrew returns a plain-English error and hint telling the user to set `OPENAI_API_KEY` (and never prints the key).

---

### User Story 2 - Identical safety boundary, approvals, and redaction (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a phase with profile `none`, **When** `runPhase` sends a request, **Then** zero tools are offered to the model, and any unexpected tool call is denied and audited.
2. **Given** a phase with profile `read-only` (Analyst), **When** the model calls `Write`, `Edit`, `Bash`, or tries to `Read` `.env` or a file outside `projectRoot`, **Then** `DefaultToolPolicy` denies it before execution, appends a `tool-denied` audit entry, emits a `tool-denied` event, and never executes the tool.
3. **Given** a phase with profile `edit-repo` (Code-change), **When** `DefaultToolPolicy` returns `ask` (e.g. a non-allow-listed `Bash` command or editing `.github/workflows/...`), **Then** the runtime asks `approvals.request(...)` (showing redacted content for GitHub Actions files). On denial or without an approval handler, the tool does not run and a `tool-denied` audit entry is recorded.
4. **Given** a file or command output contains a secret registered with the redactor, **When** a tool returns it, **Then** the output is redacted before being sent back to OpenAI and before appearing in events, logs, or final text.
5. **Given** a `Bash` command runs under `OpenAIAgentRuntime`, **Then** its subprocess environment is passed through `sanitizeAgentEnv(env)`, so `OPENAI_API_KEY` and all cloud/provider secrets are absent from the child environment.

---

### User Story 3 - Structured output, stop reasons, budget, and cost ledger (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a `PhaseRequest` with `output` schema, **When** the model returns valid JSON matching the schema, **Then** `PhaseResult.ok` is `true`, `stopReason` is `"completed"`, and `output` is the zod-parsed value. **When** the output fails zod validation, **Then** `ok` is `false`, `stopReason` is `"invalid_output"`, and `error` describes the mismatch cleanly.
2. **Given** `maxTurns` is reached while the model is still requesting tools, **Then** `stopReason` is `"max_turns"` with a plain-English error.
3. **Given** `maxBudgetUsd` is exceeded during the loop, **Then** the loop stops immediately with `stopReason: "budget_exceeded"` and records accumulated `costUsd`.
4. **Given** the model refuses the request, **Then** `stopReason` is `"refused"`.
5. **Given** `request.signal` is aborted before or during the run, **Then** the run stops with `stopReason: "aborted"`.
6. **Given** any completed or stopped phase, **Then** `costUsd` is computed from `usage` (honouring cached input tokens and dated list prices, or gateway-provided `usage.cost`), recorded in `costLedger` when supplied, and audited as a `phase` event.

---

### User Story 4 - `opscrew init` and user guide cover OpenAI (Priority: P2)

**Acceptance Scenarios**:

1. **Given** `OPENAI_API_KEY` is set (and no Anthropic key), **When** the user runs `opscrew init`, **Then** the model credential check passes. When neither is set, the hint mentions both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.
2. **Given** a user reads the guide, **Then** `docs/guide/ai-models.md` (linked from `docs/guide/index.md`) and `README.md` explain Anthropic, OpenAI (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPSCREW_RUNTIME=openai`), `--model` / `OPSCREW_MODEL`, `--no-ai`, and cost tracking.

## Functional Requirements

- **FR-001**: New workspace package `packages/runtime-openai` (`@opscrew/runtime-openai`) implementing `AgentRuntime` (`id = "openai-responses"`) using the official `openai` package (`responses.create`, `store: false`).
- **FR-002**: Local implementations of `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash` gated by `ToolPolicy` + `ApprovalHandler`, bounded to `projectRoot`, skipping secret paths and escaping symlinks, and redacting all tool outputs.
- **FR-003**: Dated OpenAI price table (2026-11-25) computing `costUsd` from `usage` (`input_tokens`, `cached_tokens`, `output_tokens`) and respecting `maxBudgetUsd`.
- **FR-004**: Full `PhaseStopReason` mapping (`completed`, `max_turns`, `budget_exceeded`, `refused`, `invalid_output`, `aborted`, `error`) and zod validation for `PhaseRequest.output`.
- **FR-005**: Optional `defaultModelFor?(phase: PhaseName): string` on `AgentRuntime` (`packages/contracts/src/runtime.ts`), used by `analyze` and `adapt` so each runtime supplies its own default models while `--model` and `OPSCREW_MODEL` override.
- **FR-006**: CLI runtime selection in `packages/cli/src/deps.ts` (`ANTHROPIC_*` default, `OPENAI_API_KEY` when Anthropic absent, `OPSCREW_RUNTIME=openai` override, `OPENAI_BASE_URL` forwarded, `--no-ai` disables both) and `opscrew init` model check update.
- **FR-007**: User documentation in `docs/guide/ai-models.md`, `docs/guide/index.md`, and `README.md`.

# AI models: Anthropic, OpenAI and compatible gateways

Most of OpsCrew is deterministic code and needs no model at all (`scan`, `interview`, `design`,
`provision`, `verify`, `secure`, `status`, `logs`, `rollback`, `snapshot`, `rotate`, `destroy`).
Two phases can optionally use a language model:

- **`opscrew analyze`** — the read-only **Analyst** reads your source code to refine the
  plain-English summary, risks and detected settings (`port`, start command, health endpoint).
- **`opscrew adapt`** — the **Code-change** agent makes small edits OpsCrew's deterministic rules
  do not handle on their own (such as adding a health endpoint for frameworks without a built-in
  edit).

Pass `--no-ai` to either command to skip the model completely with zero spend.

## Anthropic (Claude)

Set `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

You can also route Claude through Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`), Google Vertex AI
(`CLAUDE_CODE_USE_VERTEX=1`), Microsoft Foundry (`CLAUDE_CODE_USE_FOUNDRY=1`), or an
Anthropic-compatible gateway via `ANTHROPIC_BASE_URL`.

Default Claude models: `claude-haiku-5-5` for `analyze` and `claude-opus-5-5` for `adapt`.

## OpenAI

Set `OPENAI_API_KEY`:

```bash
export OPENAI_API_KEY=sk-...
```

OpsCrew uses OpenAI's Responses API (`store: false`, so repository contents are not persisted on
OpenAI's servers). Default OpenAI models:

- `gpt-5-mini` for `analyze` (read-only Analyst);
- `gpt-5` for `adapt` (Code-change agent).

### OpenRouter and other OpenAI-compatible gateways

Point `OPENAI_BASE_URL` at any gateway that supports the OpenAI Responses API (`/responses`), and
pick the model with `OPSCREW_MODEL` or `--model`:

```bash
export OPENAI_API_KEY=sk-or-...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export OPSCREW_MODEL=openai/gpt-5-mini
```

## Choosing between Anthropic and OpenAI

- **Only Anthropic credentials set:** OpsCrew uses Claude.
- **Only `OPENAI_API_KEY` set:** OpsCrew uses OpenAI.
- **Both set:** OpsCrew uses Claude by default. Set `OPSCREW_RUNTIME=openai` to pick OpenAI
  instead (or `OPSCREW_RUNTIME=claude` to pick Claude explicitly).
- **`--no-ai`:** disables both runtimes for that command, even when keys or `OPSCREW_RUNTIME` are
  set.

## Picking a model

Pass `--model <id>` on `opscrew analyze` or `opscrew adapt`, or set `OPSCREW_MODEL=<id>` in your
environment. `--model` takes precedence over `OPSCREW_MODEL`.

## Safety and spend

Both runtimes enforce the exact same boundary:

- Every tool call (`Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash`) passes through OpsCrew's tool
  policy and stays inside your project root. Secret files (`.env`, private keys, credentials) are
  denied, and actions that need confirmation ask for your approval first.
- All prompts, tool outputs, logs and audit lines pass through OpsCrew's redactor before leaving
  your machine. Child shell commands run with a sanitized environment that excludes `OPENAI_API_KEY`
  and all cloud credentials.
- Every phase's estimated spend is recorded in `.opscrew/costs.jsonl` and capped by the phase's
  budget limit.

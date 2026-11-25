# Tasks: Change an app's values without a full provision

**Input**: [spec.md](spec.md), [plan.md](plan.md).

One agent builds them in order, test first. Secret-shaped values in tests come from `fakeSecret`.

- [ ] T4801 [US1] The record of the app's values in OpsCrew's home
  - **Owns:** `packages/agents/src/values/record.ts` (new) and its test,
    `packages/agents/src/shared/app-env.ts`, `packages/agents/src/shared/app-secrets.ts`,
    `packages/agents/src/provision/secrets.ts`, `packages/agents/src/secrets/files.ts`,
    `packages/cli/src/ui/env-prompt.ts` (the keep choice), the
    one-line hooks in `packages/agents/src/rotate/server.ts`, `packages/agents/src/move/app-env.ts`
    and `packages/agents/src/cloudflare-move/finish-point.ts`, and their tests;
    `packages/agents/src/provision/storage.test.ts` (its leak scan leaves out the test's home).
  - **Reads:** plan.md 1.–3., `assembleAppEnv`, `buildAppEnvironment`, `registerAppSecrets`.
  - **Accept:**
    - `buildAppEnvironment` writes `app_values.json` (0600) with the assembled `app` and `build`
      values; the recovery copy lists it and registers its values with the redactor.
    - `assembleAppEnv`'s `kept` values: a terminal's question offers to keep one
      (`keptValueAvailable`, answer `{ keep: true }`, the CLI's prompt's first choice); a script
      takes one its values file lacks (the file wins).
    - `readDotenvLine` reads every form `dotenvLine` writes (plain, single-quoted, double-quoted
      with `\\`, `\"`, `\n`, `$$`) back to the value; `recordAppEnvText` replaces the record's
      `app` with a text's values, and does nothing without a record.
    - The three other writers of `OPSCREW_APP_ENV` call it with the text they store.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - **Effort:** high

- [ ] T4802 [US1] [US2] [US3] Setting, removing and listing the values
  - **Owns:** `packages/agents/src/values/**`, the export lines in `packages/agents/src/index.ts`.
  - **Reads:** plan.md, `setSecretAt`, `deploySecretPlace`, `deploySecretNamesFor`,
    `rotate/app-site.ts`, `shared/deploy-run.ts`.
  - **Accept:**
    - `checkValueChange` refuses, before any change: other targets (naming provision), no record,
      generated/derived/service-filled names, new build or site names, promoted build values and
      `--redeploy`, moves and unfinished rotations, `--plain` on a declared name, an unset of a
      name that has no value and isn't declared, a multi-line build value.
    - `changeAppValues` asks one `github-secrets` approval listing the secrets and the variables by
      name, then stores only the secrets that changed, writes the record and the plan
      (`app.env` gains or loses names), and with `redeploy` dispatches the workflow on its branch.
      A refusal changes nothing.
    - `appValueRows` lists the plan's variables and the names OpsCrew fills, with secret and source.
    - No value is in the approvals, the audit log, the reporter's output or the plan.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - **Effort:** high

- [ ] T4803 [US1] [US2] [US3] `opscrew values set|unset|list`
  - **Owns:** `packages/cli/src/commands/values.ts` (new) and its test,
    `packages/cli/src/commands/index.ts`, `packages/cli/src/program.test.ts` (the command
    count), `packages/cli/src/deps.ts` (the stdin service).
  - **Accept:**
    - stdin: a terminal's hidden prompt, or the whole piped input (a PEM kept exactly, one line
      without its line end); `--from-file`; `NAME=value` refused without echo; values registered
      with the redactor when read.
    - The plan and the recovery copy are proposed in the deploy pull request.
    - `values list` prints a table of names, secret and source.
  - **Verify:** `pnpm turbo run typecheck test --filter=opscrew`
  - **Effort:** high

- [ ] T4804 [US1] [US2] The guide
  - **Owns:** `docs/guide/environments.md`, `docs/guide/secrets-recovery.md` (what the copy
    holds), the README's "After the first deploy" list.
  - **Accept:** a section on changing an app value: the commands, stdin and files, what changes,
    `--redeploy`, the refused targets and the rotation note.
  - **Verify:** `pnpm exec biome check .`
  - **Effort:** medium

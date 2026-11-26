# Tasks: Change an app's values without a full provision

**Input**: [spec.md](spec.md), [plan.md](plan.md).

One agent builds them in order, test first. Secret-shaped values in tests come from `fakeSecret`.

- [x] T4801 [US1] The record of the app's values in OpsCrew's home
  - **Owns:** `packages/agents/src/values/record.ts` (new) and its test,
    `packages/agents/src/shared/app-env.ts`, `packages/agents/src/shared/app-secrets.ts`,
    `packages/agents/src/provision/secrets.ts`, `packages/agents/src/secrets/files.ts`,
    `packages/cli/src/ui/env-prompt.ts` (the keep choice), the
    one-line hooks in `packages/agents/src/rotate/server.ts`, `packages/agents/src/move/app-env.ts`
    and `packages/agents/src/cloudflare-move/finish-point.ts`, and their tests.
  - **Reads:** plan.md 1.–3., `assembleAppEnv`, `buildAppEnvironment`, `registerAppSecrets`.
  - **Accept:**
    - `setDeploySecrets` writes `app_values.json` (0600) with the `app` and `build` values once
      GitHub holds the secrets, never with the bucket's key (FR-1318); a refused approval leaves
      the record as it was. The recovery copy lists it and registers its values with the redactor.
    - `assembleAppEnv`'s `kept` values: a terminal's question offers to keep one
      (`keptValueAvailable`, answer `{ keep: true }`, the CLI's prompt's first choice) only when
      the local `.env` has no value for the name; a script takes one its values file lacks (the
      file wins).
    - `readDotenvLine` reads every form `dotenvLine` writes (plain, single-quoted, double-quoted
      with `\\`, `\"`, `\n`, `$$`) back to the value; `recordAppEnvText` replaces the record's
      `app` with a text's values, and does nothing without a record.
    - The three other writers of `OPSCREW_APP_ENV` call it with the text they store.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - **Effort:** high

- [x] T4802 [US1] [US2] [US3] Setting, removing and listing the values
  - **Owns:** `packages/agents/src/values/**`, the export lines in `packages/agents/src/index.ts`.
  - **Reads:** plan.md, `setSecretAt`, `deploySecretPlace`, `deploySecretNamesFor`,
    `rotate/app-site.ts`, `shared/deploy-run.ts`.
  - **Accept:**
    - `checkValueChange` checks names only, before any value is read, and reads the bucket's key
      from provision's own source (it stops without it). It refuses, before any change: other targets (naming provision), no record,
      generated and derived names, names provision fills whatever the plan says, new build or site names, promoted build values, unsets and
      `--redeploy`, moves and unfinished rotations, `--plain` on a declared name, an unset of a
      name that has no value and isn't declared. `changeAppValues` takes its result and refuses a
      multi-line build value.
    - `changeAppValues` asks one `github-secrets` approval listing the secrets and the variables by
      name, then stores only the secrets that changed, writes the record and the plan
      (`app.env` gains or loses names), and with `redeploy` dispatches the workflow on its branch.
      A refusal changes nothing.
    - `appValueRows` lists the plan's variables and the names OpsCrew fills, with secret and source.
    - No value is in the approvals, the audit log, the reporter's output or the plan.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - **Effort:** high

- [x] T4803 [US1] [US2] [US3] `opscrew values set|unset|list`
  - **Owns:** `packages/cli/src/commands/values.ts` (new) and its test,
    `packages/cli/src/commands/index.ts`, `packages/cli/src/program.test.ts` (the command
    count), `packages/cli/src/deps.ts` (the stdin service).
  - **Accept:**
    - stdin: a terminal's hidden prompt, or the whole piped input (a PEM kept exactly, one line
      without its line end); `--from-file` (an empty value refused); `NAME=value` refused without echo for `set` and
      `unset`; the names checked before the prompt; values registered
      with the redactor when read.
    - The plan and the recovery copy are proposed in the deploy pull request.
    - `values list` prints a table of names, secret and source.
  - **Verify:** `pnpm turbo run typecheck test --filter=opscrew`
  - **Effort:** high

- [x] T4804 [US1] [US2] The guide
  - **Owns:** `docs/guide/environments.md`, `docs/guide/secrets-recovery.md` (what the copy
    holds), the README's "After the first deploy" list.
  - **Accept:** a section on changing an app value: the commands, stdin and files, what changes,
    `--redeploy`, the refused targets and the rotation note.
  - **Verify:** `pnpm exec biome check .`
  - **Effort:** medium

## After 0.2.12 (found live on 0.2.12, 2026-11-26)

- [ ] T4890 (lead) A values-only push deploys. `values set` says the next push to the deploy branch
  applies the values, but the deploy workflow's path filter leaves out `opscrew/**` (beyond
  `runtime/compose.yaml` and `edge/`), so merging a pull request that changes only
  `opscrew/environments/<env>/secrets.sops.json` starts no deploy. Add the environment's
  `secrets.sops.json` to the filter (snapshots change for every server workflow), with a test.
- [ ] T4891 (lead) `provision --plan-only` exits 2 after a successful plan, with a closing "Nothing was
  written... add --yes" line; a script reads that as a failure. Decide: exit 0 for a plan shown
  as asked, and keep 2 for a refusal.

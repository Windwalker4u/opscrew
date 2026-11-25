# Implementation Plan: Change an app's values without a full provision

**Branch**: `048-app-values` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

## Summary

`opscrew values set|unset|list` changes an environment's app values in GitHub's secrets, OpsCrew's
home and the recovery copy, without provision's infrastructure, Cloudflare, DNS or host plans.

## Technical Context

- **Language:** TypeScript strict ESM. **New dependencies:** none.
- **Packages touched:** `agents` (a new `src/values/`, provision's secret step, the recovery
  copy's files, the three other writers of the app's env secret), `cli` (`values` command), the
  guide. Not `contracts` or `plan-schema`.
- **Testing:** Vitest with `FakeGitHub`, temp projects and `fakeSecret` values.

## Constitution Check

- **I. Safety gate:** no infrastructure changes. GitHub secrets change only after a
  `github-secrets` approval naming them, as provision's secret step; the plan and the recovery copy
  go through the deploy pull request's `git-push` and `pull-request` approvals.
- **IV. Secrets never leak:** values come only from stdin or a file, are registered with the
  redactor when read, and only names reach approvals, output, the audit log and the plan.
- **VII. Test first:** each task starts with failing tests.
- **X. Simplicity:** no new dependency; the record is one JSON file beside the generated values.

## Decisions

1. **The record of the app's values (the lead's design assumed one; there was none).** Provision
   kept only the generated values on this computer; the user's own came from `.env.<env>` or
   `OPSCREW_APP_ENV_FILE` at each run, and the full app env existed only in GitHub's write-only
   secret and on the server. So `values set` couldn't rebuild `OPSCREW_APP_ENV` without asking for
   every other value. Where the app's settings are the one secret `OPSCREW_APP_ENV` (a server's),
   provision's `buildAppEnvironment` now writes what it assembled,
   `{ app, build }` by name, to `app_values.json` in the project's home (0600), which the recovery
   copy holds. `values set` changes that record and renders the secrets from it with the same
   formatting as provision (sorted `dotenvLine`s; `NAME=value` build lines, split by the plan's
   `secret`).
   - **Only there:** a site's values are one secret each, so `values set` needs no record, and
     elsewhere `values` refuses; the user's own values stay off this computer as before.
   - **The bucket's key** is among the app's values, so it is in the record and the recovery copy
     too (the lead may prefer to leave it out and ask for the key again).
   - **Why not recompute with `assembleAppEnv`:** it needs the bucket's key and endpoint (a
     Contabo API call, R2's account) and the server's address, which a values change shouldn't
     need. **Why not read `app.env` over SSH, as rotate does:** the build values aren't on the
     server, and a values change shouldn't need the server up.
2. **Keeping the record true.** Three flows rewrite `OPSCREW_APP_ENV` from the server's `app.env`
   besides provision: a rotation of services or app secrets on a server, a service's move between
   servers, and a Cloudflare move's bucket keys. Each now also writes that text into the record
   (`recordAppEnvText`, which reads OpsCrew's own `dotenvLine` format back). Without it a later
   `values set` would put back an old database password or address.
3. **Provision reuses the record.** A variable provision reads from `OPSCREW_APP_ENV_FILE` takes
   the recorded value when the file has none (the file wins), and a terminal offers to keep the
   recorded value first (still asking, so a value stays changeable on every target). Otherwise a
   name added with `values set` could be skipped by mistake, or stop a script.
4. **What it refuses:** a target whose values don't live in GitHub (Portainer, hosting accounts,
   this computer, preview environments); an environment with no record; a new build-time name or a
   new name of a site (the Dockerfile's `ARG` and the site's workflow name each variable, so only
   provision renders them); a build value or `--redeploy` in a promoted environment; a move or an
   unfinished rotation; `--plain` on a declared name.
5. **Redeploy** dispatches the deploy workflow with no inputs on its branch (`workflowBranch`),
   audited, and prints the run's link without following it.
6. **Stdin:** the CLI reads a TTY with a hidden prompt (`prompts.password`) and anything else as
   the whole input; injected through `CliServices.values.stdin` for tests.

## Known limit

A server rotation reads `app.env` from the server. After `values set` without `--redeploy`, the
server still has the old values until a deploy, so a rotation before that deploy would store the
server's (old) values again. The guide says to redeploy before rotating.

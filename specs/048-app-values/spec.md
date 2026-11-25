# Feature Specification: Change an app's values without a full provision

**Feature Branch**: `048-app-values`

**Created**: 2026-11-25

**Status**: Draft (in 0.2.12, the founder's decision of 2026-11-25; the design is the lead's of
2026-11-25)

**Input**: `specs/roadmap.md`, 048. Adding or changing one app value for an environment today
needs `opscrew provision`, which reapplies the Cloudflare, DNS and host plans just to store a value.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Set one value (Priority: P1)

A user's app on a server needs a new API key in staging. They run
`npx opscrew values set --env staging STRIPE_SECRET_KEY` and paste the key at a hidden prompt, or
pipe it (`< key.pem`). OpsCrew shows the names it stores, asks, stores the value in the GitHub
secret that carries staging's app values, in OpsCrew's home and in the recovery copy, and adds the
name to `opscrew/plan.yaml` when the plan doesn't have it yet. No infrastructure, Cloudflare, DNS
or host plan runs. With `--redeploy` it starts staging's deploy workflow; without it, it says the
next deploy applies the value.

**Why this priority**: it is the feature.

**Independent Test**: on a provisioned server environment with GitHub faked, `values set` with a
secret-shaped fake value updates `OPSCREW_STAGING_APP_ENV`, the record in OpsCrew's home and the
plan, and the value appears in no output, error, audit entry, approval or plan.

**Acceptance Scenarios**:

1. **Given** a provisioned server environment, **When** the user sets a declared value from
   stdin, **Then** the app's env secret holds every other value unchanged and the new one.
2. **Given** a multi-line PEM on stdin, **When** it is set, **Then** the app receives it exactly.
3. **Given** `values set NAME=value`, **When** it runs, **Then** it is refused before anything,
   saying to use stdin or `--from-file`, and the value is not echoed.
4. **Given** a name the plan doesn't declare, **When** it is set, **Then** the plan gains it as
   `source: user`, secret (plain with `--plain`), and the change is proposed in a pull request.
5. **Given** a `generated` or `derived` name, **When** it is set, **Then** it is refused with why.

### User Story 2 - Several values, removal and the list (Priority: P2)

`values set --from-file staging.env` sets every value of a dotenv file at once.
`values unset NAME…` removes values (and their names from the plan). `values list --env staging`
shows each name, whether it is secret and where it comes from (generated, user, derived), never a
value.

**Acceptance Scenarios**:

1. **Given** a dotenv file with a quoted multi-line value, **When** it is set, **Then** each value
   is stored, and none is shown.
2. **Given** `values unset NAME`, **When** approved, **Then** the app's env secret no longer holds
   NAME and the plan no longer lists it.
3. **Given** `values list`, **Then** it prints names, secret yes/no and the source, and nothing
   else.

### User Story 3 - Targets where values don't live in GitHub (Priority: P3)

On Portainer, a hosting account, this computer, or a preview environment the app's values live
elsewhere; `values set` and `values unset` refuse with a plain message naming `opscrew provision`.

### Edge Cases

- An environment provisioned before this version, or on another computer, has no record of its
  values on this computer: refused, naming `opscrew provision` (or `opscrew secrets restore`).
- A new build-time value (a `buildArg` or a public prefix such as `NEXT_PUBLIC_`), or a new value of
  a site on Cloudflare or GitHub Pages, needs files only provision renders (the Dockerfile's
  `ARG`, the site's workflow): refused, naming provision. Changing a declared one works.
- A build value of a promoted environment, and `--redeploy` there: refused (it deploys an image
  built elsewhere; `opscrew promote` deploys it).
- A move or an unfinished rotation in progress: refused, naming the command that finishes it.
- A multi-line build value: refused, as provision refuses it.

## Requirements *(mandatory)*

- **FR-4801**: `opscrew values set --env <env> [--app <app>] NAME` reads NAME's value from stdin:
  a hidden prompt in a terminal, else the whole input. A single line loses its trailing line end;
  a multi-line value is kept exactly. An empty value is refused.
- **FR-4802**: `--from-file <file>` sets every value of a dotenv file (provision's values-file
  format, `\n` in a double-quoted value for a line end). It doesn't go with names.
- **FR-4803**: an argument holding `=` is refused before anything is read, without echoing it.
- **FR-4804**: `values unset NAME…` removes values; `values list` prints names, secret and source.
- **FR-4805**: no value appears in any output, error, plan, log, audit entry, approval or report.
  Every value is registered with the redactor as soon as it is read.
- **FR-4806**: what changes: only the environment's stored app values: the GitHub secret(s) that
  carry them (`OPSCREW_<ENV>_APP_ENV`, the build values `OPSCREW_<ENV>_BUILD_ENV` or
  `_BUILD_SECRETS`, or a site's `OPSCREW_<ENV>_ENV_<NAME>`), the record in OpsCrew's home
  (`app_values.json`, 0600) and the recovery copy, after a `github-secrets` approval naming the
  secrets and variables (never values), as provision's secret step asks it (`--yes` in scripts).
- **FR-4807**: a name the plan doesn't declare is added to `app.env` (`source: user`, `secret: true`,
  or `false` with `--plain`); an unset name is removed from it. The plan and the recovery copy are
  proposed in the deploy pull request, through the repository-write approvals provision uses.
- **FR-4808**: `generated` and `derived` names (and the ones OpsCrew fills from a running service)
  are refused with why.
- **FR-4809**: `--redeploy` starts the environment's deploy workflow on its branch through the
  GitHub connector and prints the run; without it, the output says the next deploy applies them.
- **FR-4810**: provision records the app's values it assembled in OpsCrew's home. A terminal
  offers to keep a recorded value first; a script takes it when `OPSCREW_APP_ENV_FILE` has none
  (the file still wins). Rotations and moves that rewrite the app's env secret update the record.
- **FR-4811**: no MCP tool: values stay terminal-only.

## Success Criteria *(mandatory)*

- **SC-4801**: one value is changed in one command, with no infrastructure, DNS or host plan.
- **SC-4802**: tests with `fakeSecret` values find none of them in stdout, stderr, the audit log,
  the approvals or the plan.
- **SC-4803**: a PEM set through stdin reaches the app's env secret byte for byte.

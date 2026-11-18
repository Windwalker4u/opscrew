# 029 simplify pass (T2921)

Four read-only reviews of `git diff 0e3e4d0e..HEAD -- packages` (reuse, simplification, efficiency,
altitude), 2026-11-18, deduplicated by the lead into four groups whose files don't overlap. Behaviour
must not change. Every safety check stays: approvals bound to hashes, `allowDestroy` with typed
names, the dead-man switch, no secret or home address in output, the drill's bounds enforced in the
scripts on the target, byte-identical renders where tests pin them. Each group's agent reads the
reviews' cited lines itself; line numbers are as of `a3c010b8`-era main and may have moved.

## G1: the drills' shared core (agents `snapshot/`, `status/drill.ts`, iac-templates `drill/`, `check/check.mjs`, the hosting agent)

1. **A target-neutral drill core** (`agents/src/snapshot/drill-core.ts`): `pickSnapshot(abouts, id,
   where)`, `pickParts(planParts, about, only)`, the version check behind `drillImage` with its
   errors, `ownLogins`, `drillApprovalLines(common)` (memory, health check, the two `.env.preview`
   lines, the logins sentence) that each target extends with its own lines, one
   `typedApprovalRefused(what, reason, command, name, hash)` (drill, Portainer, hosting; the older
   copy in `restore-checks.ts` too), and a per-target capability table (`keep`, `remove`, `only`,
   `allowOtherVersion`) checked once in `drillSnapshot`, each target keeping its own error code
   (Portainer `PHASE_PRECONDITION`, hosting `INVALID_INPUT`). `drill.ts`, `drill-portainer.ts`,
   `drill-hosting.ts` use it; `drillCommandText` everywhere a drill command is printed.
2. **One drill name**: `drillName(app)` in iac-templates `drill/`, used by `drillProject`,
   `drillPlan` and every agents caller that builds `${app}-drill` (confirm phrases, project names):
   `snapshot/drill*.ts`, `provision/own.ts` (that one line only), `provision/portainer-flow.ts`,
   `runners/cloud.ts`, `hosting/provision.ts`, iac-templates `drill/script.ts`.
3. **One record shape**: `DrillRecordSchema` exported from iac-templates `drill/record.ts` with the
   type inferred; `drillRecord` ends in its `safeParse`; Portainer's `drills.json` reuses it; one
   `drillRecordsIn(stdout)` for prefixed log lines (status and the Portainer drill).
4. **Bounds and texts from one place**: export the health bounds (`HEALTH_SECONDS`,
   `RUNNING_SECONDS`, `HEALTH_POLL_SECONDS`) beside `DRILL_LIMIT_SECONDS`; the approval texts and
   `portainer-flow.ts` derive "5 minutes", "60 seconds", "30 minutes" from them; one `slotText`
   (iac-templates, beside `DRILL_SLOT_AFTER_HOURS`) for `snapshot/schedule.ts`, `hosting/plan.ts`,
   `provision/portainer-flow.ts`; `status/drill.ts` uses `drillScheduleHours` instead of
   `PERIOD_MS`; one exported `drillOverdue({ now, since, every })` in `check.mjs` used by status
   (regenerate `src/generated/check.ts`); `DRILLS_LOG` in `runners/cloud.ts`; a constant for the
   hosting account's `state/drills.log`; one `scheduledDrillParts(plan)` in iac-templates for
   `drill/script.ts` and `provision/drills.ts`; one `drillEnvFor(deps, drillPlan)` replacing the
   copies in `provision/drills.ts` and `snapshot/drill.ts`.
5. **One words table per target**: `DRILL_TARGET_WORDS` in `snapshot/drill-report.ts` (proves,
   where logged, copy not removed, failed hint, not-restored) read by status and the report;
   `NOT_LOADED` and `notRestored` merged; `NO_OPTION.keep/remove` one constant.
6. **Shell**: one watchdog lines helper for `drill/script.ts` and `portainer-target/snapshots.ts`.
7. **Dead code**: `drillStatusReport` returns `string[]` (`.drill` unread); drop `drillInPortainer`'s
   unused `_services`; hosting reads `run.services`; derive `DrillPlanned.id`, the `args` array,
   Portainer `Planned.hash`/`name` and `environmentId` instead of carrying them; parse
   `compose.yaml` once; un-export `DRILL_STACK_SUFFIX` and `hostingDrillSummary` if unused
   outside; `isDrillStack`/`isDrillVolume` in connector-portainer `drill.ts` for the predicates
   written three times each.
8. **Efficiency**: a server drill in 2 SSH sessions (fold `imageHere` into the probe; the approval
   write, the drill and the failure cleanup in one command with the same stdin); the Portainer
   drill reuses the listing's `about.json` text (no second one-off container) and runs
   `listStacks`/`listVolumes` together; the hosting agent decompresses a dump twice, not three times
   (the count pass under `pipefail` is the integrity test); `mysql_socket` runs lazily, not every
   minute; hosting status reads the log and the dumps listing together; one hosting plan build
   lists the panel's databases once.

## G2: home hosting's shared core (agents `home/`, `status/home.ts`, `verify/`, `secure/`, `drift/host.ts`, `provision/own.ts` home parts, `design/home.ts`, ssh-host `facts.ts` `dns-updater.ts` `index.ts`, iac-templates `tunnel/` `infra/` `runbook/own.ts`)

1. **One home read**: `readHomeServer(deps, { phase, services, detail, network? })` in `home/`,
   returning `{ facts, network? } | { away } | { unread }`, with one `AWAY_FROM_HOME` text, used by
   status, verify and secure. "Away" is a failure of the connection step only (as status and verify
   classify today); an inspection's failure is "unread" (secure today also calls it away: that is
   the one intended change, say so in the commit). No new error code.
2. **One network read**: `readHomeNetwork(deps, session, { phase, host, proxied })` in
   `home/network.ts` (detect, the "detect home network (read-only)" audit entry,
   `registerHomeAddresses`) for provision, drift, verify and design; one "SSH sources unknown"
   refusal. `OwnHomeRun.network` optional; `desiredHost`/`homeHost` take `Pick<OwnHomeRun, "sshFrom"
   | "updater">`; drift no longer reads the network (it registers addresses from the updater's
   state, as status does). `desiredHost`'s `home` a required parameter (`OwnHomeRun | undefined`),
   removing its run-time guard; `detectHomeNetwork` required on `HostAdapterApi` with the fakes
   given one (`testing/own.ts`, `testing/runner-machine.ts`).
3. **The updater's state, typed where it's written**: the state schema and its error codes in ssh-host
   `dns-updater.ts`, `facts.ts` validating `dnsUpdaters[].state`, both agents schemas and code lists
   removed, one words table for the codes (status and verify); export the updater's paths and
   `dnsUpdaterTimer` from ssh-host's root and use them in `drift/host.ts`, `verify/home.ts`.
4. **Home predicates and texts from one place** (iac-templates `tunnel/index.ts` beside `homeMode`):
   `ownAccessMode(target)` hoisted there and used where code picks among tunnel/home/public;
   `homeIpv4(plan)`; `addressUpdaterName(plan)` replacing the private copies (`cloudflare-move/home.ts`,
   `destroy/home.ts`, `init/checks.ts`, `rotate/inventory.ts`, `cloudflare-move/finish-removal.ts`,
   `provision/credentials.ts`, `provision/own.ts`); one `homeRouterLines`/`homeForwardsInput` in
   `home/forwards.ts` with the "AAAA published" rule (design, provision, verify); one token-reach
   text (`home/texts.ts` `updaterTokenReach`; drop `token.ts`'s `reachText`; the runbook and
   ssh-host's step text quote the same words, with an agents test asserting equality as for the
   runbook's updater names); `CLOUDFLARE_TOKEN_PAGE` and `UPDATER_TOKEN_VAR` instead of literals;
   `formatUtc` instead of `verify/home.ts`'s `utc()`; `HOME_ADDRESS_LABEL` in `status/home.ts`;
   one pi-power check (`verify/home.ts`'s), used by secure; design's summary words the recipe's
   last line for a first run ("then run `opscrew provision`", not "again").
5. **Verify's checks**: one local result builder per check (`checkResult` with the same id, title and
   severity 16 times), the away skips produced by the checks themselves.
6. **`dnsModule`** (`infra/cloudflare.ts`) takes an optional `ipv4Record`, so `infra/own.ts`'s
   `HOME_DNS_MODULE` stops repeating its arguments; one `DNS_STATE_RENAMES` list there (the
   one-time `a` → `a[0]`), consumed by `retarget/plans.ts` and `rotate/infra.ts` instead of the
   sideways import.
7. **Efficiency**: verify reads its three facts and the network in one SSH session (a section subset,
   no `hops`); verify starts the outside check before its local checks and awaits it in
   `homeChecks`; the updater token check runs its 11 probes together and takes OpsCrew's own token
   id from the earlier verify; secure runs its three probe groups together; the updater script uses
   about 6 `jq` processes a run instead of about 20 (one pass over the list; URLs built in shell
   from checked values).

## G3: ssh-host internals (`steps.ts`, `plan.ts`, `constants.ts`, `inspect.ts`)

1. `ssh-firewall`'s `preApply` uses `NFT_INSTALL` (same bytes).
2. The drills step's shell helpers (`put`, `sums_ok`, `stale_files`) share the preview recipe's,
   one helper parameterised by folder variable and `find` tests.
3. The drills removal branch: one schema, the `data` lines and params chosen once on `login`;
   rendered scripts unchanged.
4. The drill constants (`DRILL_RECIPE`, `DRILL_VALUES`, `drillProject`, the cron tag and line, "3
   hours", "30 minutes", `.drill`, `.snapshots/drills.log`, `.drill-recipe/schedule`) in
   `constants.ts`, the plan text built from them, and an agents test asserting they equal
   iac-templates' (`DRILL_RECIPE_DIR`, `DRILL_VALUES_FILE`, `DRILL_SLOT_AFTER_HOURS`,
   `DRILL_LIMIT_SECONDS`, `DRILL_DIR`, `DRILLS_LOG`, `DRILL_RECIPE_SCHEDULE`, `drillProject`; G1 adds `drillName` beside it).
5. Inspection: the power fallback (`journalctl -k`) only when `/proc/device-tree/model` exists; one
   `docker info --format` call for swarm, firewall backend and root dir instead of three.

## G4: the database check, tests, live helpers

1. Advise's database check in one `psql` session per service (markers between the queries,
   `ON_ERROR_STOP`, `\gset`/`\if` for the statements query), the first failure still stopping the
   check where it does now.
2. A `tempDir(prefix)` in `@opscrew/core/testing` that creates the folder and removes it after the
   test with retries, ignoring EBUSY (the global teardown sweeps it); the tests 029 touched use it
   (mcp-server, cli).
3. The live helpers: `HomePass.drill`/`removeDrill` (`home-support.ts`) use `approvedDrill`
   (`snapshots-checks.ts`); the move pass's `Leg` doesn't record a leg refused before it opens
   (as `home-support.ts` already does).

## Skipped

- **`sshTableSources` exported from ssh-host** (one parser of the SSH table in two packages): the two
  copies differ in trimming; deciding which the facts need is more than a cleanup, and it would
  cross G2 and G3.
- **The SSH table's owner on a machine that is both a runner host and an app server**: a design
  change (who owns the table), not a cleanup; recorded under "Later" if it is ever seen.
- **A home server as an `access` schema value**: the derived `ownAccessMode` (G2 4.) gives the
  single branch point without a schema change.

# Implementation Plan: Apps from several repositories on a server OpsCrew created

**Branch**: `030-shared-server` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

**Status**: the lead's plan (2026-11-19). The decisions are research R5. Words: the **first app**
owns the server in its infrastructure state; a **second app** runs beside it (spec).

## Summary

A second app is an `own` target that names the first app (`target.shares`). Everything an own
server's app does (records, claims, the memory check, host plans approved by hash, the shared
edge, teardown of one app's parts) is reused. Six things are new:

1. **The first app is read from its repository folder on this computer** (R5.2). The second
   app's local `.opscrew/server.json` keeps the reference. From it OpsCrew takes the first app's
   plan, its server's addresses, its pinned host key, and its deploy login (`deploy` with its
   deploy key). Only the public host key is copied.
2. **The host adapter gets a "second app" mode** (R5.3–R5.5):
   - the `deploy` login with root through Docker is accepted;
   - the shared root steps are never planned;
   - the deploy-key step adds and removes only the app's own line;
   - the record names the first app;
   - teardown never counts the app as the last one.
3. **Bootstrap, then its own key.** The first host plan logs in with the first app's deploy key.
   Once it has installed the second app's key, every later command logs in with the second app's
   own key (`own.joined`).
4. **Design checks the match** (R5.7): the name, the hostnames, the way of serving, the proxy,
   and the memory, counting the first app's limits from its plan and the other second apps' from
   their records. It also states the shared-access warning (R5.8).
5. **The first app's commands look before they harm** (R5.6). One check inspects the server
   through the first app's deploy login and lists the records, and the harmful commands refuse
   while one is there.
6. **CLI, MCP and the guide** carry the new answers and the `--skip-other-apps-check` flag.

## Technical Context

- **Language**: TypeScript strict ESM (Node 22.9+), as every package.
- **Packages touched**: `plan-schema` (the target), `connectors/ssh-host` (the mode),
  `agents` (the reference, interview, design, provision, the guest's commands, the first app's
  guards), `cli`, `mcp-server`, `docs/guide`.
- **No new dependency.** No new contract in `packages/contracts`. The ssh-host input and record
  schemas are ssh-host's own (types.ts, facts.ts).
- **Testing**: Vitest, colocated. The scripted remote and `FakeHostServer` stand in for servers,
  and the fakes for Cloudflare and GitHub stand in for those. The engines come from `.tools/bin`
  where a test runs `init`. No network.
- **Constraints**: no change to cloud-init, the provider modules or the deploy workflow's
  templates (a second app deploys as an own-server app does). No record is ever written for the
  first app.

## Constitution Check

- **I. Safety gate**: every change is a plan approved by its hash. That covers the second app's
  Cloudflare plan, its DNS-only infrastructure plan, and its host plan (the ssh-host adapter, as
  for own servers). The bootstrap login changes nothing on its own: it only applies the approved
  host plan. Destroy keeps `allowDestroy` and the typed name. The first app's guards refuse
  before any plan is made. `--skip-other-apps-check` lifts only the look at the server, never an
  approval or a typed confirmation. **PASS.**
- **II. User owns everything**: the second app's files are as for any own-server app. The local
  reference is in `.opscrew/` (gitignored). **PASS.**
- **III. Dual engine**: the infrastructure plan is the own-server DNS root, run unchanged with
  both engines. **PASS.**
- **IV. Secrets**: the first app's deploy key is read by path at apply, never copied, never sent
  to GitHub (FR-3019). The server's addresses stay in `.opscrew/server.json`, as for own servers.
  Every agents task's tests end with a leak check over everything the fakes saw. **PASS.**
- **IX. Honest UX**: the shared-access warning (FR-3004) is said in design and in the host plan's
  approval, and the guide repeats it. **PASS.**
- **X. Simplicity**: no new provider kind, no new contract and no new server-side program. A
  second app is an own-server app with three differences. **PASS.**

No amendment: Principle I already names "OpsCrew's host adapter" for changes to a server the
user owns, and a server OpsCrew created for the user is the user's (previews and add-ons already
apply host plans to it, ADR 0026 R7).

## Project Structure

### Documentation (this feature)

```text
specs/030-shared-created-server/
├── research.md   # R1–R6
├── spec.md       # US1–US5, FR-3001–FR-3020, SC-3001–SC-3006
├── plan.md       # this file; the live passes are its section 15
└── tasks.md
docs/adr/0035-shared-created-server.md
docs/guide/shared-server.md        # new page
```

### Source code (what changes)

```text
packages/plan-schema/src/plan.ts                 # OwnTargetSchema.shares (1.)
packages/connectors/ssh-host/src/
  types.ts                                       # DesiredHost.shares (2.)
  facts.ts                                       # AppRecord.shares, .repository (2.)
  plan.ts, steps.ts, findings.ts, apply.ts, inspect.ts   # the second-app mode (2.–4.)
packages/agents/src/
  shares/                                        # new: the reference, the first app, the guards (5., 9.)
  shared/server-record.ts                        # own.shares, own.joined (5.)
  interview/own-server.ts, interview/run.ts      # the answers (6.)
  design/own.ts, design/run.ts, design/own-servers.ts   # the match (7.)
  provision/own.ts                               # bootstrap and the second app's plans (8.)
  destroy/own.ts, secure/*, snapshot/server.ts, addons/run.ts, portainer/run.ts   # (8.)
  destroy/run.ts, retarget/*, provision/run.ts, secure/public-ssh.ts, vpn/*, drift/*, status/*, advise/*   # the first app's guards (9.)
  environments/add.ts                            # a second app's environment (10.)
packages/cli/src/**, packages/mcp-server/src/**  # flags and inputs (11.)
```

## Design

### 1. The target (T3001)

`OwnTargetSchema` gains an optional key:

```ts
/** The server is one OpsCrew created for another app, which this app shares (030). */
shares: z.strictObject({
  /** The first app's name on the server (its plan's `app.name`). */
  app: AppNameSchema,
  /** Where OpsCrew created that server. */
  provider: CloudProviderSchema,
}).optional(),
```

A refinement rejects `shares` together with `access: "tunnel"` or `home`, saying a server OpsCrew
created is reached at its public address. Nothing else in the plan changes. `dns.proxied` says
how the app is served, and `target.edge` names the proxy, as for every own server.

### 2. The host adapter's input and record (T3002)

`DesiredHost` gains:

```ts
/** A second app on a server OpsCrew created for `host.app` (030). */
shares: z.strictObject({
  /** The first app as its plan describes it: never written to the server. */
  host: z.strictObject({
    app: AppNameSchema,
    hostnames: z.array(HostnameSchema).max(50),
    /** How the first app is served: behind Cloudflare's proxy (the cloud firewall lets only
     *  Cloudflare in) or DNS only. */
    access: z.enum(["web-filter", "public"]),
    memoryMb: z.number().int().positive().max(1_048_576),
  }),
}).optional(),
```

`AppRecordSchema` gains `shares: { app }` (the first app's name) and `repository` (the project's
repository URL, not secret), both optional and written only in this mode. The first app's
refusals name them.

### 3. `planHost` in the second-app mode (T3002)

With `desired.shares`:

- **Privilege**: `docker` (the `deploy` login, root through a privileged container in
  `rootImage`) is accepted. `root` and `sudo` are refused: a server OpsCrew created never has
  them, and a login with them means the facts are of another kind of server. `none` and
  `sudo-password` stay fatal.
- **Steps planned**, and nothing else:
  - `deploy-key` in its second-app form (below);
  - `app-dirs`, run as the login (both folders are under `deploy`-owned parents);
  - `app-record`, through root-through-Docker, writing the record only. There is no `host.json`
    and no `/var/lib/opscrew-ready` flag, since cloud-init wrote that;
  - `drills`, and `github-runner` run as the login, when desired.

  `runtime-dirs` is checked, never changed: missing shared folders block the plan with a finding
  saying the server isn't one OpsCrew set up as it does today. Never planned: package-repair,
  docker, docker-daemon, deploy-user, sshd, ufw, ssh-firewall, web-filter, fail2ban, upgrades,
  sysctl, tunnel-connector, portainer and dns-updater. A desired `sysctl` (OpenSearch or
  Elasticsearch) is a blocking finding that names the first app's server setup.
- **`deploy-key`, second-app form**: the step's target list is `authorized_keys` as found, minus
  the app's own earlier key lines (by key id), plus the app's current key (and a rotation's
  previous one). Every other line, whatever it is, stays in its order. The step's script
  rewrites the file to that list under the same lock and checks the result, so a line that
  changed in between makes the step fail without writing. Removal (teardown) is the same with no
  key of the app's.
- **Claims**: `claimFindings` runs over the records found plus the first app's description
  (`shares.host`), as if it were a record. That covers the name, the hostnames, the access mode
  and "no domain beside other apps". The app's own claim `access` is `shares.host.access`; the
  first app has no web filter of its own because its cloud firewall does that job. A name of the
  form `<other>-pr-<n>`, where `<other>` is the first app or a record's app, is refused
  (`inspect.ts` reads such folders as previews).
- **Not checked in this mode**: the web ports already in use (the shared edge holds them),
  `dockerStopped`, which cloud-init's Docker never is, and the home and tunnel claims, which
  never apply.
- `otherApps` pins the records found, as today, so a record that appears between plan and apply
  changes the hash check's outcome (`apply.ts:653-676`).

### 4. Teardown, inspection and apply in this mode (T3002)

- `planTeardown(facts, { …, shares: true })`:
  - the app is never the last one: the edge, the check key and Portainer stay;
  - the deploy-key removal is the second-app form;
  - the record goes (or stays as `data-kept` without `deleteData`), as today;
  - `docker` privilege is accepted, as above.
- `inspectHost` with `rootImage` reads `/etc/opscrew/apps/*.json` as root through Docker. On a
  created server the folder may not exist, which means no records: not an error.
- `applyHostPlan` runs the `app-record` step (the only root step in this mode) and the teardown's
  record removal through the Docker privilege. Every other step runs as the login. A test proves
  that no step of a second-app plan runs as root except those two.

### 5. The reference and the first app (T3003)

`.opscrew/server.json` → `own` gains, for a second app:

```ts
shares: z.strictObject({
  /** The first app's repository folder on this computer (absolute). */
  root: z.string().min(1),
  /** Its app key (absent: its first app) and its environment. */
  app: AppKeySchema.optional(),
  environment: EnvironmentNameSchema.default("prod"),
}).optional(),
/** True once a host plan installed this app's own deploy key on the server. */
joined: z.literal(true).optional(),
```

With `shares`, `user` is `deploy`, `keyPath` is the second app's own deploy key on this computer,
and `reachable`/`serve` are left out. `publicIpv4`/`publicIpv6` are written from the first
app's addresses at each provision.

A new folder, `packages/agents/src/shares/`, has no `index.ts`: callers import files. It holds:

- `reference.ts`: `readShares(paths)` reads the reference from `server.json`, and
  `firstAppPaths(ref)` builds the first app's `ProjectPaths` from its root, app key and
  environment, using the project layout every phase uses.
- `first-app.ts`: `firstApp(deps, ref)` returns the first app's paths, plan, server address,
  deploy login and pinned host key. It refuses (FR-3002, each "Nothing was changed."):
  - no plan or not provisioned on this computer;
  - not a cloud target (`isCloudTarget`);
  - a preview environment, or previews on its server (`sharedPreviewsOn`);
  - public SSH closed, a private network or a VPN;
  - itself a second app (its own server record names a `shares`), which is refused with the
    name of that app's first app.

  `hostDescription(plan)` gives `shares.host` for the host adapter: the name, every hostname
  (`appHostnames`), the access (`dns.proxied` makes it `web-filter`) and `appMemoryMb(plan)`.
- `login.ts`: `secondAppLogin(deps, ref, own)` returns the login a command uses: the first
  app's deploy login until `joined`, the app's own key after. Both connect as `deploy`. The
  first app's pinned host key is the one checked, and it is copied into the second app's
  `known_hosts` under the same address and port.
- `guard.ts`: `otherAppsOnServer(deps, plan)` and `requireNoOtherApps(deps, plan, what, again,
  options)` belong to the first app (9.). `otherAppsMemory(facts)` gives the limits of the
  records found.

### 6. Interview (T3004)

The server question gains the choice **"A server another of your OpsCrew apps runs on (one
OpsCrew created)"**. It asks for:

- `server.shares`: the first app's repository folder, which must exist, with the hint that the
  first app must have been provisioned on this computer;
- `server.shares-app`: its app key, asked only when that repository has several apps;
- `server.shares-env`: its environment, asked only when it has several; prod by default.

The answers map to `provider: own` with `own.shares` in `server.json`. Every other server
question is skipped: address, port, user, key, home, reachable and serve all come from the
first app. Budget and region aren't asked (no server cost). The answers file takes the same
keys. `firstApp` runs at the end of the interview, so a wrong folder stops there.

### 7. Design (T3004)

With `own.shares`, design:

1. calls `firstApp`, then connects with `secondAppLogin` and inspects with `rootImage`;
2. checks the proxy: the second app's `target.edge` (from the plan or its default) must equal
   the first app's `edgeProxy(plan)`, or it stops, naming both;
3. checks the way of serving: when the first app is proxied, the second app's domain must be on
   Cloudflare and proxied, and `dns.proxied` is set true. Otherwise it is DNS only, and `false`;
4. runs the memory check, `ownServerMemory(serverMb, appMb, others, edgeMb)`, with `others` =
   the first app (`hostDescription`) plus `otherAppsMemory(facts)`, and its refusal and 15%
   warning as today;
5. writes `target: { provider: "own", mode: "vps-compose", arch, access: "public", edge, shares:
   { app, provider } }` and builds one option, "beside <first app> on its <provider label>
   server", with no price;
6. prints the shared-access warning (FR-3004) in the summary, with the first app's name;
7. runs the claim checks early, through a dry `planHost` over the facts, so a taken name or
   hostname stops in design, not first in provision.

### 8. The second app's provision and its other commands (T3005)

- **Provision**, the own path with these differences:
  - the infrastructure root is the own DNS root (A/AAAA to the first app's addresses, with no
    tunnel);
  - the host plan is `planHost` with `shares` and the login from `secondAppLogin`;
  - after its apply succeeds with the `deploy-key` step done or in place, `own.joined` is
    recorded;
  - the GitHub secrets are `HOST` (the first app's IPv4), `KNOWN_HOSTS` (the copied pinned key)
    and the app's own deploy key;
  - the approval text repeats the shared-access warning.
- **Destroy** (`destroy/own.ts`): `planTeardown` with `shares: true`, logged in with the app's
  own key. The first app's folder isn't needed. Its DNS and Cloudflare parts go as for an own
  server.
- **Secure**: for a second app, the server's hardening checks (sshd, ufw, Lynis, ssh-audit) are
  skipped with one line saying they are the first app's (`opscrew secure` in its repository).
  The site's checks run.
- **Refused** for a second app, each before any change, naming the first app:
  - a whole-server snapshot or restore (`snapshot/server.ts`);
  - Beszel (`addons/run.ts`) and Portainer (`portainer/run.ts`);
  - previews sharing its server (`previews/host.ts` `hostProblem`);
  - `opscrew secure --close-public-ssh`.
- **Unchanged and covered by tests**: deploys, `verify`, `status`, logs, `drift` of its own parts
  (`app-dirs`, `app-record`, `deploy-key` in its form), snapshots and restores of its data,
  `rotate deploy-key` (the second-app deploy-key form keeps the old key until the new one passed,
  as today).

### 9. The first app's guards (T3006)

`otherAppsOnServer(deps, plan)` is for a cloud target with a deployment. It connects through the
first app's deploy login, inspects with `rootImage`, and returns the readable records, active or
`data-kept`: on a created server every record belongs to a second app. It returns `{ reached:
false, reason }` when SSH fails. It returns `{ reached: true, apps: [] }` without a deployment.

`requireNoOtherApps(deps, plan, what, again, { skip })` refuses with `PHASE_PRECONDITION`,
before any change:

- **When records are found**: "The server also runs "inventory" (from
  github.com/example/inventory), and <what> would <break it / remove it>." The hint says to run
  `opscrew destroy` in that repository first, or `opscrew retarget` there to move it, then
  `<again>` again.
- **When the server can't be reached and `skip` isn't given**: "OpsCrew couldn't look at the
  server for other apps (<reason>), and <what> would break any that run there." The hint is to
  run `<again> --skip-other-apps-check` to go on without looking.
- **With `skip`** (lead, 2026-11-19), OpsCrew still looks:
  - an active record still refuses, since the flag never covers an app that runs there;
  - only data-kept records give a warning that their data will be lost, and the command goes on;
  - when the server can't be reached, a warning, and the command goes on.

  The flag's help: "go on when OpsCrew can't look at the server for other apps, or when only
  their kept data is there".

Call sites, beside each `requireNoSharedPreviews` call where there is one:

| Command | Where | `what` |
|---|---|---|
| `destroy` (cloud) | `destroy/run.ts` before the plan | "destroying the server" |
| `retarget` (start), `--finish` | `retarget/run.ts`, `retarget/finish.ts` | "moving the app off it" |
| provision, when the infrastructure plan replaces or deletes the server | `provision/run.ts` after the plan JSON | "replacing the server" |
| provision, when the infrastructure plan changes the server type | same | a memory check, not a refusal (below) |
| whole-server restore | `snapshot/server.ts` before the rebuild | "restoring the whole server" |
| `secure --close-public-ssh` | `secure/public-ssh.ts` | "closing public SSH" |
| a serving switch, proxied ⇄ DNS only | `provision/run.ts` | "changing which addresses reach the web ports" |
| private network, `vpn add`, `vpn grant` | `provision/run.ts`, `vpn/*` | "putting the server on a private network" |
| Beszel, Portainer | `addons/run.ts`, `portainer/run.ts` | "running <add-on> on the server" |

**Resize**: when the infrastructure plan changes the server type and records are found, the new
type's memory must hold the first app's limits, the records' limits, the edge and the system
reserve. Otherwise provision refuses. When it fits, the plan's summary adds "inventory restarts
with the server". The new type's memory comes from the provider's catalogue, as design reads it.

**drift** (`drift/servers.ts`, `drift/host.ts`): on a created server, key lines of `deploy`
whose key matches a record's `deployKey` (or a check-key line in OpsCrew's form) are not drift,
and record folders and site files aren't either. **status** names the records ("Also on this
server: inventory (github.com/example/inventory)"). **advise** adds `otherAppsMemory` to the
first app's headroom when it inspects the server.

### 10. A second app's environments (T3004)

`opscrew env add <name>` for a second app offers the same server by default, as for every own
server. The new environment gets its own `server.json` `own` with the same `shares` reference,
so it becomes another second app (name `<app>-<env>`, own hostname, own record).
`--target` keeps every other choice.

### 11. CLI and MCP (T3007)

- **interview**: the answers file keys `server.shares`, `server.shares-app` and
  `server.shares-env`. The interactive choice is (6.).
- **design**: `--shares <folder>` (with `--shares-app` and `--shares-env`) sets or replaces the
  reference, for a second computer or a moved folder. It is valid only for a second app, or for
  an `own` app not yet provisioned.
- **`--skip-other-apps-check`**: on `destroy`, `retarget`, `provision`, `restore`, `secure`,
  `addon`, `portainer` and `vpn`, wherever 9. guards. Its help says it lets the command go on
  without looking for other apps on the server.
- **MCP**: the matching tools take `shares`/`sharesApp`/`sharesEnv` (interview, design) and
  `skipOtherAppsCheck` (each guarded tool), as their CLI flags.

### 12. A second app's retarget (T3008)

`retarget` from a second app treats its old side as an own server that is never the last: the
own side's `sharedEdge` is set, so the edge keeps running. The finish removes the old side
through `planTeardown` with `shares: true`. Moving onto a server as a second app is not offered
(retarget's sides are unchanged); a second app moves off only.

### 13. The guide (T3009)

`docs/guide/shared-server.md`: when to share a server, the steps (the first app first, then the
second's interview, design and provision), what each app may do, what is refused and why, the
shared-access warning, `--skip-other-apps-check`, removing a second app and moving it off. It is
linked from `hetzner.md`, `digitalocean.md`, `contabo.md`, `own-server.md` ("Several apps on one
server"), `several-apps.md`, `destroy`/`retarget`/`public-ssh`/`snapshots` pages where they
refuse, and `index.md`.

### 14. Risks

- **The deploy-key rewrite** (R4.1) is the one change that can lock the first app out. The
  second-app form keeps every line it doesn't own, and the live pass checks `authorized_keys`
  line by line before and after (SC-3003).
- **Root through Docker** uses the same privileged container as `planNetwork`. If the image
  isn't on the server it is pulled; the plan says so (as today).
- **A first app provisioned on another computer**: the second app's design and provision stop
  with the hint; nothing guesses.
- **A guard that can't reach the server** stops by default. `--skip-other-apps-check` is the
  user's explicit choice.

### 15. The live passes (T3010, T3011)

**L1, the throwaway pair**, after the 029 lead's OK:

1. A first app in `OPSCREW_E2E_GITHUB_REPO_C` on a throwaway Hetzner CX23, proxied, at
   `j030-first.<zone>`.
2. A second app, `j030b`, a further app of the same repository, at `j030-second.<zone>`, joining
   its server: interview, design, provision, the first deploy. A request every second against
   the first app's site runs throughout.
3. Provision again: no changes. `drift` of both apps: nothing.
4. Each guard of 9. on the first app refuses: destroy, closing public SSH, a serving switch and
   retarget, each with `--plan-only` where it has one.
5. A snapshot and restore of the second app's data.
6. The second app's destroy. Then `authorized_keys` is as before step 2, and the first app
   deploys and its scheduled check passes.
7. The first app's destroy; leftovers checked by the run's labels and ids only.

**L2, the founder's second app beside his first**: the same steps 2, 3 and 4 (the
guards only with `--plan-only` or a refusal, nothing applied to the first app), then the founder
reads the site. No destroy: the app stays. Two checks the second app's own lead asked for:

- the app sees https;
- a request through Cloudflare with a forged `X-Forwarded-For` header reaches the app as the
  visitor's real address. The edge's `trusted_proxies` and `client_ip_headers CF-Connecting-IP`
  and the site's `header_up X-Forwarded-For {client_ip}` should give that.

## Requirements coverage

| Requirement | Design | Task |
|---|---|---|
| FR-3001 | 6., 11. | T3004, T3007 |
| FR-3002 | 5. | T3003 |
| FR-3003 | 3., 7. | T3002, T3004 |
| FR-3004 | 7., 8. | T3004, T3005 |
| FR-3005 | 8. | T3005 |
| FR-3006, FR-3007 | 2., 3. | T3002 |
| FR-3008 | 8. (deploy workflow unchanged) | T3005 |
| FR-3009 | 5., 8. | T3003, T3005 |
| FR-3010 | 4., 8. | T3002, T3005 |
| FR-3011 | 8. | T3005 |
| FR-3012–FR-3016 | 9. | T3006 |
| FR-3017 | 10. | T3004 |
| FR-3018 | 12. | T3008 |
| FR-3019 | 5., 8., Constitution IV | every agents task |
| FR-3020 | 11., 13. | T3007, T3009 |

## Order

- **Wave 1** (parallel): T3001 plan-schema, T3002 ssh-host.
- **Wave 2**: T3003, the shares core (needs both).
- **Wave 3** (parallel): T3004 interview, design and environments; T3005 provision and the
  second app's commands; T3006 the first app's guards.
- **Wave 4** (parallel): T3007 CLI and MCP, T3008 retarget, T3009 the guide.
- **Then**: T3010 live L1, T3011 live L2, T3012 the simplify pass, T3013 roadmap and
  `CLAUDE.md`.

## Complexity Tracking

None: no constitution deviation, no new dependency, no new contract.

# 030 Apps from several repositories on a server OpsCrew created: research

Research for the feature "an app from another repository (or another app of the same one) runs
on a server OpsCrew created for a first app, beside it". Written 2026-11-19 by the lead, from four
read-only passes over the code at `main` 3d0db39c. No outside sources: everything here is
OpsCrew's own code and guides. File references are relative to `packages/` unless they start with
`docs/` or `specs/`.

**Why now** (founder, 2026-11-19): he asked to deploy a second app, from another repository, onto
the Hetzner CX23 that OpsCrew created for his first one, and chose to build this rather than
create a second server. Words used below:

- the **host app**: the app (and environment) whose Terraform/OpenTofu state holds the server;
- a **guest app**: any other app on that server, from another repository or another app key of
  the host's repository, with its own state, deploy key, workflow and approvals.

## R1. What a server OpsCrew created has, and what it lacks

- **One login.** cloud-init creates `deploy` only: `disable_root: true`, `PermitRootLogin no`,
  `AllowUsers deploy`, no sudo (`iac-templates/shared/cloud-init.yaml.tftpl:7-40`). `deploy` is in
  the docker group (`:122`), so it becomes root through a privileged container.
- **The multi-app layout is already there.** cloud-init makes `/srv/edge`, `/srv/apps`,
  `/srv/data` and `/srv/runners`, owned by `deploy` (`:127`). A deploy writes
  `/srv/apps/<app>`, its env files, `/srv/edge/sites/<app>.<caddy|conf|vhconf>` and
  `/srv/edge/tls/<app>/{origin.pem,origin.key,pull.pem}`, then starts the shared `opscrew-edge`
  project under `flock` on `/srv/edge/.lock` (`iac-templates/src/workflow/index.ts:978-990`,
  `iac-templates/src/runtime/switch.ts:843-1045`). It registers the app with kamal-proxy by name
  (`switch.ts:640`).
- **The edge already serves several apps,** each with its own site file, its own Origin CA
  certificate and its own Authenticated Origin Pulls trust pool (`runtime/services.ts:161-184`,
  `edge/nginx.ts:444-447`). A deploy keeps the newer edge version, by the stamp
  `x-opscrew-edge-version` (`edge/index.ts:84-87`, `switch.ts:962-989`), and Compose recreates
  only the containers that changed.
- **There are no app records.** Servers the user owns keep `/etc/opscrew/apps/<app>.json`
  (`connectors/ssh-host/src/facts.ts:17-43`: projectId, state, access, hostnames, folders, Compose
  project, services, `memoryMb`, deployKey), written by the root step `app-record`
  (`steps.ts:2257`). A created server has none, and no `host.json` either (`ssh-host/plan.ts:3495`).
  Nothing on it says which apps it holds, except the folders.
- **The server and its firewall belong to the host's state.** On Hetzner, `hcloud_firewall`
  allows SSH from `ssh_allowed_cidrs` and ports 80/443 from `http_allowed_cidrs`. That is
  Cloudflare's ranges when proxied, everyone with DNS only (`providers/hetzner/module/main.tf:21-46`).
  The rules apply to every site on the server.

## R2. The closest mechanism: previews on another environment's server (022, ADR 0026 R7)

Previews already put a second Compose project on a created server that belongs to another
environment of the same app. What it does, and can lend (`agents/src/previews/host.ts`):

- **Reach without copying.** `previewServer` swaps in the host environment's paths and plan, and
  `hostDeployLogin` / `sharedServerReach` take the host's address, its deploy key and its pinned
  host key from this computer (`host.ts:68-160`). Nothing of the host's is copied into the
  preview environment's state. A missing host state stops with "run it on the computer that
  ran provision".
- **A host plan that runs as `deploy`.** The `previews` step is a host-plan step with
  `runAs: "login"`, approved by hash through `approveAndApplyHostPlan` (`previews/setup.ts:378-425`).
  It appends a restricted key line to `deploy`'s `authorized_keys` (`ssh-host/constants.ts:482-485`).
  `runAsOf` sends only the steps in `LOGIN_STEPS` (portainer, tunnel-connector, github-runner,
  check-key, previews, drills, beszel, alloy) through the login; every other step runs as root
  (`steps.ts:4501-4517`).
- **Guards in the host's commands,** all reading this repository's own plans:
  `requireNoSharedPreviews` refuses destroy (`destroy/run.ts:617`), retarget
  (`retarget/run.ts:151`), closing public SSH (`secure/public-ssh.ts:342`), a switch to the tunnel
  or home (`provision/run.ts:512-523`), a proxy switch (`provision/run.ts:1772-1782`), `env remove`
  (`environments/remove.ts:46`) and design home (`design/home.ts:94`). `requireNoNetworkBesidePreviews`
  refuses a private network (`provision/run.ts:525`, `addons/run.ts:904`, `portainer/run.ts:573`,
  `vpn/*`).
- **Memory.** `sharedPreviewsLimit` adds the previews' limits to the host's sizing
  (`design/sizing.ts:87-95`, `advise/readings.ts:520`).
- **What it refuses:** a host server holding any other app (`requireHostApps`, `host.ts:484`;
  `refuseOtherApps`, `ssh-host/plan.ts:3742`), prod, a tunnel or closed public SSH, a proxy other
  than Caddy, a private network.

**What it can't lend:** its guards read local plans, so they never see an app from another
repository; and its host-plan steps are add-ons, not an app's setup.

## R3. The other half: several apps on a server the user owns (013, ADR 0011)

`provider: own` already holds apps from several repositories on one server
(`docs/guide/own-server.md`, "Several apps on one server"), through the ssh-host connector:

- **Per-app steps:** `deploy-key` (`ssh-host/plan.ts:729`), `app-dirs` (`:1415`), `app-record`
  (`:1443`), plus `check-key`, `drills`, `github-runner`, `dns-updater`, `tunnel-connector`.
  **Shared root steps:** package-repair, docker, docker-daemon, deploy-user, sshd, ufw,
  ssh-firewall, web-filter, fail2ban, upgrades, sysctl, runtime-dirs, portainer
  (`plan.ts:2092-2113`).
- **Pure checks over records:** `otherActiveApps` (`facts.ts:703`), and `claimFindings`
  (`findings.ts:65-117`): name taken by another project, hostname taken, no domain beside other
  apps, differing access mode, home mode, damaged records. Also the memory check
  `ownServerMemory(serverMb, appMb, others, edgeMb)` (`agents/src/design/sizing.ts:219-270`, with
  `SYSTEM_RESERVE_MB = 384` and the 15% warning in `agents/src/shared/memory.ts`).
- **Teardown removes only the app's own parts** (`planTeardown`, `plan.ts:2129-2370`). The edge,
  the check key and Portainer go only with the last app (`last = others.length === 0`, `:2168`).
- **Hash binding pins the other apps:** `applyHostPlan` re-validates the plan, refuses a different
  hash, and compares `plan.otherApps` with the records as they are now (`apply.ts:653-676, 757-800`).
- **Root through Docker exists.** `probePrivilege` returns root, sudo, docker, sudo-password or
  none (`inspect.ts:835`). With `rootImage`, inspection also reads the network state and ufw as
  root through a privileged container (`inspect.ts:1210-1225`), and apply can run root steps the
  same way (`privilege.ts:15, 52`; `apply.ts:754-770`). But `privilegeFindings` makes `docker` fatal
  for every plan except `planNetwork`, `planPublicSsh` and `planGrant` (`findings.ts:25-38`).

## R4. Hazards for a guest on a created server, if own-server code ran unchanged

1. **The deploy-key step rewrites `authorized_keys`** to exactly the keys of the app and of the
   other apps' records (`deployKeyStep`, `plan.ts:719-748`). The host has no record, so its deploy
   key (and any line OpsCrew doesn't recognise) would be removed. The host's deploys would stop.
2. **The guest would be the "last app"** at teardown (no other records), so its destroy would
   remove the shared edge, the check key and Portainer (`plan.ts:2168, 2311-2335`). The host's
   site would go down.
3. **Shared root steps would re-harden the host's server** to own-server standards (sshd file,
   ufw, the Cloudflare-only filter in `DOCKER-USER`), beside cloud-init's settings and outside the
   host's state.
4. **The host's commands can't see the guest** (R2: they read local plans). These would remove
   or cut off a guest:
   - `destroy`, which deletes the server;
   - `retarget --finish`, which deletes the old server; the cloud side doesn't set `sharedEdge`
     (`retarget/sides/ssh.ts:247-275`);
   - a `location` change (a replace) or a whole-server restore (`snapshot/server.ts:616-780`);
   - closing public SSH, switching between proxied and DNS only, and a private network;
   - a resize, which reboots and can leave too little memory; advise counts only the host's own
     containers.
5. **The host's own inspection** treats a foreign folder in `/srv/apps` as another app when it
   sets up previews (`refuseOtherApps`). That is correct and stays. A guest named `<host>-pr-<n>`
   would be misread as a preview (`inspect.ts:398`).

## R5. Decisions (lead, 2026-11-19)

1. **A guest is an `own` target that names its host** (`target.shares: { app, provider }`), not a
   new provider kind. Interview, design, provision, the deploy workflow, drift, status, verify,
   snapshots of the app's data and destroy all have an own-server path that fits once the
   differences below are in place. The guest's address and login are never committed, as for
   every own server (`.opscrew/server.json`). The host's repository folder on this computer is
   local state too.
2. **The host is read from its repository folder on this computer,** as previews read their host
   environment: its plan (name, hostnames, serving mode, edge, memory limits), its server's
   address, its pinned host key and its deploy key. Nothing is copied but the host's public SSH
   host key, which the guest pins. The first contact uses the host's deploy key. Once the guest's
   own deploy key is authorized, the guest logs in with its own key, so its later commands need
   the host's folder only where they compare against the host's plan (design and provision).
3. **On the server, the guest keeps a record** in `/etc/opscrew/apps/<guest>.json`, written
   through root-through-Docker, with a field naming the host. That makes the guest visible to the
   host's commands and to later guests. No record is written for the host: its facts come fresh
   from its plan each time, since a copy on the server would go stale.
4. **The guest's host plan holds only its own steps:**
   - `deploy-key` in a guest form that adds or removes only the guest's own line and keeps every
     other line;
   - `app-dirs` as `deploy`;
   - `app-record` through Docker;
   - `check-key`, `drills` and `github-runner` as configured.

   The shared root steps are marked as the host's and never planned. Docker privilege is accepted
   for these plans only. A guest that needs a shared root change (the `vm.max_map_count` setting
   for OpenSearch or Elasticsearch) is refused with the reason.
5. **The guest is never the last app.** Its teardown keeps the edge, the check key, Portainer and
   every key line but its own.
6. **The host's commands look at the server before harming it.** One check inspects the server
   through the host's deploy login and lists the guests' records. It refuses, naming each guest
   and the command that removes it:
   - destroy, `retarget` (its start, and `--finish`), a design that replaces the server, and a
     whole-server restore;
   - closing public SSH, switching the serving mode, a private network, and an add-on that serves
     on the server (Beszel, Portainer);
   - a resize that leaves the host and its guests too little memory.

   A resize that fits says the guests restart with the server. When the server can't be reached,
   the check says so and refuses; the user can rerun with a flag that accepts the risk, and the
   typed destroy confirmation stays.
7. **Matching rules for joining** (on top of own-server's `claimFindings`):
   - the guest is served the way the host is (proxied when the host is, DNS only otherwise; never
     a tunnel, since created servers are reached directly);
   - the guest uses the host's proxy (`target.edge`);
   - the guest's hostnames differ from the host's and from every other guest's;
   - its name differs from theirs and isn't `<other>-pr-<n>`;
   - its memory fits beside the host's limits and the other guests' limits.
8. **The warning is said plainly,** at design and in the host plan's approval, as previews do:
   anyone who can change the guest's deploy workflow or its deploy key reaches the host's data
   and secrets, because both apps run as the same `deploy` user in the docker group.
9. **Out of scope:**
   - a guest's previews on its host's server (refused as today);
   - a guest's whole-server snapshots and add-ons (refused: they belong to the host);
   - a guest on a server the user owns (that is `own` already);
   - moving the host to another server with its guests.

   A guest moving to a server of its own goes through `retarget` once the own side keeps the edge
   (`sharedEdge`), and is checked in the plan.

## R6. How to test it live

- **The throwaway pair first:** a host app on a throwaway Hetzner CX23 (labels of the run only),
  and a guest that is a further app (`opscrew app add`) of the same throwaway repository,
  `OPSCREW_E2E_GITHUB_REPO_C`. A further app has its own state, deploy key, workflow and
  approvals, as an app from another repository has, so the pass exercises the whole mechanism
  without a second repository. The 029 live passes use `OPSCREW_E2E_GITHUB_REPO` and `_B`, the
  zone's `e2e-*` names and the Hetzner test project, so the pass runs only after the 029 lead's OK.
  Names are `j030-*`, and cleanup matches the run's own labels and ids only. That project also
  holds the founder's production servers.
- **Then the real one:** the founder's second app beside his first, on that app's server.

# Feature Specification: More server providers, first wave (OVHcloud first)

**Feature Branch**: `035-providers-first-wave` (feature directory `specs/035-providers-first-wave`)
**Created**: 2026-11-21
**Status**: Draft (OVHcloud). Kamatera, IONOS Cloud and UpCloud are later phases of this feature.
**Input**: The roadmap's "035 More server providers, first wave" (the founder's order of
2026-11-20: OVHcloud first, then Kamatera, IONOS Cloud and UpCloud). Each provider is a package on
the cloud provider contract (ADR 0029), built in as Contabo is, and ships complete in its own pull
request before the next one starts. Research: [research.md](research.md). R1 has OVHcloud's facts,
R2 the lead's 15 decisions with their reasons, and R3 what only the live pass can check.

## Why

OVHcloud is Europe's largest cloud provider, and many people moving off hosted platforms in Europe
already have an account there. OpsCrew can't create a server there today. Its Public Cloud is
billed by the hour, metered per second, so a removal stops the cost at once, unlike Contabo's
monthly terms. Its smallest server costs about €7.59 a month at the hourly rate.

The contract (ADR 0029) means adding it is one package plus its place in the built-in list. OVHcloud
still differs from the providers OpsCrew has in ways the user must see (R1):
- its servers live in a **Public Cloud project** the user creates, and each region must be
  activated on that project first;
- servers carry **no tags**, so OpsCrew finds an app's servers by their names;
- the project's **default firewall is open**, so OpsCrew always attaches its own;
- **snapshots outlive the server** and keep billing until they are deleted;
- a later change of the first-boot script or of the image **reinstalls the server and wipes its
  disk**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy an app to an OVHcloud server (Priority: P1)

**Why this priority**: it is the feature's point, a server at Europe's largest cloud, billed by use.

**Independent Test**: the live pass on one `d2-4` goes through interview, design, provision,
deploy, verify, status, secure and drift, and the app answers on its domain. Until the founder's
go-ahead, the same flow runs against fakes of OVHcloud's API and the engine.

**Acceptance Scenarios**:

1. **Given** the four OVHcloud values in the environment (`OVH_ENDPOINT=ovh-eu`, `OVH_CLIENT_ID`,
   `OVH_CLIENT_SECRET` and `OVH_CLOUD_PROJECT_SERVICE`, the project's id), **When** the user runs
   `opscrew interview`, **Then** OpsCrew offers OVHcloud next to the other cloud providers, with
   the regions it serves. When only OVHcloud's values are set, it chooses OVHcloud without asking.
2. **When** the user runs `opscrew design`, **Then** the options show OVHcloud's plans (`d2-2`,
   `d2-4` and `d2-8`, shared; `b3-8` and `b3-16`, guaranteed) with:
   - the hourly price and the monthly figure for 730 hours, before VAT;
   - the price table's date, or "live" when the prices come from OVHcloud's public catalogue;
   - no setup fee, and that billing stops when the server is deleted;
   - no provider backups (OpsCrew's own snapshots cover the data).
3. **When** the user runs `opscrew provision` and approves the plan by its hash, **Then** OpsCrew
   creates, in the user's project:
   - the server, from Ubuntu 24.04 with the same first-boot setup as on the other providers;
   - its SSH key;
   - its own firewall (a security group) with the same rules as elsewhere: SSH from the allowed
     networks, the web ports on a server that serves the web, WireGuard where it is used. The
     server is never left on the project's default group.

   The deploy, verify, status, secure and drift commands then work as on the other providers.
4. **Given** a region not activated on the project, a plan out of stock in the region, or a project
   whose quota can't hold the server, **When** the user runs `opscrew design`, **Then** that plan
   isn't offered there. `opscrew init`'s check of the credentials lists the regions activated on
   the project and says how to activate another in the control panel. **When** a plan made
   earlier is applied and OVHcloud refuses the server for one of these reasons, **Then** provision
   stops with OVHcloud's answer and the same advice, as it does for an unavailable size on any
   provider. No server is created.
5. **Given** a create that timed out or failed halfway, **When** provision runs again, **Then** a
   server with the app's name that OpsCrew's state doesn't know is shown and taken over in the
   plan, never created a second time.
6. **Given** values that are missing or wrong, or an endpoint other than `ovh-eu`, **Then**
   `opscrew init` and provision name what is missing or wrong and link OVHcloud's page for service
   accounts. They say how to limit the account to the one project.

---

### User Story 2 - Remove an app from OVHcloud honestly (Priority: P1)

**Why this priority**: something left behind that keeps billing would cost the user money without
warning.

**Independent Test**: against fakes, and in the live pass, `opscrew destroy` deletes the server,
its firewall and its key, and the plan names every snapshot that stays and keeps billing.

**Acceptance Scenarios**:

1. **Given** an app on OVHcloud, **When** the user runs `opscrew destroy`, **Then** the plan says:
   - the server is deleted at once, and its hourly billing stops then;
   - OpsCrew removes the app's firewall, SSH key and DNS records;
   - snapshots of the server stay in the project and keep billing per GB until they are deleted in
     the control panel, each one named.
2. **Given** data on the server, **Then** OpsCrew offers its own data snapshot with the encrypted
   copy off the server first, as on every provider (024). A whole-server snapshot is offered too,
   since it outlives the server, with its monthly cost per GB.
3. **Then** the approval and the typed confirmation of the server's name come before anything is
   deleted, as on every provider.

---

### User Story 3 - Everything around a server, on OVHcloud (Priority: P2)

**Acceptance Scenarios**:

1. **Whole-server snapshots** (`opscrew snapshot --server`, `restore --server`) work through
   OVHcloud's instance snapshots, priced per GB a month. A restore rebuilds the server from the
   snapshot, after the approval that any restore needs.
2. **Moves** (`opscrew retarget`) work to and from OVHcloud like any other server target. A change
   of plan size on OVHcloud is refused with the reason and the way to do it: a move to a new
   server.
3. **Several servers** (018), **previews on a server** (022), **monitoring** (020), **logs**,
   **rollback** and **data snapshots** (019, 024) work on OVHcloud servers as on the others.
4. **`opscrew advise`** includes OVHcloud in its cost comparisons, labelled with the price
   table's date or "live".
5. **`opscrew rotate`** lists OVHcloud's service account among the user's own credentials, with
   how to replace it (025).
6. **No provider backups, no delete protection, no resize:** each is said plainly where it matters
   (design, the runbook, the guide), with what OpsCrew does instead.

---

### User Story 4 - The project's id reaches the server module, never a file (Priority: P2)

**Why this priority**: every OVHcloud resource names its project, and the contract has no place
for a value an app needs that isn't a server variable. It must never be written to a committed
file.

**Independent Test**: the generated root module declares the project variable, its value appears
in no generated or committed file, and the engine gets it only from the environment.

**Acceptance Scenarios**:

1. **Given** a provider whose definition lists a root variable fed from one of its credentials,
   **Then** the root module declares it, the server module calls pass it, and OpsCrew hands it to
   every engine command only through the environment.
2. **Given** Hetzner, DigitalOcean and Contabo, which list none, **Then** their generated files
   are byte-identical before and after.
3. **Then** the change to the shared contract waits for an `[035]` issue to the core's lead (the
   brief's rule), and is small and additive.

---

### User Story 5 - In the guide, and a live pass the founder can run (Priority: P3)

**Acceptance Scenarios**:

1. **Given** the guide, **Then** a page for OVHcloud says:
   - how to create the project and the service account, and how to limit the account to the
     project;
   - which regions to activate, and what each OpsCrew region maps to;
   - how billing works: by the hour, stopping at the delete, and what keeps billing (snapshots);
   - what isn't offered: provider backups, resizing, delete protection, monthly billing, and
     accounts outside OVHcloud's EU zone.

   The pages that list providers include it.
2. **Given** `docs/e2e.md`, **Then** the OVHcloud live pass has its steps, its variables and what it
   costs, so the founder can run it, or give a throwaway account.
3. **Then** the MCP tools accept `ovhcloud` wherever they accept a cloud provider, and the deploy
   and snapshot skills say what differs on OVHcloud.

---

### User Story 6 - Kamatera (Priority: later phase, not built now)

Kamatera follows once OVHcloud's pull request is merged. Its research, stories and requirements
are added to this folder then.

### User Story 7 - IONOS Cloud (Priority: later phase, not built now)

IONOS Cloud follows Kamatera, in the same way.

### User Story 8 - UpCloud (Priority: later phase, not built now)

UpCloud follows IONOS Cloud, in the same way.

### Edge Cases

- **A region OVHcloud's EU zone doesn't serve in OpsCrew's terms** (`eu-north`, `us-east`,
  `us-west`): the nearest location is used (Warsaw for the Nordics; Beauharnois, near Montreal,
  for the US), and design says so and why.
- **An account outside the EU zone** (`ovh-ca`, `ovh-us`): refused before any call, naming
  `ovh-eu` and saying the others are not supported yet.
- **Only some of the four values set**: the missing ones are named, and nothing is called.
- **A service account without the rights a call needs**: OVHcloud's answer is shown in plain
  English with the IAM policy to add, and nothing more is tried.
- **A change to the first-boot setup or the image after create**: it is never planned, because it
  would wipe the disk. The server keeps what it booted with.
- **Several servers with the app's name** (names aren't unique at OVHcloud): provision stops and
  lists them, rather than guessing which one is the app's.
- **The price table is old**: its date is shown wherever its prices are, and it is checked
  against the public catalogue before each release.
- **A firewall OVHcloud refuses to create or attach**: provision stops before the deploy and
  leaves no server reachable without one.
- **OVHcloud's values in the app's environment or files**: the analysis treats the app's `OVH_*`
  variables as provider credentials, as it does other providers' prefixes. The values have no
  recognisable format of their own, so `opscrew scan` has no rule that matches them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-3501**: OVHcloud MUST be a built-in cloud server provider, `ovhcloud`, in its own package
  written for the contract (ADR 0029), and added to the built-in list after Contabo. No code
  outside its package, the built-in list, the provider id lists and the docs MAY branch on it.
- **FR-3502**: Its connector MUST call OVHcloud's API with a typed client signed in by an OAuth2
  service account. Every answer MUST be validated before use, and the client never repeats a
  create.
- **FR-3503**: Its servers MUST be created through the IaC engine with OVHcloud's own Terraform
  provider (`ovh/ovh`, its current resource family), pinned to an exact minor version.
- **FR-3504**: Its credentials MUST be read from `OVH_ENDPOINT`, `OVH_CLIENT_ID`,
  `OVH_CLIENT_SECRET` and `OVH_CLOUD_PROJECT_SERVICE`, all four required, with `OVH_ENDPOINT`
  equal to `ovh-eu`. They MUST be redacted everywhere, the project id included, used only on the
  user's computer, and never written to state, tfvars, the server or CI.
- **FR-3505**: Design MUST price OVHcloud by the hour and for 730 hours, before VAT, in EUR. Prices
  come from a dated static table, or from OVHcloud's public catalogue when the credentials are
  set. Every price MUST show its date or "live", and there is no setup fee.
- **FR-3506**: With the credentials set, OVHcloud's catalogue MUST mark a plan unavailable in a
  region that isn't activated on the project, where it is out of stock, or where the project's
  quota can't hold it, so design never offers it there. The credential check MUST list the
  project's activated regions and say how to activate another. An apply OVHcloud refuses for one
  of these reasons MUST stop with its answer and what to do, through the same path as an
  unavailable size on any provider.
- **FR-3507**: Provision MUST create the server with the shared first-boot setup, its SSH key and
  its own firewall with the same rules as the other providers, set explicitly on the server. It
  MUST stop before the deploy when the firewall is not in place.
- **FR-3508**: A create MUST never be repeated blindly. A server with the app's name that the
  state doesn't know MUST be shown and taken over in the plan. Several such servers stop
  provision.
- **FR-3509**: Changes that would reinstall or recreate the server (first-boot setup, image, SSH
  key) MUST never be planned after create.
- **FR-3510**: Destroy MUST delete the server, its firewall and its key after the approval and the
  typed name, and its plan MUST name the snapshots that stay and keep billing.
- **FR-3511**: Whole-server snapshots, restores, moves, several servers, previews, monitoring,
  logs, rollback, data snapshots, advise, rotate, status, secure and drift MUST work for OVHcloud
  as US3 says. A size change MUST be refused with a move named as the way.
- **FR-3512**: The interview MUST offer OVHcloud and map OpsCrew's regions to its locations:
  eu-central to Limburg, Strasbourg, Gravelines or Warsaw; eu-north to Warsaw; us-east and us-west
  to Beauharnois; ap-southeast to Singapore or Sydney. Any region that maps elsewhere MUST be said
  in design.
- **FR-3513**: The contract MUST gain an optional way for a provider to name root variables its
  server modules read, each fed from one of its credentials and passed to the engine only through
  the environment (US4). Providers that name none MUST be unchanged.
- **FR-3514**: The MCP tools, the plugin skills and the guide (an OVHcloud page, plus the pages
  that list providers) MUST cover OVHcloud (US5). `docs/e2e.md` MUST give the live pass's steps.

### Key Entities

- **OVHcloud project**: the Public Cloud project the user created, named by its id. It holds the
  app's servers, keys, firewalls and snapshots, its activated regions and its quota.
- **Root variable of a provider**: a variable a provider's server modules read that isn't a
  server's own, with its description and the credential it is fed from.
- **OVHcloud price table**: the offered plans' hourly and 730-hour prices in EUR before VAT, the
  snapshot price per GB, its date and its source (the public catalogue, IE subsidiary).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-3501**: With fakes of OVHcloud's API and the engine, interview, design, provision, verify,
  status, secure, drift, a whole-server snapshot and its restore, and destroy each run on an
  OVHcloud app, with no real cloud call in any test.
- **SC-3502**: With a fake OVHcloud API that times out on create, a second provision creates no
  second server.
- **SC-3503**: For the example apps on Hetzner, DigitalOcean and Contabo, the generated files are
  byte-identical before and after, and every existing test passes.
- **SC-3504**: OVHcloud's tasks change nothing outside its package, the built-in list, the
  provider id lists, the contract's one optional field and its consumers, and the docs.
- **SC-3505**: No output, log, audit entry, generated or committed file of the fake runs holds any
  of the four OVHcloud values. The live pass, when the founder runs it, checks the same across its
  state files too.
- **SC-3506**: `pnpm check` passes on the pull request, or the pull request says plainly which
  test failed and why.
- **SC-3507**: The founder can run the live pass from `docs/e2e.md` alone. It costs under €0.05 an
  hour while it runs (one `d2-4` and its snapshot), and nothing after its destroy except what it
  names.

## Assumptions

- The lead's decisions of 2026-11-21 (research R2).
- Accounts in OVHcloud's EU zone only (`ovh-eu`), billed in EUR. `ovh-ca` and `ovh-us` are later,
  if users ask.
- The user creates the Public Cloud project and activates its regions in OVHcloud's control panel.
  OpsCrew never orders a project, never activates a region and never raises a quota.
- Hourly billing only. Monthly billing is later, if users ask.
- Facts the research could not verify are checked on the live pass, which needs the founder's
  go-ahead because it costs money (research R3):
  - the service account on every route used;
  - the Ubuntu 24.04 image's name and its default user;
  - each plan's availability per region;
  - the error texts for no stock and no quota;
  - the time to a running server;
  - IPv6 by default.
- Not in scope:
  - OVHcloud's object storage, automated backups, private networks (vRack), load balancers and
    local zones;
  - monthly billing, resizing and delete protection;
  - Kamatera, IONOS Cloud and UpCloud, which are this feature's later phases.

# Implementation Plan: More server providers, first wave (OVHcloud first)

**Branch**: `035-providers-first-wave` | **Date**: 2026-11-21 | **Spec**: [spec.md](spec.md)
**Input**: [spec.md](spec.md), [research.md](research.md) (R1 OVHcloud's facts, R2 the lead's
decisions, R3 the live checks).

## Summary

OVHcloud's Public Cloud becomes the fourth built-in cloud server provider, `ovhcloud`, in its own
package `@opscrew/provider-ovhcloud` on the contract of ADR 0029, as Contabo did in 026. It
contains:
- its definition;
- an API client signed in by an OAuth2 service account;
- a catalogue: a dated static price table, read live from OVHcloud's public catalogue when the
  credentials are set, with each offer's availability in the project;
- the server API: lookup by name, snapshots, rebuilds and power;
- its HCL module on `ovh/ovh` `~> 2.25.0` (an instance, an SSH key and a security group).

One thing in the contract is missing for it. Every OVHcloud resource names its project, and a
provider can't bring a value an app needs that isn't a server variable into its module. So the
contract gains one optional field, `rootVariables`, with three small generic consumers:
- the registry validates it;
- iac-templates declares the variables in the root;
- `projectEngine` passes them as `TF_VAR_*` from the environment.

That change, and the new id in the shared id lists, go through `[035]` issues to the core's lead
first. Kamatera, IONOS Cloud and UpCloud come later, each in its own pull request.

## Technical Context

- **Language**: TypeScript strict ESM on Node 22.9+, pnpm and turbo, Vitest, zod, Biome, as for
  every package.
- **Infrastructure**: OpenTofu and Terraform 1.6+ in the common dialect, with the `ovh/ovh`
  provider pinned `~> 2.25.0` (2.25.0 was published 2026-11-13).
- **OVHcloud API**: `https://api.eu.ovhcloud.com/1.0` and `https://api.eu.ovhcloud.com/v2`
  (go-ovh's `OvhEU`; the v2 base is to be confirmed against the v2 schema by T3505), with OAuth2
  client credentials from `https://auth.eu.ovhcloud.com/oauth2/token`, scope `all` (go-ovh
  `ovh.go` and `configuration.go`, read 2026-11-21). The public catalogue is
  `GET /1.0/order/catalog/public/cloud?ovhSubsidiary=IE`.
- **Testing**: unit tests with injected `fetch` fakes and fixtures written from the API's documented
  answers (`eu.api.ovh.com/v1/cloud.json`, `v2/publicCloud.json`). No real cloud call anywhere.
  The module is checked with `tofu validate` and `fmt -check`, plus `terraform` where installed,
  skipping when the provider can't be downloaded, as Contabo's is.
- **Constraints**:
  - no new dependency (the client uses the injected `fetch`, and node's `crypto` only if needed);
  - no secret-shaped literal in any fixture (`fakeSecret`, `{{FAKE:<kind>}}`);
  - temp files under `OPSCREW_TEST_TMP=D:/opscrew-test-tmp`.

## Constitution Check

- **I. Safety gate**: unchanged. Every OVHcloud change is a Terraform plan approved by its hash,
  and a destroy needs `allowDestroy` and the typed name. The connector's mutating calls (snapshot,
  rebuild, power, reinstall) are the ones `ServerSnapshotApi` already gates in the agents. No
  standing approval is added. ✅
- **II. The user owns everything**: the module is vendored into the user's repository, and the
  project id is never written to a file. A user who deletes OpsCrew keeps HCL that runs with
  `TF_VAR_ovhcloud_project_id` set. The guide says so. ✅
- **III. Dual engine**: the module stays in the common dialect and is validated under both
  engines. ✅
- **IV. Secrets**: all four values are registered with the redactor when read. They are never in
  state (the provider reads them from the environment) or in tfvars. The service account is
  scoped to one project by an IAM policy, which the guide and `init` explain. ✅
- **V. Deterministic first**: the catalogue, availability and every check are code. No model is
  involved. ✅
- **VI. Contracts first**: one optional field, `rootVariables`, owned by `@opscrew/contracts`, is
  changed in its own task (T3501) and recorded in ADR 0029 as D11. The id joins the lists in
  T3509. ✅
- **VII. Test-first**: every task names its `Verify:` command. ✅

## Design

### 1. The contract: `ProviderTerraform.rootVariables` (T3501, lead, after the issue)

```ts
/**
 * Root variables the provider's server module calls read (`var.<name>` in `moduleArguments`)
 * that are not a server's own: OpsCrew declares each in the root module once, and passes it to
 * every engine command only as `TF_VAR_<name>` from the credential variable `fromEnv`, never in
 * a file. Absent for most providers.
 */
rootVariables?: readonly { name: string; description: string; fromEnv: string }[];
/**
 * The HCL expression of an `import` block's `id` that takes over the server `serverId` (026's
 * takeover); absent, the quoted id (`"<serverId>"`). OVHcloud imports an instance as
 * `<project>/<id>`, so its expression reads the project from its root variable.
 */
importId?(serverId: string): string;
```

`importId` was found while building T3508: `ovh_cloud_instance` imports only as
`<service_name>/<instance id>` (the provider's `ImportState`), and iac-templates' takeover writes
`id = "<id>"`. Writing the project id there would put it in `main.tf`.

ADR 0029 gains **D11**: the reason (OVHcloud's `service_name`), the rule (only a credential feeds
it, only through the environment), and that the vendored HCL then needs `TF_VAR_<name>` set by
whoever runs it without OpsCrew.

### 2. Its consumers (wave 1, generic, byte-identical for the other three providers)

- **The registry** (`validate.ts`):
  - each name is a valid HCL identifier that collides with no server variable (`location`,
    `server_type`, `image`, `backups` and their prefixes) and with no other provider's root
    variable;
  - `fromEnv` is one of the provider's `credentials.envVars`;
  - the description is not empty.
- **iac-templates**: every root that renders at least one server of a provider with
  `rootVariables` declares each one once, `type = string`, with its description and no default.
  It never writes a value for it to `terraform.tfvars.json`. The roots of the other providers are
  byte-identical (the existing snapshot tests prove it).
  - **Not `sensitive`:** OpenTofu 1.13.9 refuses a sensitive value in an `import` block's `id`
    ("The import id cannot be sensitive"; the lead's local check, 2026-11-21). A non-sensitive
    variable there plans fine. The project id isn't a secret, and the redactor still masks its
    value in everything OpsCrew shows. Terraform is checked by T3504's test where it is installed.
  - **The takeover's `import` block** writes `id = <importId(serverId)>` when the provider has
    `importId`, and the quoted id otherwise.
- **The agents' `projectEngine`** (`shared/engine.ts`): for every built-in provider's root
  variables, when `env[fromEnv]` is set, it sets `env["TF_VAR_" + name]` and registers the value
  with the redactor. A root that doesn't declare the variable ignores it, which is the engines'
  documented behaviour for `TF_VAR_*`, so the other roots are unaffected. All nine callers then
  have it with no change. The task lists any engine run that doesn't go through `projectEngine`
  (a grep for `engine.plan(`, `engine.apply(`, `engine.init(`) and covers it, or reports it.

### 3. The OVHcloud package (`packages/providers/ovhcloud`, `@opscrew/provider-ovhcloud`)

- **`client.ts`**:
  - **Sign-in:** an OAuth2 client-credentials token, cached until it expires and fetched again
    once on a 401.
  - **Endpoint check:** `OVH_ENDPOINT` must be `ovh-eu`. Any other value is refused before any
    call, naming `ovh-eu`.
  - **The four values:** registered with the redactor when read.
  - **Requests:** v1 and v2 paths under the EU base, and every answer parsed with zod.
  - **Errors:** OVHcloud's error JSON (`class`, `message`, and `details` with
    `unauthorizedActionsByIAM`) mapped to plain English:
    - a missing right names the IAM action to allow;
    - a 404 on the project says to check `OVH_CLOUD_PROJECT_SERVICE`;
    - a 429 waits for `Retry-After` and retries once on reads only.
  - **Creates are never retried.**
- **`static-prices.ts`**: `d2-2`, `d2-4`, `d2-8`, `b3-8` and `b3-16`, each with:
  - vCPU, memory and disk;
  - the hourly price in EUR before VAT, with `monthly` = hourly × 730 as the cap the contract asks
    for;
  - `cpuType`: shared for d2, dedicated for b3.

  It also holds the snapshot price of €0.011 per GB a month and €0.000015 per GB an hour, the date
  2026-11-21 and the source (the IE catalogue).
- **`catalog.ts`**:
  - **Without credentials:** the static table, offered in every mapped location, `source: "static"`.
  - **With credentials:** the public catalogue read once a run (prices in 1e-8 EUR, the plan codes
    `<flavor>.consumption`), crossed with `GET /v2/publicCloud/project/{id}/reference/productAvailability`.
    An offer is `available` only where its region is activated, its stock isn't `OUT_OF_STOCK`,
    and its quota isn't `INSUFFICIENT`.
  - **If the live read fails:** the static table with a warning, as the other providers fall back.
  - **`extras`:** the snapshot rate and no IPv4 line (the public IPv4 is free).
- **`servers.ts`** (`ServerSnapshotApi`):
  - **`findAppServers(app)`:** the project's instances named exactly `app` or `app-…`, every one
    `nameOnly: true`, since OVHcloud has no tags. The generic takeover (026) then adopts a server
    only when OpsCrew's own apply stopped while creating it.
  - **Snapshots:** taken through the instance's snapshot call, named
    `opscrew-<app>-<server id>-<time>`, and listed by that prefix, oldest first. Delete waits until
    the snapshot is gone.
  - **Other calls:** `rebuild` = reinstall from the snapshot's image; `powerOff` = stop and wait for
    `SHUTOFF`; `powerOn` = start and wait for `ACTIVE`; `restart` = soft reboot; `reinstall` = the
    image with the user data.
  - **API version:** the implementer picks v1 or v2 per call from the schemas, preferring v2 where
    it has the call, and records each choice in the task's report.
- **`connector.ts`**: `verifyCredentials` gets a token and reads the project. Its message names the
  project's description and lists the activated regions, with the control panel's path to
  activate another (Public Cloud → the project → Settings → Regions; the implementer confirms the
  path from OVHcloud's docs). It also exposes `catalog()` and `servers`. There are no `firewalls`,
  `backups` or `objectStorage`.
- **`definition.ts`**, as research R2:
  - `billing: { model: "hourly", counts: "second", setupFee: false }`;
  - `providerBackups: false`, `backupPercent: 0`, `backupsOutliveServer: false`;
  - `snapshots: per-gb`, `serverSnapshotsOutliveServer: true`;
  - `deleteProtection: false`, `resize: false`, `removal: { kind: "delete" }`;
  - `connectorFirewall`, `connectorBackups` and `connectorRemoval` false, and no `homeCacheFiles`;
  - `lifecycleIgnored: ["user_data", "image_id", "ssh_key_name"]`;
  - `rootVariables: [{ name: "ovhcloud_project_id", fromEnv: "OVH_CLOUD_PROJECT_SERVICE", … }]`;
  - `tokenRules: []` and `envPrefixes: ["OVH"]`;
  - the regions as R2.7, with the notes and coordinates;
  - `unavailable` and `serverLimit` patterns from the words the API uses (`OUT_OF_STOCK`,
    `INSUFFICIENT`, `quota`), marked unverified until the live pass;
  - every text (runbook, destroy, init, SecOps) in plain English. The destroy texts name the
    snapshots that keep billing.
- **`module/` (`ovhcloud-instance`)**:
  - data sources resolve the flavor by name and the image `Ubuntu 24.04` by name in the region;
  - `ovh_cloud_ssh_key` `<app>-deploy`, kept in the root as `extraShared` so removing a server
    never deletes it, as Contabo's key;
  - `ovh_cloud_security_group` `opscrew-<name>` with Hetzner's rules (IPv4 and IPv6 sources);
  - `ovh_cloud_instance` with `security_group_ids` set explicitly to that group, the shared
    `cloud-init.yaml.tftpl` base64-encoded in `user_data`, and `lifecycle.ignore_changes` as above;
  - the outputs other modules have (`server_id`, `server_name`, `ipv4_address`, `ipv6_address`,
    `ssh_key_id`);
  - `src/generated/module.ts` from `pnpm gen:provider-modules`.
- **SecOps**: the security group's `rule` list read into Hetzner's rule shape. Its attachment comes
  from the instance's `security_group_ids` or, before apply, from the plan configuration's
  references, as Contabo's definition reads its firewall's.

### 4. The id joins the lists (T3509, lead, after the issue)

`ovhcloud` in:
- `ProviderId` and `VpsProviderId` (contracts);
- `VpsProviderSchema` and `DEFAULT_IMAGES` (`"Ubuntu 24.04"`) in plan-schema, and its generated
  schemas;
- `CLOUD_PROVIDERS`, after Contabo, and the registry's and CLI's `package.json` dependencies, with
  the lockfile.

Then `pnpm check` must pass, with any exhaustive switch left over fixed. This is the same task as
026's T2616.

### 5. The guide, the plugin, the live pass (wave 3)

- `docs/guide/ovhcloud.md` on `docs/guide/contabo.md`'s model.
- The pages that list providers. `docs/guide/index.md` is shared, so it goes in the `[035]` issue.
- The plugin's deploy and snapshot skills.
- `packages/cli/test/live/ovhcloud.test.ts` (`OPSCREW_E2E_OVHCLOUD=1` and the four variables) and
  its steps in `docs/e2e.md`, written for the founder. It is never run without his go-ahead.

### 6. Tests

- **The registry:** its conformance test over the four definitions, plus `rootVariables`
  validation cases (a bad name, a collision, `fromEnv` not a credential).
- **iac-templates:** the existing snapshots unchanged, and a root with an OVHcloud server declaring
  `ovhcloud_project_id` once, with no value in `terraform.tfvars.json`.
- **The agents:** `projectEngine` sets the `TF_VAR_` and registers it with the redactor, and leaves
  `env` untouched for a variable that isn't set.
- **OVHcloud's client and connector, with `fetch` fakes:**
  - a token renewed on a 401;
  - a missing IAM right in plain English;
  - `ovh-ca` refused before any call;
  - availability marking offers unavailable;
  - the live catalogue's prices parsed from a trimmed fixture of the real shape;
  - `findAppServers` by exact names;
  - a create's timeout followed by a second provision that creates nothing (SC-3502, with the
    generic takeover's fakes);
  - no credential or project id in any error, log or fixture.
- **The module** under both engines, and SecOps on an OVHcloud plan JSON fixture (an attached
  group, a missing one, the default group never used).

## Decisions (lead, 2026-11-21)

1. **`rootVariables` is a contract field, not a plan.yaml field.** The project id belongs with the
   credentials: the IAM policy scopes the service account to the project. A plan field would
   change plan-schema, design and the interview for one provider.
2. **Every OVHcloud server is `nameOnly`.** The takeover's shared message then says "without
   OpsCrew's tag", which reads oddly for a provider with no tags. Wording it per provider is a
   shared change that waits until users see it.
3. **No pre-plan availability check in provision** (research R2.8). The catalogue keeps
   unavailable offers out of design, and an apply refused anyway takes the existing path.
4. **One price table date** (2026-11-21), checked against the catalogue before each release, as
   Contabo's is.
6. **Design falls back to a dedicated type when no shared one holds the app** (found by T3510's
   tests). OVHcloud's shared d2 types hold at most 50 GB, so an app with PostgreSQL, which design
   sizes at 60 GB, had no option at all. `design/options.ts` now offers the dedicated type then,
   for every provider; Hetzner, DigitalOcean and Contabo always have a shared type that fits, so
   their options are unchanged. Lowering the disk floor for one provider would branch on its id.
   The live pass moves from `d2-2` (25 GB, below the 40 GB floor) to `d2-4`.
5. **Monthly billing, `ovh-ca` and `ovh-us`, automated backups, resizing and delete protection**
   are later, if users ask (research R2).

## Order

- **T3500 (lead):** research, spec, plan, tasks; the `[035]` issues for `rootVariables` and the id.
- **T3501 (lead, after the rootVariables issue):** the contract field and ADR 0029 D11.
- **Wave 1:** T3502 the registry's validation ∥ T3503 iac-templates ∥ T3504 the agents'
  `projectEngine` ∥ T3505 OVHcloud's client. T3505 needs only the contract as it is.
- **Wave 2:** T3506 the catalogue and price table ∥ T3507 the server API and connector. Then
  T3508, the definition and module, which needs T3501 and T3507.
- **T3509 (lead, after the id issue):** `ovhcloud` joins the ids, the schemas and the registry.
- **Wave 3:** T3510 the guide ∥ T3511 the plugin skills and MCP text ∥ T3512 the live test file and
  `docs/e2e.md`.
- **T3513 (lead):** a fresh review of the whole branch, `pnpm check`, then the pull request.
  **T3514 (lead):** the live pass, only with the founder's go-ahead.

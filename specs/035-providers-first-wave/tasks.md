---
description: "Tasks for 035-providers-first-wave"
---

# Tasks: More server providers, first wave (OVHcloud first)

**Status**: OVHcloud being built since 2026-11-21. Kamatera, IONOS Cloud and UpCloud follow, each
with its own tasks added here when its work starts.

**Input**: `specs/035-providers-first-wave/` (spec.md, plan.md, research.md); feature 026 (the
contract, ADR 0029, and Contabo as the template).

**Numbering**: T3501–T3599 (T3500 is the lead's documents).

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`. Implementers never edit `tasks.md`, specs, root configuration, a `package.json`'s
dependencies or the lockfile. No real secret in any test: `fakeSecret(kind)` and
`{{FAKE:<kind>}}` (`@opscrew/core/testing`).

**Rules for every task:**
- **Approvals:** nothing changes the safety gate. Every OVHcloud change is a plan approved by its
  hash. The connector's mutating calls are the ones `ServerSnapshotApi` already has.
- **Leaks:** none of the four OVHcloud values (the project id included), no address and no token
  in output, logs, audit entries, errors or fixtures. Every OVHcloud test file ends with a leak
  check.
- **Sources:** every request and answer shape comes from OVHcloud's published schemas
  (`https://eu.api.ovh.com/v1/cloud.json`, `https://eu.api.ovh.com/v2/publicCloud.json`) or the
  `ovh/ovh` provider's docs and source. Never guess an answer. Record what you read in the report;
  the lead moves it into research R1.
- **Words:** user-facing text says "OVHcloud", "your Public Cloud project" and "the control panel",
  and never names a task or a feature number.
- **No network in unit tests:** inject `fetch`. Module validation may download the provider and
  skips plainly without the network.
- **Temp files:** run tests with `OPSCREW_TEST_TMP=D:/opscrew-test-tmp`.
- **Scope:** build only what Accept asks. Report anything else.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.
- **Worktrees:** `D:/opscrew/.claude/worktrees/t35NN`, branched from `035-providers-first-wave`;
  `pnpm install --frozen-lockfile --prefer-offline` first.

## Phase 1: Foundation (lead)

- [x] T3500 (lead) Research, spec, plan, tasks

- [x] T3501 (lead) The package's skeleton
  - Accept: `packages/providers/ovhcloud` with `package.json` (`@opscrew/provider-ovhcloud`, the
    same dependencies, scripts and `exports` as `@opscrew/provider-contabo`), `tsconfig.json`,
    `vitest.config.ts`, an empty `module/` folder, `src/index.ts` exporting nothing yet, and the
    lockfile regenerated. `pnpm check` is as green as before (see the baseline note in the PR).
  - Effort: lead

- [ ] T3502 (lead, after the `[035]` rootVariables issue) The contract's `rootVariables`
  - Accept: `ProviderTerraform.rootVariables?` exactly as plan 1., exported from
    `@opscrew/contracts`; ADR 0029 gains D11. No other file changes, and the typecheck is green.
  - Effort: lead

## Phase 2: Wave 1 (parallel)

- [ ] T3503 [P] [US4] The registry validates `rootVariables`
  - Owns: `packages/providers/registry/src/validate.ts`, `validate.test.ts`
  - Reads: plan 1. and 2.; `validate.ts`; `packages/contracts/src/provider.ts`
  - Depends: T3502
  - Accept:
    - A definition without `rootVariables` validates as today.
    - Each root variable's `name` is an HCL identifier (`^[a-z][a-z0-9_]*$`), collides with no
      server variable (`location`, `server_type`, `image`, `backups`, `delete_protection`, with or
      without a prefix ending in `_`), and isn't repeated within the definition.
    - Its `fromEnv` is one of the definition's `credentials.envVars`, and its `description` isn't
      empty.
    - Each failure names the provider, the variable and what is wrong, as the validator's other
      messages do.
    - A test also checks across `CLOUD_PROVIDERS` that no two providers declare the same root
      variable name.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/providers && npx vitest run --root packages/providers/registry && pnpm lint`
  - Effort: medium

- [ ] T3504 [P] [US4] iac-templates declares a provider's root variables
  - Owns: `packages/iac-templates/src/infra/**` (and its tests and snapshots)
  - Reads: plan 1. and 2.; `infra/servers.ts` (`serverVariables`, `providerBlock`, `renderedServers`),
    `infra/index.ts`, where `terraform.tfvars.json` is written
  - Depends: T3502
  - Accept:
    - A root that renders at least one server (the app's, the previous one during a move, or an
      extra one) of a provider with `rootVariables` declares each one once: `type = string`,
      `sensitive = true`, its description, no default.
    - No value for it is ever written to `terraform.tfvars.json` or any other rendered file.
    - Every existing snapshot and output for Hetzner, DigitalOcean and Contabo is byte-identical.
    - Tests use a definition fake with one root variable, since OVHcloud isn't in the registry yet:
      the declaration appears once for two servers of that provider, and is absent without them.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates && pnpm lint`
  - Effort: high

- [ ] T3505 [P] [US4] The engine gets each root variable from the environment
  - Owns: `packages/agents/src/shared/engine.ts`, `engine.test.ts`
  - Reads: plan 2.; `shared/engine.ts` (`projectEngine`, `NOT_FOR_THE_ENGINE`), `shared/root-variables.ts`
  - Depends: T3502
  - Accept:
    - For every built-in provider's root variables, `projectEngine` sets `env["TF_VAR_" + name]`
      from `env[fromEnv]` when that is set, and registers the value with the redactor. It changes
      nothing when it isn't set.
    - Tested with a registry where a provider has one root variable (inject or fake as the package's
      tests already do; report if the registry can't be faked).
    - List every engine run in `packages/agents/src` that doesn't get its environment from
      `projectEngine` (grep `engine.plan(`, `engine.apply(`, `engine.init(`, `engine.destroy(`,
      `stateResources(`). Cover those you own, and report the others with their file and line.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/shared && pnpm lint`
  - Effort: medium

- [x] T3506 [P] [US1] OVHcloud's API client
  - Owns: `packages/providers/ovhcloud/src/client.ts`, `client.test.ts`, `src/__fixtures__/**`
  - Reads: plan 3.; research R1 sections 1 and 10, and R2.4; `packages/providers/contabo/src/client.ts`
    and its tests (the template); go-ovh's `ovh/ovh.go`, `configuration.go` and `error.go`
  - Depends: T3501
  - Accept:
    - `OVHCLOUD_ENV` names the four variables. Reading them registers each with the redactor. A
      missing one is named, and an `OVH_ENDPOINT` other than `ovh-eu` is refused before any call
      with a message naming `ovh-eu`.
    - An OAuth2 client-credentials token from `https://auth.eu.ovhcloud.com/oauth2/token` (scope
      `all`), cached until it expires and fetched again once on a 401.
    - `get`, `post`, `put` and `delete` against the v1 and v2 bases, every answer parsed with a zod
      schema the caller passes.
    - Errors (`class`, `message`, `details`) become `OpsCrewError`s in plain English that say what
      to do:
      - a missing IAM right names the action;
      - a 404 on the project says to check `OVH_CLOUD_PROJECT_SERVICE`;
      - a 429 retries reads once after `Retry-After`.
    - A `post` is never retried.
    - Tests with `fetch` fakes cover each rule, and a leak check shows no value in any error or
      request log.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ovhcloud && npx vitest run --root packages/providers/ovhcloud && pnpm lint`
  - Effort: high

## Phase 3: Wave 2

- [ ] T3507 [P] [US1] [US3] The catalogue and the price table
  - Owns: `packages/providers/ovhcloud/src/catalog.ts`, `catalog.test.ts`, `static-prices.ts`, its
    fixtures under `src/__fixtures__/catalog*`
  - Reads: plan 3.; research R1 sections 7 and 8, and R2.3; `packages/contracts/src/connector.ts`
    (`ComputeCatalog`, `ComputeOffer`, `ProviderExtras`); Contabo's and Hetzner's catalogue
  - Depends: T3506
  - Accept:
    - Static: the five plans of plan 3. with the 2026-11-21 prices, each offered in every mapped
      location, `billing: "hourly"`, `hourly`, `monthly` = hourly × 730, no `setupFee`,
      `source: "static"`, the table's date.
    - Live, with credentials: the public catalogue parsed from a trimmed fixture of its real shape
      (prices in 1e-8 EUR, `<flavor>.consumption`, `blobs.technical`), crossed with
      `reference/productAvailability`. `available` is false where the region isn't activated,
      the stock is `OUT_OF_STOCK` or the quota is `INSUFFICIENT`. The catalogue is read once per
      catalogue object.
    - A failed live read falls back to the static table with a warning.
    - `extras(location)`: the snapshot rate per GB a month and an hour, with no IPv4 line.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ovhcloud && npx vitest run --root packages/providers/ovhcloud && pnpm lint`
  - Effort: high

- [ ] T3508 [P] [US1] [US2] [US3] The server API and the connector
  - Owns: `packages/providers/ovhcloud/src/servers.ts`, `servers.test.ts`, `connector.ts`,
    `connector.test.ts`, their fixtures
  - Reads: plan 3.; research R1 sections 5, 8, 9 and 10; `ServerSnapshotApi` and `VpsConnector`
    in `packages/contracts/src/connector.ts`; `packages/agents/src/provision/takeover.ts` (how
    `nameOnly` is used); Contabo's `servers.ts` and `connector.ts`
  - Depends: T3506
  - Accept:
    - `findAppServers(app)` returns the project's instances named exactly `app` or `app-<name>`,
      each with `nameOnly: true`.
    - Snapshots:
      - `snapshotServer` names the snapshot `opscrew-<app>-<server id>-<time>` and waits until it
        is complete;
      - `listSnapshots` lists by that prefix, oldest first, with sizes where known;
      - `deleteSnapshot` waits until it is gone.
    - Power and rebuild:
      - `rebuild` reinstalls from the snapshot and waits;
      - `powerOff` stops and waits for `SHUTOFF`, never forcing;
      - `powerOn` starts and waits for `ACTIVE`;
      - `restart` does a soft reboot;
      - `reinstall` uses the image and user data.
    - Every wait has a timeout with a plain message, and the clock and sleep are injected.
    - The connector: `configured`, `catalog()`, `servers` (undefined without credentials), and
      `verifyCredentials`. The latter reads the project and lists its activated regions, with the
      control panel's path to activate another; confirm the path in OVHcloud's docs.
    - A test with the generic takeover's inputs shows that a create which timed out leaves a
      server `findAppServers` reports, so a second provision takes it over rather than creating
      one (SC-3502). Report if that needs the agents' fakes.
    - Each API call's v1 or v2 choice is listed in the report.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ovhcloud && npx vitest run --root packages/providers/ovhcloud && pnpm lint`
  - Effort: xhigh

- [ ] T3509 [US1] [US2] [US3] The definition and the module
  - Owns: `packages/providers/ovhcloud/src/definition.ts`, `definition.test.ts`, `src/index.ts`,
    `module/**`, `src/generated/**`
  - Reads: plan 3.; research R2 in full; `packages/contracts/src/provider.ts`; Contabo's and
    Hetzner's `definition.ts`, `definition.test.ts` and `module/`; `scripts/gen-provider-modules.ts`;
    the `ovh/ovh` docs for `ovh_cloud_instance`, `ovh_cloud_ssh_key`, `ovh_cloud_security_group`,
    `ovh_cloud_instance_flavors` and `ovh_cloud_instance_images`
  - Depends: T3502, T3507, T3508
  - Accept:
    - `definition` as plan 3., including `rootVariables`, regions, offering, Terraform and every
      text, validated by `validateCloudProvider` in the test (import the registry's validator as
      Contabo's test does, or report how).
    - The module `ovhcloud-instance`:
      - the flavor and image resolved by name per region;
      - the security group with Hetzner's rules, set explicitly on the instance;
      - the SSH key shared through `extraShared`;
      - `user_data` from the shared cloud-init, and `lifecycle.ignore_changes` on `user_data`,
        `image_id` and `ssh_key_name`;
      - the usual outputs.
    - `src/generated/module.ts` is regenerated with `pnpm gen:provider-modules`.
    - SecOps reads the group's rules and its attachment, tested on a plan JSON fixture: attached;
      not attached; and an instance left on the default group is reported as not attached.
    - The module validates and passes `fmt -check` under `tofu` (and `terraform` where installed),
      skipping plainly without the network, as Contabo's test does.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/provider-ovhcloud && OPSCREW_IT=1 npx vitest run --root packages/providers/ovhcloud && pnpm lint`
  - Effort: xhigh

- [ ] T3510 (lead, after the `[035]` id issue) `ovhcloud` joins the ids and the registry
  - Accept:
    - `ovhcloud` in `ProviderId`, `VpsProviderId`, `VpsProviderSchema`, `DEFAULT_IMAGES`
      (`"Ubuntu 24.04"`) and the generated schemas.
    - `CLOUD_PROVIDERS` after Contabo, with the registry's and the CLI's dependencies and the
      lockfile.
    - Any exhaustive switch left over is fixed.
    - `npx opscrew providers --json` lists it.
    - `pnpm check` passes, or the failures are only the environment's, named in the PR.
  - Effort: lead

## Phase 4: Wave 3 (parallel)

- [ ] T3511 [P] [US5] The guide
  - Owns: `docs/guide/ovhcloud.md`, and OVHcloud's lines in `docs/prices-compared.md`,
    `docs/guide/snapshots.md`, `retarget.md` and `credential-rotation.md`
  - Reads: spec US5; research R2 and R3; `docs/guide/contabo.md` (the model); README's provider
    list (report its line for the lead)
  - Depends: T3510
  - Accept:
    - The page covers what spec US5.1 lists: the project, the service account and its IAM policy
      limited to the project, `OVH_ENDPOINT=ovh-eu`, the regions to activate, billing by the hour
      and what keeps billing, and what isn't offered.
    - It also says that the vendored HCL needs `TF_VAR_ovhcloud_project_id` without OpsCrew.
    - The other pages list OVHcloud where they list Contabo.
    - `docs/guide/index.md` waits for its issue (report the line to add).
  - Verify: `pnpm lint`
  - Effort: medium

- [ ] T3512 [P] [US5] The plugin's skills and the MCP text
  - Owns: `plugin/**`, `packages/mcp-server/src/**` (text only)
  - Reads: spec US5.3; how 026's T2618 added Contabo
  - Depends: T3510
  - Accept: the MCP tools accept `ovhcloud` wherever they accept a cloud provider (from the
    registry, as today), and the deploy and snapshot skills say what differs on OVHcloud.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server && pnpm lint`
  - Effort: medium

- [ ] T3513 [P] [US5] The live test and its steps
  - Owns: `packages/cli/test/live/ovhcloud.test.ts`, OVHcloud's section of `docs/e2e.md`
  - Reads: `packages/cli/test/live/contabo.test.ts`, `docs/e2e.md`'s Contabo section, spec SC-3507
  - Depends: T3510
  - Accept:
    - The test runs only with `OPSCREW_E2E_OVHCLOUD=1` and the four variables. It goes through the
      flow of SC-3501 on one `d2-2` and ends with a scan for the four values.
    - `docs/e2e.md` gives the steps, the variables, the IAM policy and the cost (under €0.05 an
      hour, and what stays after the destroy).
    - It is never run in this task.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && pnpm lint`
  - Effort: medium

## Phase 5: Finish (lead)

- [ ] T3514 (lead) A fresh review of the whole branch, `pnpm check`, research R1 updated with the
  implementers' findings, then the pull request (OVHcloud's)
- [ ] T3515 (lead) The live pass, only with the founder's go-ahead (it costs money)

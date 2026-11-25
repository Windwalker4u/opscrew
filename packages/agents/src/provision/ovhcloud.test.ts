// SC-3501 with fakes: an OVHcloud app through OpsCrew's own flows, provision, verify, status,
// secure, drift, a whole-server snapshot and its restore, on one project. The engine is the fake
// one, OVHcloud's server API `FakeServers`; nothing reaches a network or a cloud. The project's id
// reaches the engine only as TF_VAR_ovhcloud_project_id (ADR 0029, D11), and none of the four
// OVHcloud values is shown, audited, committed or sent to GitHub (SC-3505).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { CommandResult, ComputeCatalog, FetchLike, RemoteExec } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDrift } from "../drift";
import { runSecure } from "../secure";
import { restoreServerSnapshot, takeServerSnapshot } from "../snapshot/server";
import { componentStatusReport } from "../status";
import {
  CLOUDFLARE_IPV4,
  CLOUDFLARE_IPV6,
  CLOUDFLARE_RANGES,
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  FakeServers,
  fakeCloudflare,
  fakeSharedCloudflare,
  noOtherApps,
  opscrewRecord,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
  writeFakeState,
} from "../testing";
import { runVerify } from "../verify";
import {
  OVH_ADDRESSES,
  OVH_CREATE,
  OVH_ENV,
  OVH_PROJECT,
  OVH_SERVER_ID,
  OVH_SNAPSHOT_ID,
  ovhcloudPlanJson,
} from "./__fixtures__/ovhcloud";
import { findSavedPlan } from "./plan-apply";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

/** When the deploy workflow's run started, as GitHub reports it. */
const DEPLOYED_AT = "2026-10-11T11:30:00Z";

/** The OVHcloud values that must never be shown: all but the zone, which OpsCrew's texts name. */
const SECRET_VALUES = [OVH_ENV.OVH_CLIENT_ID, OVH_ENV.OVH_CLIENT_SECRET, OVH_PROJECT];

/** The site behind Cloudflare and GitHub's deploy runs, as verify and the restore read them. */
const site: FetchLike = async (input) => {
  const url = new URL(String(input));
  if (url.host === "api.github.com") {
    return Response.json({
      default_branch: "main",
      private: true,
      workflow_runs: [
        {
          id: 42,
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/acme/shop/actions/runs/42",
          head_sha: "abc123",
          created_at: DEPLOYED_AT,
        },
      ],
    });
  }
  if (url.protocol === "http:") {
    return new Response(null, { status: 308, headers: { location: `https://${url.host}/` } });
  }
  if (url.pathname === "/.env" || url.pathname === "/.git/config") {
    return new Response("not found", { status: 404 });
  }
  return new Response("ok", {
    headers: {
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
};

/** The app's server over SSH as the deploy user: the app and its database run; the rest is ready. */
function server(host: string): RemoteExec {
  const ready = readyRemote(host);
  const ok = (stdout: string): CommandResult => ({
    exitCode: 0,
    stdout: `${stdout}\n`,
    stderr: "",
  });
  return {
    host,
    run: async (command, options) => {
      if (command.startsWith("docker ps -a --filter label=com.docker.compose.project=shop")) {
        return ok("shop-app-1|running\nshop-db-1|running");
      }
      return ready.run(command, options);
    },
  };
}

/** OVHcloud's prices for the plan's model and its snapshots, as its catalogue gives them. */
const catalog = (): ComputeCatalog => ({
  provider: "ovhcloud",
  listOffers: async (location) => [
    {
      provider: "ovhcloud",
      id: "d2-2",
      vcpus: 1,
      memoryGb: 2,
      diskGb: 25,
      cpuType: "shared",
      architecture: "x86",
      location: location ?? "GRA11",
      monthly: { amount: 7.59, currency: "EUR" },
      pricesIncludeVat: false,
      deprecated: false,
      available: true,
      source: "static",
      asOf: "2026-11-21T00:00:00.000Z",
    },
  ],
  extras: async () => ({
    snapshotPerGbMonth: { amount: 0.011, currency: "EUR" },
    pricesIncludeVat: false,
    source: "static",
    asOf: "2026-11-21T00:00:00.000Z",
  }),
});

/** An OVHcloud app behind Cloudflare, its fakes and the git repository it lives in. */
async function ovhcloudProject() {
  const created = await createProject(
    testPlan({ provider: "ovhcloud", domain: "shop.example.com", userSecret: false }),
  );
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: created.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(created.root, ".home-opscrew"),
      GITHUB_TOKEN: fakeSecret("github-token"),
      ...OVH_ENV,
    },
    runner: projectRunner(),
    approvalHandler: handler,
    fetch: site,
  });
  const engine = new FakeEngine({
    planJson: ovhcloudPlanJson({ proxied: true }),
    changes: OVH_CREATE,
    outputs: {
      server_ipv4: SERVER_IPV4,
      server_ipv6: SERVER_IPV6,
      server_id: OVH_SERVER_ID,
      server_name: "shop",
      url: "https://shop.example.com",
    },
  });
  const servers = new FakeServers([], "ovhcloud");
  const github = new FakeGitHub();
  const cloudflare = fakeCloudflare();
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }), servers },
    github,
    cloudflare,
    tcpConnect: async () => true,
    remote: server,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    otherApps: { inspect: noOtherApps },
  };
  return { ...created, deps, handler, engine, servers, github, cloudflare, services };
}

type Project = Awaited<ReturnType<typeof ovhcloudProject>>;

/** The services of `snapshot --server` and `restore --server`, with OVHcloud's server API. */
function snapshotServices(p: Project) {
  return {
    remote: server,
    github: p.github,
    serverSnapshots: () => p.servers,
    catalog,
    sleep: async () => undefined,
    otherApps: { inspect: noOtherApps },
  };
}

/**
 * No rendered or committed file holds the project's id, and none of the four values was shown,
 * audited, asked about, committed or sent to GitHub.
 */
async function expectNoLeaks(p: Project): Promise<void> {
  const listed = await p.git(
    p.root,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  );
  for (const path of listed.split("\0").filter((name) => name !== "")) {
    expect(await readFile(join(p.root, path), "utf8"), path).not.toContain(OVH_PROJECT);
  }
  const history = await p.git(p.root, "log", "--all", "-p", "--format=%H %s");
  expect(history).not.toContain(OVH_PROJECT);
  const said = [
    p.deps.reporter.text(),
    JSON.stringify(p.deps.audit.entries),
    JSON.stringify(p.handler.requests),
    JSON.stringify([...p.github.secrets, ...p.github.variables]),
    JSON.stringify([...p.github.environments].map(([name, secrets]) => [name, [...secrets]])),
    history,
  ].join("\n");
  for (const value of SECRET_VALUES) expect(said).not.toContain(value);
}

// One project for the whole flow: each step runs on what the one before left.
describe.skipIf(!findExecutable("git"))("an OVHcloud app through OpsCrew's flows (SC-3501)", () => {
  let p: Project;

  it("provisions, verifies, reports, secures, checks drift and snapshots, leaking none of the four values", async () => {
    p = await ovhcloudProject();
    const variable = 'variable "ovhcloud_project_id" {';

    // provision: the engine gets the project's id from the environment, never from a file.
    const provisioned = await runProvision(p.deps, { services: p.services });
    expect(provisioned.applied).toBe(true);
    expect(p.engine.planOptions[0]?.env?.TF_VAR_ovhcloud_project_id).toBe(OVH_PROJECT);
    expect(p.engine.planOptions[0]?.vars ?? {}).not.toHaveProperty("ovhcloud_project_id");
    const infra = join(p.root, "opscrew/infra/prod");
    expect(await readFile(join(infra, "variables.tf"), "utf8")).toContain(variable);
    expect(await readFile(join(infra, "terraform.tfvars.json"), "utf8")).not.toContain(
      "ovhcloud_project_id",
    );
    // SecOps's checks of the plan, on the instance and its security group, all pass.
    const saved = await findSavedPlan(p.deps.paths.files.plansDir, provisioned.planHash ?? "");
    const onInstance = saved?.policy.filter((r) => r.resource === OVH_ADDRESSES.server);
    expect(onInstance?.map((r) => [r.policyId, r.passed])).toEqual([
      ["firewall-attached", true],
      ["ssh-keys-set", true],
    ]);
    expect(saved?.policy.filter((r) => !r.passed)).toEqual([]);

    // The pull request merged on GitHub and pulled into main; the first apply's records live.
    const merged = await p.git(p.root, "rev-parse", DEPLOY_SETUP_BRANCH);
    await p.git(p.bare, "update-ref", "refs/heads/main", merged);
    await p.git(p.root, "checkout", "-q", "main");
    await p.git(p.root, "merge", "-q", "--ff-only", DEPLOY_SETUP_BRANCH);
    p.cloudflare.state.records.push(
      opscrewRecord("shop.example.com", "A", SERVER_IPV4),
      opscrewRecord("shop.example.com", "AAAA", SERVER_IPV6),
    );
    p.engine.scenario.changes = [];
    await writeFakeState(p.deps.paths);

    // verify: the site behind Cloudflare answers, and every check passes.
    const verified = await runVerify(p.deps, {
      resolver: {
        resolve4: async () => [CLOUDFLARE_IPV4],
        resolve6: async () => [CLOUDFLARE_IPV6],
      },
      tlsConnect: async () => ({
        subjectCommonName: "shop.example.com",
        subjectAltNames: ["shop.example.com"],
        validFrom: "2026-10-01T00:00:00.000Z",
        validTo: "2026-12-30T00:00:00.000Z",
        issuer: "Let's Encrypt",
      }),
      tcpConnect: async () => false,
      cloudflareRanges: CLOUDFLARE_RANGES,
    });
    expect(verified.checks.filter((check) => check.status === "fail")).toEqual([]);

    // status: the app's components on the server.
    const plan = await readArtifact("plan", p.deps.paths.files.plan);
    const status = await componentStatusReport(p.deps, plan, {
      services: { ...p.services, deploys: null },
    });
    expect(status.lines.join("\n")).toContain("The web process (app): running");

    // secure: SecOps's checks of the instance pass.
    const secured = await runSecure(p.deps, {
      planJson: ovhcloudPlanJson({ proxied: true }),
      remote: server(SERVER_IPV4),
      tcpConnect: async (_host, port) => [22, 80, 443].includes(port),
      scanners: [],
      offline: true,
      ipv6Route: async () => false,
    });
    expect(
      secured.policies
        ?.filter((r) => r.resource === OVH_ADDRESSES.server)
        .map((r) => [r.policyId, r.passed]),
    ).toEqual([
      ["firewall-attached", true],
      ["ssh-keys-set", true],
    ]);
    expect(secured.policies?.filter((r) => !r.passed)).toEqual([]);

    // drift: nothing changed outside OpsCrew; the engine gets the project's id again.
    const plans = p.engine.planOptions.length;
    const drift = await runDrift(p.deps, { services: p.services });
    expect(drift.drift).toEqual([]);
    expect(drift.pending).toEqual([]);
    expect(drift.files).toEqual({ changed: [], created: [] });
    const driftPlans = p.engine.planOptions.slice(plans);
    expect(driftPlans.length).toBeGreaterThan(0);
    for (const options of driftPlans) {
      expect(options?.env?.TF_VAR_ovhcloud_project_id).toBe(OVH_PROJECT);
    }

    // snapshot --server, through OVHcloud's server API.
    const taken = await takeServerSnapshot(p.deps, { services: snapshotServices(p) });
    expect(taken).toMatchObject({
      id: OVH_SNAPSHOT_ID,
      server: { provider: "ovhcloud", id: OVH_SERVER_ID, name: "shop" },
    });
    expect(p.servers.snapshots.map((s) => s.serverId)).toEqual([OVH_SERVER_ID]);

    await expectNoLeaks(p);
  }, 120_000);

  it("restores the server from that snapshot through OVHcloud's server API, leaking none of the four values", async () => {
    // OVHcloud lists the snapshot it took, by its id (a UUID, as all OVHcloud ids).
    p.servers.snapshotsOf = { [OVH_SERVER_ID]: [OVH_SNAPSHOT_ID] };
    const restored = await restoreServerSnapshot(p.deps, OVH_SNAPSHOT_ID, {
      services: snapshotServices(p),
    });
    expect(restored).toMatchObject({ id: OVH_SNAPSHOT_ID, checked: true });
    expect(p.servers.rebuilt).toEqual([{ serverId: OVH_SERVER_ID, snapshotId: OVH_SNAPSHOT_ID }]);

    await expectNoLeaks(p);
  }, 60_000);
});

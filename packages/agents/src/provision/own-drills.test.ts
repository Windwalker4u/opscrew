// Feature 029: the scheduled restore drills in the host plan of a server the user owns (T2944).
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { type HostFacts, HostFactsSchema, type HostPlan } from "@opscrew/connector-ssh-host";
import { canonicalJson, findExecutable, sha256Hex } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { PortainerServices } from "../portainer";
import { recordOwnServer } from "../shared";
import { ensureDeployKey } from "../shared/ssh-keys";
import {
  createProject,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeGitHub,
  FakeHostServer,
  fakeSharedCloudflare,
  freshFacts,
  OWN_IPV4,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  publicOutputs,
  ScriptedApprovalHandler,
} from "../testing";
import { applyOwnHostPlan, prepareOwnServer } from "./own";

/** The line the drills step writes in the deploy user's crontab (`drillCronLine` in ssh-host). */
const CRON_LINE =
  "30 * * * * sh /srv/apps/shop/snapshot.sh drill scheduled > /dev/null 2>&1 # opscrew-drill shop";

/** `ownPlan` with a value of the user's own, the snapshot schedule and, unless `off`, weekly drills. */
function drilledPlan(off = false): DeployPlan {
  const base = ownPlan();
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, env: [...base.app.env, { name: "API_KEY", secret: true, source: "user" }] },
    snapshots: {
      schedule: { every: "daily", keep: 2 },
      ...(off ? {} : { drills: { schedule: "weekly" } }),
    },
  });
}

async function setup(plan: DeployPlan, facts: HostFacts = freshFacts()) {
  const project = await createProject(plan);
  const host = new FakeHostServer(facts);
  const handler = new ScriptedApprovalHandler(() => true);
  const home = await mkdtemp(join(tmpdir(), "opscrew-own-home-"));
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew") },
    runner: ownRunner(),
    approvalHandler: handler,
    interactive: false,
  });
  await recordOwnServer(deps.paths, {
    host: OWN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    reachable: true,
  });
  const services: PortainerServices = {
    engine: async () => new OwnEngine(PUBLIC_CHANGES, publicOutputs()),
    github: new FakeGitHub(),
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host, homeDir: home },
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
  };
  /** Provision's host plan of the server: prepared, approved and applied. */
  const hostPlan = async (deployPlan: DeployPlan = plan) => {
    const deployKey = (await ensureDeployKey(deps.paths, deps.redactor)).publicKeyOpenSsh;
    const run = await prepareOwnServer(deps, {
      plan: deployPlan,
      options: { hostKey: ED25519_FINGERPRINT },
      services,
      deployPublicKey: deployKey,
      deployKeyFile: deps.paths.files.deployKey,
      phase: "provision",
      command: "opscrew provision",
    });
    return applyOwnHostPlan(deps, run, {
      plan: deployPlan,
      outputs: publicOutputs(),
      deployPublicKey: deployKey,
      phase: "provision",
      command: "opscrew provision",
    });
  };
  return { ...project, deps, host, handler, hostPlan };
}

function drillsOf(plan: HostPlan | undefined) {
  return plan?.steps.find((step) => step.id === "drills");
}

/** The facts of `facts`'s server once the drills of `plan`'s step are on it as planned. */
function withDrills(facts: HostFacts, plan: HostPlan | undefined): HostFacts {
  const params = drillsOf(plan)?.params ?? {};
  const files = Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => key.startsWith("file:"))
      .map(([key, text]) => [key.slice("file:".length), sha256Hex(String(text))]),
  );
  return HostFactsSchema.parse({
    ...facts,
    drills: [
      {
        app: "shop",
        recipe: true,
        files,
        values: { mode: "600", sha256: String(params.valuesSha256) },
        cron: [CRON_LINE],
        left: false,
      },
    ],
  });
}

describe.skipIf(!findExecutable("git"))(
  "scheduled restore drills on a server the user owns",
  () => {
    it("installs the recipe in the host plan, approved like a destroy with shop-drill typed, its values on stdin only", async () => {
      const s = await setup(drilledPlan());
      const value = randomBytes(16).toString("hex");
      const values = `API_KEY=${value}\n`;
      await writeFile(join(s.root, ".env.preview"), values);
      const outcome = await s.hostPlan();

      const request = s.handler.requests.find((item) => item.kind === "host-apply");
      expect(request?.allowDestroy).toBe(true);
      expect(request?.confirmPhrase).toBe("shop-drill");
      const [apply] = s.host.applies;
      const step = drillsOf(apply?.plan);
      expect(step?.state).toBe("change");
      expect(apply?.plan.deleteData).toBe(true);
      // The copy's files: the app's image by its repository, the generated values the server's
      // placeholders, values.env read before app.env, and the schedule.
      const compose = String(step?.params["file:compose.yaml"]);
      expect(compose).toContain(`image: ghcr.io/acme/shop@sha256:${"0".repeat(64)}`);
      expect(compose).toContain("- values.env");
      expect(compose).toContain("internal: true");
      expect(String(step?.params["file:app.env"])).toMatch(/@SECRET:/);
      expect(step?.params["file:schedule"]).toBe("weekly\n");
      expect(step?.params.valuesSha256).toBe(sha256Hex(values));
      // The values reach the adapter only as the apply's secret.
      expect(apply?.options.secrets?.previewValues).toBe(values);
      expect(outcome.applied).toBe(true);

      // Leaks: no value in the plan, the saved plans, what was printed or audited.
      const plans = join(s.deps.paths.root, ".opscrew", "plans");
      const saved = await Promise.all(
        (await readdir(plans)).map((name) => readFile(join(plans, name), "utf8")),
      );
      for (const text of [
        canonicalJson(apply?.plan),
        ...saved,
        s.deps.reporter.text(),
        JSON.stringify(s.deps.audit.entries),
        JSON.stringify(s.handler.requests),
      ]) {
        expect(text).not.toContain(value);
      }
      expect(s.deps.redactor.redact(`x ${value} y`)).not.toContain(value);

      // On the next plan the drills are in place: no destroy to approve.
      s.host.facts = withDrills(s.host.facts, apply?.plan);
      s.handler.requests.length = 0;
      const second = await s.hostPlan();
      expect(drillsOf(second.plan)?.state).toBe("in-place");
      expect(second.plan.deleteData).toBeUndefined();
      expect(s.handler.requests.some((item) => item.confirmPhrase === "shop-drill")).toBe(false);
    });

    it("without .env.preview: an empty values file, and the copy reads app.env alone", async () => {
      const s = await setup(drilledPlan());
      await s.hostPlan();
      const [apply] = s.host.applies;
      const step = drillsOf(apply?.plan);
      expect(step?.params.valuesSha256).toBe(sha256Hex(""));
      expect(String(step?.params["file:compose.yaml"])).not.toContain("values.env");
      expect(apply?.options.secrets?.previewValues).toBe("");
    });

    it("schedule off: the host plan removes the drills, approved with shop-drill typed, no values sent", async () => {
      const s = await setup(drilledPlan());
      await s.hostPlan();
      s.host.facts = withDrills(s.host.facts, s.host.applies[0]?.plan);
      s.handler.requests.length = 0;
      await s.hostPlan(drilledPlan(true));
      const apply = s.host.applies.at(-1);
      expect(drillsOf(apply?.plan)).toMatchObject({
        state: "change",
        params: { app: "shop", remove: true },
      });
      const request = s.handler.requests.find((item) => item.kind === "host-apply");
      expect(request?.allowDestroy).toBe(true);
      expect(request?.confirmPhrase).toBe("shop-drill");
      expect(apply?.options.secrets).not.toHaveProperty("previewValues");
    });

    it("plans no drills without a schedule, and asks for no typed name", async () => {
      const s = await setup(drilledPlan(true));
      await s.hostPlan();
      expect(drillsOf(s.host.applies[0]?.plan)).toBeUndefined();
      const request = s.handler.requests.find((item) => item.kind === "host-apply");
      expect(request?.allowDestroy).toBeUndefined();
    });
  },
);

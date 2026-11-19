/**
 * A second app's provision on the server OpsCrew created for the first app (feature 030, plan 8.):
 * the DNS-only root with the first app's address, the host plan of its own steps through the
 * first app's deploy login, `own.joined` once its own key is on the server, the deploy secrets,
 * and the shared-access warning in the approval. Then its unchanged commands: provision again,
 * drift of its own parts, and `rotate deploy-key`, which keeps every other line.
 */
import { rm } from "node:fs/promises";
import { DEPLOY_SECRETS, IMAGES } from "@opscrew/iac-templates";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { sharedAccessWarning } from "../design/own";
import { ownHostDrift } from "../drift/host";
import { ownHostPlans } from "../rotate/keys";
import { knownHostsName, readOwnServer } from "../shared";
import { generateEd25519KeyPair } from "../shared/ssh-keys";
import { ED25519, ED25519_FINGERPRINT, SERVER_IPV4 } from "../testing";
import {
  BEFORE,
  everythingSeen,
  inventoryPlan,
  kinds,
  type SecondAppProject,
  secondAppProject,
} from "./__fixtures__/second-app";
import { runProvision } from "./run";

/** Provisions the second app (every plan approved) and forgets what was asked. */
async function provisioned(): Promise<SecondAppProject> {
  const s = await secondAppProject();
  await runProvision(s.deps, { services: s.services });
  // The deploy pull request merged, as before a later provision.
  await s.git(s.root, "checkout", "-q", "main");
  await s.git(s.root, "merge", "-q", "opscrew/deploy-setup");
  s.engine.changes = [];
  s.handler.requests.length = 0;
  return s;
}

/** The `-i` key files of every ssh call since `from`. */
function keyFiles(s: SecondAppProject, from = 0): string[] {
  return s.runner.calls
    .slice(from)
    .filter((call) => call.command === "ssh")
    .flatMap((call) => {
      const at = call.args.indexOf("-i");
      return at < 0 ? [] : [call.args[at + 1] as string];
    });
}

/** Neither the first app's deploy key nor the server's address leaks. */
async function expectNoLeak(s: SecondAppProject): Promise<void> {
  const seen = await everythingSeen(s);
  expect(seen).not.toContain(s.shared.firstKey);
  const printed = `${s.deps.reporter.text()}\n${JSON.stringify(s.deps.audit.entries)}`;
  expect(printed).not.toContain(SERVER_IPV4);
  // The first app's key file is read by path only: never kept in the second app's state.
  expect(JSON.stringify(await readOwnServer(s.deps.paths))).not.toContain(
    s.shared.first.files.deployKey,
  );
}

describe("a second app's provision", () => {
  it("points DNS at the first app's server, applies only its own steps as the first app's deploy login, then joins", async () => {
    const s = await secondAppProject();
    const result = await runProvision(s.deps, { services: s.services });

    expect(kinds(s)).toEqual([
      "cloudflare-apply",
      "repo-write",
      "iac-apply",
      "host-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    // The own DNS root: its records point at the first app's address, given only as TF_VAR_*.
    for (const env of s.engine.envs) expect(env.TF_VAR_server_ipv4).toBe(SERVER_IPV4);
    expect(s.engine.applies).toHaveLength(1);

    // The host plan: only the app's own steps, as the deploy login, its record through Docker.
    expect(s.host.applies).toHaveLength(1);
    const apply = s.host.applies[0];
    expect(apply?.options.approvedHash).toBe(result.hostPlanHash);
    expect(apply?.options.rootImage).toBe(IMAGES.caddy.ref);
    expect(apply?.plan.steps.map((step) => [step.id, step.state, step.params.runAs])).toEqual([
      ["deploy-key", "change", "login"],
      ["app-dirs", "change", "login"],
      ["app-record", "change", undefined],
    ]);
    expect(apply?.plan.steps.find((step) => step.id === "app-record")?.params.shares).toBe("shop");
    // Every other line of authorized_keys stays, in its order; the app's own key follows.
    expect(s.host.facts.deployUser?.keys).toEqual([...BEFORE, s.key.publicKeyOpenSsh]);

    // The approval names the server as the first app's and warns of the shared deploy user.
    const host = s.handler.requests.find((request) => request.kind === "host-apply");
    expect(host?.title).toBe('Apply the host plan to the server of "shop" (3 changes)');
    expect(host?.details).toContain(sharedAccessWarning("shop"));
    expect(host?.details).toContain('Host plan for the server of "shop"');
    expect(sharedAccessWarning("shop")).toBe(
      `Anyone who can change this app's deploy workflow or its deploy key can reach the data and secrets of "shop" too: both apps run on the server as the same deploy user, which can become root through Docker. Share the server only between apps the same people may change.`,
    );

    // Logged in as deploy with the first app's key (by path) until its own key was installed.
    expect(keyFiles(s)).toContain(s.shared.first.files.deployKey);
    expect(await readOwnServer(s.deps.paths)).toEqual({
      host: SERVER_IPV4,
      port: 22,
      user: "deploy",
      agent: false,
      keyPath: s.key.privateKeyFile,
      hostKey: ED25519_FINGERPRINT,
      publicIpv4: SERVER_IPV4,
      shares: s.shared.ref,
      joined: true,
    });

    // GitHub's machines reach the first app's address with its pinned key, as this app.
    expect(s.github.secrets.get(DEPLOY_SECRETS.host)).toBe(SERVER_IPV4);
    expect(s.github.secrets.get(DEPLOY_SECRETS.knownHosts)).toBe(
      `${knownHostsName(SERVER_IPV4)} ssh-ed25519 ${ED25519}\n`,
    );
    expect(s.github.secrets.get(DEPLOY_SECRETS.sshKey)).toBe(s.key.privateKeyOpenSsh);
    await expectNoLeak(s);
  });

  it("shows no changes when it runs again, logged in with its own key", async () => {
    const s = await provisioned();
    const calls = s.runner.calls.length;
    await runProvision(s.deps, { services: s.services });

    expect(kinds(s)).not.toContain("iac-apply");
    expect(kinds(s)).not.toContain("host-apply");
    expect(s.host.applies).toHaveLength(1);
    expect(s.deps.reporter.text()).toContain(
      '"inventory" is already set up on the server of "shop"; nothing on it changes.',
    );
    const used = keyFiles(s, calls);
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((file) => file === s.key.privateKeyFile)).toBe(true);
    expect(s.host.facts.deployUser?.keys).toEqual([...BEFORE, s.key.publicKeyOpenSsh]);
    await expectNoLeak(s);
  });

  it("never joins in a --plan-only run, even with its key in place already; a run that applies does", async () => {
    const s = await secondAppProject();
    // The app's own key is on the server already: its deploy-key step is in place.
    const facts = structuredClone(s.host.facts);
    if (facts.deployUser !== null) facts.deployUser.keys = [...BEFORE, s.key.publicKeyOpenSsh];
    s.host.facts = facts;
    const result = await runProvision(s.deps, { services: s.services, planOnly: true });
    expect(result.applied).toBe(false);
    expect(s.host.applies).toEqual([]);
    expect((await readOwnServer(s.deps.paths))?.joined).toBeUndefined();

    await runProvision(s.deps, { services: s.services });
    const key = s.host.applies[0]?.plan.steps.find((step) => step.id === "deploy-key");
    expect(key?.state).toBe("in-place");
    expect((await readOwnServer(s.deps.paths))?.joined).toBe(true);
  });

  it("joins only after the host plan applied: a failed apply logs in with the first app's key again", async () => {
    const s = await secondAppProject();
    s.host.fail = new Error("the server went away");
    await expect(runProvision(s.deps, { services: s.services })).rejects.toThrow(
      "the server went away",
    );
    expect((await readOwnServer(s.deps.paths))?.joined).toBeUndefined();

    const calls = s.runner.calls.length;
    await runProvision(s.deps, { services: s.services });
    expect(keyFiles(s, calls)).toContain(s.shared.first.files.deployKey);
    expect((await readOwnServer(s.deps.paths))?.joined).toBe(true);
    await expectNoLeak(s);
  });

  it("adds the repository's scheduled check key as its deploy login, never as root", async () => {
    const s = await secondAppProject();
    const plan = DeployPlanSchema.parse({
      ...inventoryPlan(),
      observability: { check: { enabled: true } },
    });
    await writeArtifact("plan", s.deps.paths.files.plan, plan);
    await runProvision(s.deps, { services: s.services });
    const check = s.host.applies
      .flatMap((apply) => apply.plan.steps)
      .find((step) => step.id === "check-key");
    expect(check?.params.runAs).toBe("login");
    await expectNoLeak(s);
  });

  it("compares with the first app's plan: without its folder, provision stops before any change", async () => {
    const s = await provisioned();
    await rm(s.shared.ref.root, { recursive: true, force: true });
    await expect(runProvision(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(
        /has no OpsCrew plan on this computer\. Nothing was changed\.$/,
      ),
    });
    expect(s.handler.requests).toEqual([]);
    expect(s.host.applies).toHaveLength(1);
  });
});

describe("a second app's unchanged commands", () => {
  it("drift finds nothing of its own parts once provisioned, and its own key line gone as one", async () => {
    const s = await provisioned();
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    const options = { own: s.services.own ?? {}, cloudflare: s.services.cloudflare ?? null };
    expect((await ownHostDrift(s.deps, plan, options)).differences).toEqual([]);

    const facts = structuredClone(s.host.facts);
    if (facts.deployUser !== null) facts.deployUser.keys = [...BEFORE];
    s.host.facts = facts;
    const drift = await ownHostDrift(s.deps, plan, options);
    expect(drift.differences.map((difference) => difference.area)).toEqual(["deploy-key"]);
    await expectNoLeak(s);
  });

  it("rotate deploy-key keeps every other line of authorized_keys, the old key until the removal", async () => {
    const s = await provisioned();
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    const rotate = ownHostPlans(s.deps, plan, "opscrew rotate deploy-key", {
      provision: s.services,
    });
    const old = s.key.publicKeyOpenSsh;
    const next = generateEd25519KeyPair("opscrew-deploy@inventory").publicKeyOpenSsh;

    await rotate({ server: "app", deployKey: next, previousDeployKey: old });
    expect(s.host.facts.deployUser?.keys).toEqual([...BEFORE, next, old]);
    const record = s.host.facts.apps.find((item) => item.name === "inventory")?.record;
    expect(record).toMatchObject({
      deployKey: next,
      previousDeployKey: old,
      shares: { app: "shop" },
    });

    await rotate({ server: "app", deployKey: next });
    expect(s.host.facts.deployUser?.keys).toEqual([...BEFORE, next]);
    for (const apply of s.host.applies.slice(1)) {
      expect(apply.plan.steps.map((step) => step.id)).toEqual([
        "deploy-key",
        "app-dirs",
        "app-record",
      ]);
      expect(apply.options.rootImage).toBe(IMAGES.caddy.ref);
    }
    await expectNoLeak(s);
  });
});

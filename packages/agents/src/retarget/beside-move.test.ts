/**
 * A move onto the server OpsCrew created for another app, step by step (feature 030, US6, plan
 * 16.): the new side's host plan is the second app's, through the first app's deploy login and
 * approved by its hash; deploy, copy and switch run as for any own new side, with the shared edge
 * kept running; `--abort` removes only the moving app's parts there and `--finish` the old side
 * through its usual path.
 */
import { readFile } from "node:fs/promises";
import { findExecutable } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { sharedAccessWarning } from "../design/own";
import { BEFORE } from "../provision/__fixtures__/second-app";
import { readServerAddresses, serverAddressesFile } from "../shared";
import { SECOND_APP_ROOT_IMAGE } from "../shared/own-server";
import { APP, ED25519, OLD_IDS, OLD_IPV4, OLD_IPV6, TOKENS } from "../testing";
import { crashAfter, expectGated, trail } from "./__fixtures__/assert";
import {
  type BesidePair,
  type BesideStart,
  besidePair,
  besideStart,
  everythingSeen,
  FIRST,
  FIRST_ADDRESS,
  IMAGE_FILES,
  KEPT_FILES,
  KEPT_FOLDER,
  mountKeptFolder,
  OLD_FIRST,
  type OldSide,
  printed,
  useOldServer,
} from "./__fixtures__/beside";
import { abortRetarget } from "./abort";
import { finishRetarget } from "./finish";
import { runRetarget } from "./run";

/** The `-i` key files of the ssh calls of `h`'s runner, from call `from` on. */
function keyFiles(h: BesideStart | BesidePair, from = 0): string[] {
  const calls = (h.deps.runner as unknown as { calls: { command: string; args: string[] }[] })
    .calls;
  return calls
    .slice(from)
    .filter((call) => call.command === "ssh")
    .flatMap((call) => {
      const at = call.args.indexOf("-i");
      return at < 0 ? [] : [call.args[at + 1] as string];
    });
}

/** The ssh calls so far. */
function sshCalls(h: BesideStart | BesidePair): number {
  return (h.deps.runner as unknown as { calls: unknown[] }).calls.length;
}

/** The files of the kept folder's volume on the Docker at `ip`. */
function keptFiles(h: BesideStart, ip: string): string[] {
  const volume = h.hosts.docker(ip).volumes.get(`${APP}_files`);
  return [...(volume?.files.keys() ?? [])].filter(Boolean).sort();
}

/** The operations on the first app's server, by the move's trail. */
function opsOnFirstServer(h: BesideStart | BesidePair): string[] {
  return h.events.flatMap((e) =>
    e.type === "remote" && e.host === FIRST_ADDRESS.ipv4 ? [e.op] : [],
  );
}

/** The steps a second app's host plans may hold: its own parts only. */
const OWN_PARTS = ["deploy-key", "app-dirs", "app-record", "drills", "github-runner"];

/**
 * The first app's parts are in no plan the first app's server got: every step is one of the
 * moving app's own, for that app.
 */
function expectOnlyTheMovingApp(h: BesideStart | BesidePair): void {
  for (const { plan } of h.server.applies) {
    expect(plan.app).toBe(APP);
    for (const step of plan.steps) {
      expect(OWN_PARTS).toContain(step.id);
      expect([undefined, APP]).toContain(step.params.app);
    }
  }
}

/** No address, key or token where none belongs, and the first app's deploy key nowhere. */
async function expectNoLeaks(h: BesideStart | BesidePair): Promise<void> {
  expectOnlyTheMovingApp(h);
  const shown = await printed(h);
  const movingKey = (await readFile(h.paths.files.deployKey, "utf8")).trim();
  for (const secret of [
    OLD_IPV4,
    OLD_IPV6,
    FIRST_ADDRESS.ipv4,
    FIRST_ADDRESS.ipv6 ?? "",
    movingKey,
    h.first.key,
    h.first.paths.files.deployKey,
    TOKENS.hetzner,
    TOKENS.cloudflare,
  ]) {
    expect(shown).not.toContain(secret);
  }
  // The first app's deploy key is read by its path only: never copied, sent or recorded here.
  expect(await everythingSeen(h)).not.toContain(h.first.key);
  const local = await readFile(serverAddressesFile(h.paths), "utf8");
  expect(local).not.toContain(h.first.paths.files.deployKey);
  expect(JSON.stringify([...h.github.secrets.values()])).not.toContain(
    h.first.paths.files.deployKey,
  );
}

describe.skipIf(!findExecutable("git"))(
  "a whole move from a Hetzner server beside another app",
  () => {
    it("sets the app up as the server's second app, deploys, copies and switches, then --finish deletes the old server", async () => {
      const h = await besideStart("hetzner");
      // The app's kept folder (its runtime installs) is on the old side; the new side's deploy
      // makes its volume, which Docker seeds from the image.
      mountKeptFolder(h, OLD_IPV4, KEPT_FILES);
      const deploy = h.hosts.deploy.bind(h.hosts);
      h.hosts.deploy = (ip) => {
        deploy(ip);
        mountKeptFolder(h, ip, IMAGE_FILES);
      };
      const result = await runRetarget(h.deps, {
        services: h.services,
        to: "own",
        sharedServer: h.first.ref,
        confirmStart: async () => true,
      });
      expect(result).toMatchObject({ step: "switched", done: true });
      expectGated(h.events);

      // One host plan on the first app's server: the second app's, approved by its hash.
      expect(h.server.applies).toHaveLength(1);
      const [setup] = h.server.applies;
      expect(setup?.plan.purpose).toBe("setup");
      expect(setup?.plan.steps.map((step) => step.id)).toEqual([
        "deploy-key",
        "app-dirs",
        "app-record",
      ]);
      expect(setup?.options.rootImage).toBe(SECOND_APP_ROOT_IMAGE);
      const approval = h.handler.requests.find((r) => r.kind === "host-apply");
      expect(approval?.planHash).toBe(setup?.options.approvedHash);
      expect(approval?.details).toContain(sharedAccessWarning(FIRST));
      // Only the app's own key line is added: every line there before stays, in its order.
      const key = (await readFile(h.paths.files.deployKeyPub, "utf8")).trim();
      expect(h.server.facts.deployUser?.keys).toEqual([...BEFORE, key]);
      expect(h.server.facts.apps.map((app) => [app.name, app.record?.shares])).toEqual([
        [APP, { app: FIRST }],
      ]);
      // Logged in with the first app's deploy key (read by path) until the app's own was there.
      expect(keyFiles(h)).toContain(h.first.paths.files.deployKey);
      const local = await readServerAddresses(h.paths);
      expect(local.own).toMatchObject({ shares: h.first.ref, joined: true });

      // The deploy secrets point at the first app's server, with the app's own key.
      expect(h.github.secrets.get("OPSCREW_HOST")).toBe(FIRST_ADDRESS.ipv4);
      expect(h.github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(
        `${FIRST_ADDRESS.ipv4} ssh-ed25519 ${ED25519}\n`,
      );
      expect(h.github.secrets.get("OPSCREW_SSH_PRIVATE_KEY")).toBe(
        await readFile(h.paths.files.deployKey, "utf8"),
      );
      // The shared edge never stops there: it is reloaded once DNS switched.
      const ops = opsOnFirstServer(h);
      expect(ops).toContain("reload edge");
      expect(ops.filter((op) => /^(stop|start) (caddy|nginx)$/.test(op))).toEqual([]);
      expect(h.reporter.text()).toContain("other apps there use it too");
      // The first app's container was never touched.
      const blog = [...h.hosts.docker(FIRST_ADDRESS.ipv4).containers.values()].find(
        (c) => c.name === `${FIRST}-app-1`,
      );
      expect(blog?.state).toBe("running");

      // The window copied the database and the kept folder as they are, never seeded anew.
      expect(h.hosts.host(FIRST_ADDRESS.ipv4).db).toBe("orders before the move");
      expect(keptFiles(h, FIRST_ADDRESS.ipv4)).toEqual(keptFiles(h, OLD_IPV4));
      expect(keptFiles(h, FIRST_ADDRESS.ipv4)).toEqual(Object.keys(KEPT_FILES).sort());
      const copied = h.hosts.docker(FIRST_ADDRESS.ipv4).volumes.get(`${APP}_files`);
      for (const [name, entry] of Object.entries(KEPT_FILES)) {
        expect(copied?.files.get(name)?.data?.toString()).toBe(entry.data?.toString());
      }
      expect(copied?.files.has("seeded-from-the-image.txt")).toBe(false);
      const window = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
      expect(window?.details).toContain(`the app's data at ${KEPT_FOLDER}`);

      // No server was created: the infrastructure plans renamed the old one and switched DNS only.
      expect(trail(h.events).filter((line) => line.startsWith("apply"))).toEqual([
        "apply moves=3",
        "apply updates=2",
      ]);
      expect(h.engine.dnsServer()?.ipv4).toBe(FIRST_ADDRESS.ipv4);
      const moving = await readArtifact("plan", h.paths.files.plan);
      expect(moving.target).toMatchObject({
        provider: "own",
        shares: { app: FIRST, provider: "hetzner" },
      });
      expect(moving.cost.monthly.amount).toBe(0);

      // --finish deletes the old server through its usual path, and nothing on the first app's.
      const finished = await finishRetarget(h.deps, { services: h.services, confirm: h.confirm });
      expect(finished).toMatchObject({ step: "finished", done: true });
      expect(h.engine.state.servers.server_previous).toBeUndefined();
      expect(h.server.applies).toHaveLength(1);
      expectGated(h.events, true);
      const after = await readServerAddresses(h.paths);
      // The reference is the app's from now on, as after a second app's provision.
      expect(after.own).toMatchObject({ shares: h.first.ref, joined: true });
      expect(after.deployment).toEqual(FIRST_ADDRESS);
      expect(after.retarget).toBeUndefined();
      const plan = await readArtifact("plan", h.paths.files.plan);
      expect(plan.retarget).toBeUndefined();
      expect(plan.target).toMatchObject({ shares: { app: FIRST } });
      await expectNoLeaks(h);
    });

    it("--abort before the switch removes only the app's parts there, and DNS stays on the old server", async () => {
      const h = await besideStart("hetzner");
      crashAfter(h, "deployed");
      await expect(
        runRetarget(h.deps, {
          services: h.services,
          to: "own",
          sharedServer: h.first.ref,
          confirmStart: async () => true,
        }),
      ).rejects.toThrow("interrupted");
      const calls = sshCalls(h);
      const result = await abortRetarget(h.deps, { services: h.services, confirm: h.confirm });
      expect(result).toMatchObject({ step: "aborted", done: true });

      expect(h.server.applies.map((a) => a.plan.purpose)).toEqual(["setup", "teardown"]);
      const teardown = h.server.applies[1];
      const ids = teardown?.plan.steps.map((step) => step.id) ?? [];
      expect(ids).toContain("deploy-key");
      for (const shared of ["edge", "check-key", "portainer"]) expect(ids).not.toContain(shared);
      expect(teardown?.plan.steps.find((s) => s.id === "app-dirs")?.params).toMatchObject({
        runAs: "login",
        image: IMAGES.busybox.ref,
      });
      // authorized_keys holds exactly the lines it held before; the first app stays.
      expect(h.server.facts.deployUser?.keys).toEqual(BEFORE);
      expect(h.server.facts.apps).toEqual([]);
      const request = h.handler.requests.find(
        (r) => r.kind === "host-apply" && r.allowDestroy === true,
      );
      expect(request).toMatchObject({ confirmPhrase: APP });
      expect(request?.details).toContain(
        `The server is the one OpsCrew created for "${FIRST}", and it stays until that app's \`opscrew destroy\`.`,
      );
      // The teardown logged in with the app's own key, never the first app's.
      const used = keyFiles(h, calls);
      expect(used.length).toBeGreaterThan(0);
      expect(used.every((file) => file === h.paths.files.deployKey)).toBe(true);
      // DNS never left the old server; only its rename was undone.
      expect(h.engine.state.dns).toBe(OLD_IDS.hetzner);
      expect(trail(h.events).filter((line) => line.startsWith("apply"))).toEqual([
        "apply moves=3",
        "apply moves=3",
      ]);
      // The reference is gone with the new side's login.
      const local = await readServerAddresses(h.paths);
      expect(local.own).toBeUndefined();
      expect(local.retarget).toBeUndefined();
      expect((await readArtifact("plan", h.paths.files.plan)).target.provider).toBe("hetzner");
      await expectNoLeaks(h);
    });
  },
);

/** The old sides the step tests move from (Hetzner's whole move is above). */
const PAIR_SIDES: readonly OldSide[] = ["digitalocean", "own", "portainer", "shared"];

describe.skipIf(!findExecutable("git"))("--abort and --finish of a move beside another app", () => {
  it.each(PAIR_SIDES)(
    "from %s: --abort removes only the app's parts on the first app's server",
    async (from) => {
      const h = await besidePair(from, { step: "deployed" });
      const before = await readServerAddresses(h.paths);
      const result = await abortRetarget(h.deps, { services: h.services, confirm: h.confirm });
      expect(result).toMatchObject({ step: "aborted", done: true });
      expect(h.server.applies.map((a) => a.plan.purpose)).toEqual(["teardown"]);
      expect(h.server.facts.deployUser?.keys).toEqual(BEFORE);
      expect(h.server.facts.apps).toEqual([]);
      const local = await readServerAddresses(h.paths);
      // The old side's login is back in its slot; the new side's, and its reference, are gone.
      expect(local.own).toEqual(
        from === "own" || from === "shared" ? before.retarget?.fromOwn : undefined,
      );
      expect(local.retarget).toBeUndefined();
      const plan = await readArtifact("plan", h.paths.files.plan);
      expect(plan.retarget).toBeUndefined();
      expect(plan.target.provider).toBe(h.plan.retarget?.from.target.provider);
      await expectNoLeaks(h);
    },
  );

  it("--abort before the host plan was applied logs in with the first app's deploy login and finds nothing to remove", async () => {
    const h = await besidePair("own", { step: "renamed" });
    const calls = sshCalls(h);
    const result = await abortRetarget(h.deps, { services: h.services, confirm: h.confirm });
    expect(result).toMatchObject({ step: "aborted", done: true });
    expect(h.server.applies).toEqual([]);
    expect(h.server.facts.deployUser?.keys).toEqual(BEFORE);
    expect(h.reporter.text()).toContain(`Nothing of ${APP} is left on the server of "${FIRST}".`);
    // Its own key is not on the server yet: the first app's deploy key, read by its path.
    expect(keyFiles(h, calls)).toContain(h.first.paths.files.deployKey);
    expect((await readServerAddresses(h.paths)).own?.host).toBe(OLD_IPV4);
    await expectNoLeaks(h);
  });

  it.each(PAIR_SIDES)(
    "from %s: --finish removes the old side through its usual path and keeps the reference",
    async (from) => {
      const h = await besidePair(from, { step: "switched" });
      const old = from === "own" || from === "shared" ? useOldServer(h, from) : undefined;
      const result = await finishRetarget(h.deps, { services: h.services, confirm: h.confirm });
      expect(result).toMatchObject({ step: "finished", done: true });
      if (from === "digitalocean") {
        expect(h.engine.state.servers.server_previous).toBeUndefined();
      }
      if (old !== undefined) {
        expect(old.applies.map((a) => a.plan.purpose)).toEqual(["teardown"]);
        const steps = old.applies[0]?.plan.steps.map((step) => step.id) ?? [];
        // A second app's old side keeps the edge there for its first app.
        if (from === "shared") expect(steps).not.toContain("edge");
        expect(old.facts.apps.find((app) => app.name === APP)).toBeUndefined();
        const request = h.handler.requests.find((r) => r.kind === "host-apply");
        expect(request?.details).toContain(
          from === "shared"
            ? `The server is the one OpsCrew created for "${OLD_FIRST}"`
            : "Your server itself stays",
        );
      }
      // Nothing changed on the first app's server.
      expect(h.server.applies).toEqual([]);
      const local = await readServerAddresses(h.paths);
      expect(local.own).toMatchObject({ shares: h.first.ref, joined: true });
      expect(local.retarget).toBeUndefined();
      expect(local.deployment).toEqual(FIRST_ADDRESS);
      const plan = await readArtifact("plan", h.paths.files.plan);
      expect(plan.retarget).toBeUndefined();
      expect(plan.target).toMatchObject({ provider: "own", shares: { app: FIRST } });
      await expectNoLeaks(h);
    },
  );
});

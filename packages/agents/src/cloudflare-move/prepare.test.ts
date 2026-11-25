import { findExecutable, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { backupsRootDir, pagesVerificationRootDir, storageRootDir } from "@opscrew/iac-templates";
import {
  type CloudflareMove,
  type DeployPlan,
  DeployPlanSchema,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { fakeUptimeAccount, provisionedUptime } from "../check/uptime.fakes";
import { environmentPaths } from "../environments/paths";
import { APP_BUCKET, BACKUPS_BUCKET } from "./buckets.fakes";
import { readMarks } from "./marks";
import {
  PREPARE_TARGETS,
  type PrepareTarget,
  type PrepareWorld,
  prepareWorld,
} from "./prepare.fakes";
import { readAppProgress } from "./progress";
import { abortingMove, advancedMove, writeMoveRecord } from "./record";
import { ZONE } from "./session.fakes";
import { SWITCH_COMMAND } from "./texts";
import type { MoveResult } from "./types";

const CF = "cloudflare-apply";

/** The approvals a whole prepare asks, in order, by target: the zone plan first, the mark last. */
const ASKED: Readonly<Record<PrepareTarget, string[]>> = {
  proxied: [CF, CF, "iac-apply", CF],
  cloud: [CF, CF, "iac-apply", "iac-apply", "iac-apply", "host-apply", "remote-exec", CF],
  "own-tunnel": [CF, CF, "iac-apply", "host-apply", "github-secrets", CF],
  "own-public": [CF, CF, "iac-apply", CF],
  portainer: [CF, CF, "iac-apply", "stack-apply", "github-secrets", CF],
  site: [CF, CF, "iac-apply", "github-secrets", CF],
  pages: [CF, CF, "iac-apply", "iac-apply", CF],
  hosting: [CF, CF, "iac-apply", CF],
};

/** The roots of `plan` whose pieces B's shadow plans create, relative to the repository. */
function rootsOf(target: PrepareTarget, plan: DeployPlan): string[] {
  const extra =
    target === "cloud"
      ? [storageRootDir(plan), backupsRootDir(plan)]
      : target === "pages"
        ? [pagesVerificationRootDir(plan)]
        : [];
  return [plan.infra.dir, ...extra];
}

/** The record of prod's plan on disk. */
async function recordOf(w: PrepareWorld, name = "prod"): Promise<CloudflareMove> {
  const move = (await w.planNow(name)).cloudflareMove;
  if (move === undefined) throw new Error(`${name} records no move`);
  return move;
}

/** How often the summary before the first change was shown. */
function summaries(w: PrepareWorld): number {
  return w.deps.reporter.lines.filter((line) => line.message.includes("Cloudflare setup of"))
    .length;
}

/** What a whole prepare of `target`'s app does, once (each target's world made once). */
const wholes = new Map<PrepareTarget, Promise<string[]>>();
function whole(target: PrepareTarget): Promise<string[]> {
  const found = wholes.get(target);
  if (found !== undefined) return found;
  const done = prepareWorld(target).then(async (w) => {
    await w.run();
    return w.done();
  });
  wholes.set(target, done);
  return done;
}

/**
 * Runs prepare as a script until it is done: each run stops with the hash of the plan it waits
 * for, recorded as waiting; the next run approves it with `--approve`.
 */
async function asScript(w: PrepareWorld): Promise<{ result: MoveResult; hashes: string[] }> {
  const hashes: string[] = [];
  let approve: string | undefined;
  for (let runs = 0; runs < 20; runs++) {
    const result = await w.run({
      interactive: false,
      ...(approve === undefined ? {} : { approvePlanHash: approve }),
    });
    if (result.done) return { result, hashes };
    approve = result.pendingPlanHash as string;
    expect(approve).toMatch(/^[0-9a-f]{64}$/);
    expect(result.next.join("\n")).toContain(`opscrew cloudflare move --approve ${approve}`);
    expect((await readAppProgress(w.deps.paths)).pending?.planHash).toBe(approve);
    hashes.push(approve);
  }
  throw new Error("prepare did not end");
}

describe.skipIf(!findExecutable("git"))("prepareMove", () => {
  it.each(PREPARE_TARGETS)("prepares %s in New while Old serves, the mark last", async (target) => {
    const w = await prepareWorld(target);
    const result = await w.run();
    expect(result).toMatchObject({ step: "prepared", done: true });
    expect(result.next.join("\n")).toContain(SWITCH_COMMAND);
    expect(w.requests.map((request) => request.kind)).toEqual(ASKED[target]);
    expect(w.requests.at(-1)?.title).toContain("zone plan");
    expect(summaries(w)).toBe(1);

    // The record: started, then prepared, with both accounts' ids.
    const plan = w.plans.prod as DeployPlan;
    const bZone = w.cloudflare.zone(ZONE, "New");
    expect(await recordOf(w)).toMatchObject({
      zone: ZONE,
      from: { accountId: w.old.id, zoneId: w.aZone.id },
      to: { accountId: w.fresh.id, zoneId: bZone.id },
      dsAtStart: false,
      step: "prepared",
      startedAt: expect.any(String),
      preparedAt: expect.any(String),
    });

    // B's zone, pending, with A's record that is no OpsCrew app's.
    expect(bZone.status).toBe("pending");
    expect(bZone.records.map((record) => `${record.type} ${record.name}`)).toContain(`MX ${ZONE}`);
    // Each root planned with B's ids and applied once.
    expect(w.engine.appliedDirs.map((dir) => toPosixRelative(w.root, dir))).toEqual(
      rootsOf(target, plan),
    );
    for (const options of w.engine.planOptions) {
      expect(options?.vars).toMatchObject({
        cloudflare_zone_id: bZone.id,
        cloudflare_account_id: w.fresh.id,
        ...(target === "site" ? { custom_domains: "false" } : {}),
      });
    }
    // The mark: the app, its environment and its hostnames.
    const { marks } = await readMarks(await w.open());
    expect(marks.map((read) => [read.mark.app, read.mark.envs])).toEqual([
      [plan.app.name, ["prod"]],
    ]);
    expect(marks[0]?.mark.hosts).toContain(plan.dns.domain);

    if (target === "cloud" || target === "own-tunnel") {
      expect(w.tunnel.connections.map((connection) => connection.id)).toEqual(["beside"]);
    }
    if (target === "portainer") {
      expect(w.portainer.stacks.map((stack) => stack.Name).sort()).toEqual([
        "opscrew-shop-portainer-tunnel-next",
        "opscrew-shop-tunnel-next",
      ]);
    }
    const secrets = Object.fromEntries(w.github.secrets);
    if (target === "own-tunnel") {
      expect(secrets).toEqual({
        OPSCREW_TUNNEL_SERVICE_TOKEN_ID_NEW: w.secrets.serviceTokenId,
        OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET_NEW: w.secrets.serviceTokenSecret,
      });
    } else if (target === "portainer") {
      expect(secrets).toEqual({
        OPSCREW_PORTAINER_ACCESS_CLIENT_ID_NEW: w.secrets.serviceTokenId,
        OPSCREW_PORTAINER_ACCESS_CLIENT_SECRET_NEW: w.secrets.serviceTokenSecret,
      });
    } else if (target === "site") {
      expect(secrets).toEqual({
        OPSCREW_CLOUDFLARE_API_TOKEN_NEW: w.secrets.deployToken,
        OPSCREW_CLOUDFLARE_ACCOUNT_ID_NEW: w.fresh.id,
      });
      expect(w.github.dispatches).toHaveLength(1);
    } else {
      expect(secrets).toEqual({});
    }
    if (target === "cloud") {
      expect([...w.r2.objects(w.fresh.id, APP_BUCKET).keys()]).toEqual(["a.png", "b.png"]);
      expect([...w.r2.objects(w.fresh.id, BACKUPS_BUCKET).keys()]).toEqual(["backups/1/db.age"]);
    }
    expect(w.wroteToA()).toBe(false);
    expect(await w.leaks(JSON.stringify(result))).toBe(false);
  });

  it("refuses an app with an uptime entry, saying to switch to the Actions check and provision first", async () => {
    const w = await prepareWorld("proxied");
    const plan = await w.planNow();
    const worker = DeployPlanSchema.parse({
      ...plan,
      observability: { check: { enabled: true, runner: "cloudflare", webhook: "slack" } },
    });
    await writeArtifact("plan", w.deps.paths.files.plan, worker);
    const refused = {
      code: "PHASE_PRECONDITION",
      message:
        "The uptime check of prod runs in the Cloudflare Worker opscrew-uptime of the current account, and a move to another Cloudflare account doesn't take it along. Nothing was changed.",
      hint: 'Set observability.check.runner to "actions" in opscrew/plan.yaml, run `opscrew provision` (it removes the Worker\'s entry), then run `opscrew cloudflare move` again.',
    };
    await expect(w.run()).rejects.toMatchObject(refused);
    expect(w.requests).toEqual([]);
    expect(w.wroteToA()).toBe(false);

    // Switched back without a provision, this computer still records the entry: still refused.
    const { client } = fakeUptimeAccount();
    await provisionedUptime(w.deps, worker, client);
    await writeArtifact("plan", w.deps.paths.files.plan, plan);
    await expect(w.run()).rejects.toMatchObject(refused);
    expect(w.requests).toEqual([]);
  });

  it("fails a site's shadow apply that lost -var custom_domains=false, as OpenTofu does", async () => {
    const w = await prepareWorld("site");
    const apply = w.engine.apply.bind(w.engine);
    w.engine.apply = (dir, planFile, approval, options = {}) => {
      const { custom_domains: _lost, ...vars } = options.vars ?? {};
      return apply(dir, planFile, approval, { ...options, vars });
    };
    const failed = await w.run().catch((error) => error);
    expect(failed).toBeInstanceOf(OpsCrewError);
    expect(failed.message).toContain("custom_domains");
    expect(w.engine.appliedDirs).toEqual([]);
  });

  it("names the other apps of the zone still to prepare, then the switch", async () => {
    const w = await prepareWorld("proxied");
    const result = await w.run();
    expect(result.next).toEqual([
      `Prepare the other OpsCrew apps in ${ZONE} too, each from the repository that deploys it (\`opscrew cloudflare move --to ${w.fresh.id}\`): blog.${ZONE} and docs.${ZONE}.`,
      `Then run \`${SWITCH_COMMAND}\` from any of these repositories to point ${ZONE} at the new account.`,
    ]);
  });

  it("a run after the end asks nothing and changes nothing", async () => {
    const w = await prepareWorld("cloud");
    await w.run();
    const before = { done: w.done(), asked: w.requests.length };
    const again = await w.run();
    expect(again).toMatchObject({ step: "prepared", done: true });
    expect({ done: w.done(), asked: w.requests.length }).toEqual(before);
    expect(summaries(w)).toBe(1);
    expect(w.wroteToA()).toBe(false);
  });

  // Between them every kind of step: the zone, shared, shadow (three roots), host, copy and mark
  // plans of a cloud server; a stack plan and secrets in Portainer; secrets and a deploy of a site.
  const INTERRUPTED: [PrepareTarget, number][] = (["cloud", "portainer", "site"] as const).flatMap(
    (target) => ASKED[target].map((_kind, index): [PrepareTarget, number] => [target, index]),
  );

  it.each(INTERRUPTED)(
    "%s interrupted at approval %i goes on in the next run and does nothing twice",
    async (target, index) => {
      const w = await prepareWorld(target);
      let asked = 0;
      await expect(
        w.run({
          answer: () => {
            if (asked++ === index) throw new Error("interrupted");
            return true;
          },
        }),
      ).rejects.toThrow("interrupted");
      // The record is written before the first approval; the mark comes after every environment.
      const record = await recordOf(w);
      const last = index === ASKED[target].length - 1;
      expect(record.step).toBe(last ? "prepared" : "started");
      expect((await readMarks(await w.open())).marks).toEqual([]);

      const result = await w.run();
      expect(result).toMatchObject({ step: "prepared", done: true });
      // The next run asked only what was left, and everything was done exactly once.
      expect(w.requests.slice(index + 1).map((request) => request.kind)).toEqual(
        ASKED[target].slice(index),
      );
      expect(w.done()).toEqual(await whole(target));
      expect(summaries(w)).toBe(1);
      expect(w.wroteToA()).toBe(false);
      expect(await w.leaks(JSON.stringify(result))).toBe(false);
    },
  );

  it.each(["cloud", "own-tunnel", "portainer", "site", "pages"] as const)(
    "as a script, %s stops at each plan with its hash and goes on with --approve",
    async (target) => {
      const w = await prepareWorld(target);
      const { result, hashes } = await asScript(w);
      expect(result).toMatchObject({ step: "prepared", done: true });
      expect(hashes).toHaveLength(ASKED[target].length);
      expect(new Set(hashes).size).toBe(hashes.length);
      expect(w.done()).toEqual(await whole(target));
      expect(summaries(w)).toBe(1);
      expect(await readAppProgress(w.deps.paths)).toEqual({});
      expect(w.wroteToA()).toBe(false);
      expect(await w.leaks(JSON.stringify(result))).toBe(false);
    },
  );

  it("prepares every environment of the app, one mark for all", async () => {
    const w = await prepareWorld("proxied", { staging: true });
    const result = await w.run();
    expect(result).toMatchObject({ step: "prepared", done: true });
    expect(w.requests.map((request) => request.kind)).toEqual([
      CF,
      CF,
      "iac-apply",
      CF,
      "iac-apply",
      CF,
    ]);
    const bZone = w.cloudflare.zone(ZONE, "New");
    for (const name of ["prod", "staging"]) {
      expect(await recordOf(w, name)).toMatchObject({ step: "prepared", to: { zoneId: bZone.id } });
    }
    const staging = w.plans.staging as DeployPlan;
    expect(w.engine.appliedDirs.map((dir) => toPosixRelative(w.root, dir))).toEqual([
      (w.plans.prod as DeployPlan).infra.dir,
      staging.infra.dir,
    ]);
    const { marks } = await readMarks(await w.open());
    expect(marks).toHaveLength(1);
    expect(marks[0]?.mark.envs).toEqual(["prod", "staging"]);
    expect(marks[0]?.mark.hosts).toEqual(
      expect.arrayContaining([`shop.${ZONE}`, `staging.shop.${ZONE}`]),
    );
    expect(w.wroteToA()).toBe(false);
    expect(await w.leaks(JSON.stringify(result))).toBe(false);
  });

  it("goes on with the next environment and leaves a prepared one alone", async () => {
    const w = await prepareWorld("proxied", { staging: true });
    let asked = 0;
    // Interrupted at staging's shared plan: prod is prepared, staging started.
    await expect(
      w.run({
        answer: () => {
          if (asked++ === 3) throw new Error("interrupted");
          return true;
        },
      }),
    ).rejects.toThrow("interrupted");
    expect((await recordOf(w, "prod")).step).toBe("prepared");
    expect((await recordOf(w, "staging")).step).toBe("started");
    const said = w.deps.reporter.lines.length;
    const result = await w.run();
    expect(result).toMatchObject({ step: "prepared", done: true });
    expect(w.requests.slice(4).map((request) => request.kind)).toEqual([CF, "iac-apply", CF]);
    const steps = w.deps.reporter.lines.slice(said).map((line) => line.message);
    expect(steps.some((line) => line.startsWith("Preparing staging"))).toBe(true);
    expect(steps.some((line) => line.startsWith("Preparing prod"))).toBe(false);
    expect(w.engine.appliedDirs).toHaveLength(2);
    expect(w.wroteToA()).toBe(false);
  });

  it("prepares two apps of one repository, each with its own record and mark", async () => {
    const w = await prepareWorld("proxied", { secondApp: true });
    await w.run();
    const blog = await w.run({ app: "blog" });
    expect(blog).toMatchObject({ step: "prepared", done: true });
    // B's zone is there and holds A's other records already: blog's prepare copies nothing.
    expect(w.requests.slice(ASKED.proxied.length).map((request) => request.kind)).toEqual([
      CF,
      "iac-apply",
      CF,
    ]);
    expect(
      w.cloudflare.calls.filter((call) => call.method === "POST" && call.path === "/zones"),
    ).toHaveLength(1);
    expect((await w.planNow("prod", "blog")).cloudflareMove?.step).toBe("prepared");
    const { marks } = await readMarks(await w.open());
    expect(marks.map((read) => read.mark.app).sort()).toEqual(["blog", "shop"]);
    // Only the app of another repository is left to prepare.
    expect(blog.next[0]).toContain(`: docs.${ZONE}.`);
    expect(w.wroteToA()).toBe(false);
    expect(await w.leaks(JSON.stringify(blog))).toBe(false);
  });

  it("continues a recorded move without --to and refuses another account", async () => {
    const w = await prepareWorld("proxied");
    const first = await w.run({ interactive: false });
    expect(first).toMatchObject({ step: "started", done: false });
    const again = await w.run({ interactive: false, to: null });
    expect(again.pendingPlanHash).toBe(first.pendingPlanHash);
    const before = w.cloudflare.calls.length;
    const refused = await w.run({ interactive: false, to: "Spare" }).catch((error) => error);
    expect(refused).toBeInstanceOf(OpsCrewError);
    expect(refused.message).toContain(`goes to the Cloudflare account ${w.fresh.id}`);
    expect(refused.message).toContain("Nothing was changed.");
    expect(w.cloudflare.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
    expect(w.done()).toEqual([]);
    expect(summaries(w)).toBe(1);
  });

  it("changes nothing when the summary is turned down", async () => {
    const w = await prepareWorld("cloud");
    const refused = await w.run({ confirmStart: async () => false }).catch((error) => error);
    expect(refused).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(refused.message).toContain("Nothing was changed.");
    expect((await w.planNow()).cloudflareMove).toBeUndefined();
    expect(w.done()).toEqual([]);
    expect(w.requests).toEqual([]);
    expect(w.wroteToA()).toBe(false);
  });

  it("records the DS record the registry published when the move started", async () => {
    const w = await prepareWorld("proxied", { ds: true });
    await w.run({ interactive: false });
    expect((await recordOf(w)).dsAtStart).toBe(true);
  });

  it.each([
    ["being aborted", (move: CloudflareMove) => abortingMove(move, "started"), "--abort"],
    ["finishing", (move: CloudflareMove) => advancedMove(move, "adopted", new Date()), "--finish"],
  ] as const)("refuses while the move is %s", async (_what, step, flag) => {
    const w = await prepareWorld("proxied");
    await w.run();
    const paths = environmentPaths(w.deps.paths, "prod");
    await writeMoveRecord(w.deps, paths, step(await recordOf(w)));
    const before = { done: w.done(), asked: w.requests.length };
    const refused = await w.run().catch((error) => error);
    expect(refused).toBeInstanceOf(OpsCrewError);
    expect(refused.message).toContain("Nothing was changed.");
    expect(refused.hint).toContain(`opscrew cloudflare move ${flag}`);
    expect({ done: w.done(), asked: w.requests.length }).toEqual(before);
  });

  it.each([
    ["gone half-way through", false, false],
    ["added again after the end", true, true],
  ] as const)(
    "refuses when New's zone the move was prepared in is %s",
    async (_when, whole, again) => {
      const w = await prepareWorld("proxied");
      if (whole) await w.run();
      else {
        const first = await w.run({ interactive: false });
        await w.run({ interactive: false, approvePlanHash: first.pendingPlanHash as string });
        expect((await recordOf(w)).to.zoneId).toBe(w.cloudflare.zone(ZONE, "New").id);
      }
      const prepared = w.cloudflare.zone(ZONE, "New");
      w.cloudflare.zones.splice(w.cloudflare.zones.indexOf(prepared), 1);
      if (again) await (await w.open()).accounts.b.client.createZone(w.fresh.id, ZONE);
      const before = { done: w.done(), asked: w.requests.length, zones: w.cloudflare.zones.length };
      const refused = await w.run().catch((error) => error);
      expect(refused).toBeInstanceOf(OpsCrewError);
      expect(refused.message).toBe(
        `${ZONE} in the Cloudflare account New is not the zone the move was prepared in: it is gone, or it was added again. Nothing was changed.`,
      );
      expect(refused.hint).toBe(
        "Run `opscrew cloudflare move --abort` to remove what the move made, then start the move again (`opscrew cloudflare move --to <account>`).",
      );
      const after = { done: w.done(), asked: w.requests.length, zones: w.cloudflare.zones.length };
      expect(after).toEqual(before);
      expect(w.wroteToA()).toBe(false);
    },
  );
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findExecutable, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupCloudflare } from "../provision";
import { storageKeyFile } from "../provision/storage";
import { generatedValuesFile } from "../shared/app-secrets";
import { setDeployPause } from "../shared/deploy-pause";
import { APP_BUCKET, BACKUPS_BUCKET } from "./buckets.fakes";
import { FINISH_STEPS, type FinishSteps, finishMove } from "./finish";
import type { PointingAtB } from "./finish-point";
import {
  asScript,
  change,
  type FinishTarget,
  type FinishWorld,
  type FinishWorldOptions,
  finishWorld,
} from "./finish-removal.fakes";
import { readAppProgress } from "./progress";
import { ZONE } from "./session.fakes";
import { shadowFiles } from "./shadow";
import { addressState, SERVER_ADDRESSES } from "./shadow.fakes";
import { aSharedRecordPath, bSharedRecordPath } from "./shared";
import type { MoveSession } from "./types";

/** What the steps (each tested on its own) did, in order. */
let trail: string[] = [];
/** What step 1 says of itself (default: B's values to write, after an approval). */
let point: Omit<PointingAtB, "secrets" | "deploy"> = {
  done: false,
  pointing: false,
  asks: { hash: "f".repeat(64) },
};

const B_TUNNEL = "7a2e1d3f-2222-4b6c-8d4e-123456789abc";
const B_WEBHOOK_TUNNEL = "7a2e1d3f-3333-4b6c-8d4e-123456789abc";
const TUNNEL_TOKEN = fakeSecret("cloudflare-token", "b-tunnel");
const WEBHOOK_TOKEN = fakeSecret("cloudflare-token", "b-webhook-tunnel");
const RECORD = `module.dns.cloudflare_dns_record.this["shop.${ZONE}"]`;
const TUNNEL = "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this";

/** The finish's steps, each tested on its own, as recorders (their calls in `steps.*.mock`). */
let steps: { [K in keyof FinishSteps]: ReturnType<typeof vi.fn<FinishSteps[K]>> };

beforeEach(() => {
  trail = [];
  point = { done: false, pointing: false, asks: { hash: "f".repeat(64) } };
  steps = {
    recoverWindow: vi.fn<FinishSteps["recoverWindow"]>(async (_s, environment) => {
      trail.push(`recover ${environment.environment}`);
    }),
    planBShared: vi.fn<FinishSteps["planBShared"]>(async () => {
      trail.push("shared");
      return {};
    }),
    pointAtB: vi.fn<FinishSteps["pointAtB"]>(async () => ({
      ...point,
      secrets: async () => {
        trail.push("secrets");
      },
      deploy: async () => {
        trail.push("deploy");
      },
    })),
    backToA: vi.fn<FinishSteps["backToA"]>(async () => {
      trail.push("back to A");
    }),
    bucketWindow: vi.fn<FinishSteps["bucketWindow"]>(async (_s, _e, options) => {
      trail.push("window");
      await options.pointAtB.secrets();
      await options.pointAtB.deploy();
      return undefined;
    }),
    lastCopyOnce: vi.fn<FinishSteps["lastCopyOnce"]>(async () => {
      trail.push("copy");
      return undefined;
    }),
    takeOverConnector: vi.fn<FinishSteps["takeOverConnector"]>(async (_s, _e, tunnels) => {
      trail.push(`connector ${tunnels.map((t) => `${t.module}=${t.tunnelId}`).join(" ")}`);
    }),
    adoptSite: vi.fn<FinishSteps["adoptSite"]>(async () => {
      trail.push("adopt");
      return undefined;
    }),
    removeA: vi.fn<FinishSteps["removeA"]>(async (_s, environment) => {
      trail.push(`remove A ${environment.plan.cloudflareMove?.step}`);
      return undefined;
    }),
    endFinish: vi.fn<FinishSteps["endFinish"]>(async () => {
      trail.push("end");
      return { step: "finished", done: true, next: [] };
    }),
  };
  // Every step the finish calls is a recorder.
  expect(Object.keys(steps).sort()).toEqual(Object.keys(FINISH_STEPS).sort());
});

/** A shared record of the app in `zoneId`. */
function sharedRecord(zoneId: string): string {
  return JSON.stringify({ zoneId, hostnames: {}, createdEntrypoints: [] });
}

/**
 * The app on `target`, prepared, after the switch: B's shadow states and A's state seeded, A's
 * shared record in its place and B's in the move's folder.
 */
async function world(target: FinishTarget, o: FinishWorldOptions = {}) {
  const w = await finishWorld(target, { step: "prepared", ...o });
  const { paths } = w.environment;
  await mkdir(dirname(paths.files.cloudflareRecord), { recursive: true });
  await writeFile(paths.files.cloudflareRecord, sharedRecord(w.cloudflare.zone(ZONE, "Old").id));
  await mkdir(dirname(bSharedRecordPath(w.environment)), { recursive: true });
  await writeFile(bSharedRecordPath(w.environment), sharedRecord(w.bZone.id));
  const main = w.rootOf("main");
  await writeFile(shadowFiles(main).environmentState, addressState([...SERVER_ADDRESSES, RECORD]));
  const outputs =
    target === "own"
      ? { tunnel_id: B_TUNNEL, tunnel_token: TUNNEL_TOKEN }
      : target === "portainer"
        ? {
            tunnel_id: B_TUNNEL,
            tunnel_token: TUNNEL_TOKEN,
            portainer_tunnel_id: B_WEBHOOK_TUNNEL,
            portainer_tunnel_token: WEBHOOK_TOKEN,
          }
        : {};
  await w.seedShadow("main", [RECORD, ...(target === "own" ? [TUNNEL] : [])], outputs);
  if (o.buckets) {
    await w.seedShadow("storage", ["cloudflare_r2_bucket.this"]);
    await w.seedShadow("backups", ["cloudflare_r2_bucket.this"]);
  }
  const leaks = (...texts: string[]) =>
    w.leaks(...texts) ||
    [TUNNEL_TOKEN, WEBHOOK_TOKEN].some((token) =>
      [...texts, w.deps.reporter.text(), JSON.stringify(w.deps.audit.entries)].some((text) =>
        text.includes(token),
      ),
    );
  return { ...w, leaks };
}

/** Runs the finish with `session`'s deps and services (a script's when given one). */
function finish(w: FinishWorld, session: MoveSession = w.session, allowDowntime = false) {
  return finishMove(
    session.deps,
    {
      services: session.services,
      ...(session.approve === undefined ? {} : { approvePlanHash: session.approve }),
      ...(allowDowntime ? { allowDowntime } : {}),
    },
    steps,
  );
}

async function stepOf(w: FinishWorld): Promise<string | undefined> {
  return (await readArtifact("plan", w.environment.paths.files.plan)).cloudflareMove?.step;
}

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.catch((e: unknown) => e);
  if (!(error instanceof OpsCrewError)) throw new Error(`expected a stop, got ${String(error)}`);
  return error;
}

describe.skipIf(!findExecutable("git"))("finishMove", () => {
  it("runs plan 7.'s steps in order for a cloud server with its buckets, then removes A's pieces and ends", async () => {
    const w = await world("cloud", { buckets: true });
    // The committed main root holds A's ids, as before the swap.
    const tfvars = join(w.rootOf("main").dir, "terraform.tfvars.json");
    const committed = await readFile(tfvars, "utf8");
    const aZone = w.cloudflare.zone(ZONE, "Old");
    await writeFile(tfvars, committed.replace(w.bZone.id, aZone.id).replace(w.fresh.id, w.old.id));
    // A's kept bucket keys, and B's.
    const keys = storageKeyFile(w.environment.paths);
    await mkdir(dirname(keys), { recursive: true });
    const kept = (bucket: string, seed: string, account?: string) =>
      JSON.stringify({
        provider: "r2",
        bucket,
        ...(account === undefined ? {} : { account }),
        accessKeyId: fakeSecret("aws-access-key-id", seed),
        secretAccessKey: fakeSecret("aws-secret-access-key", seed),
      });
    await writeFile(
      keys,
      [
        kept(APP_BUCKET, "a"),
        kept(BACKUPS_BUCKET, "a-backups", w.old.id),
        kept(APP_BUCKET, "b", w.fresh.id),
        kept(BACKUPS_BUCKET, "b-backups", w.fresh.id),
        "",
      ].join("\n"),
    );

    const result = await finish(w);
    const files = ["main", "storage", "backups"].map((name) =>
      toPosixRelative(w.root, join(w.rootOf(name as "main").dir, "terraform.tfvars.json")),
    );
    expect(result).toEqual({
      step: "finished",
      done: true,
      next: [
        `Commit and push the files the move changed (opscrew/plan.yaml, ${files[0]}, ${files[1]} and ${files[2]}), so OpsCrew on every computer, and the next provision, work with the app in the new Cloudflare account.`,
      ],
    });
    expect(trail).toEqual([
      "recover prod",
      "shared",
      "window",
      "secrets",
      "deploy",
      "copy",
      "adopt",
      "remove A adopted",
      "end",
    ]);
    expect(await stepOf(w)).toBe("adopted");
    // Each root's state is B's, A's former one kept for its removal; the ids are B's.
    const main = w.rootOf("main");
    expect(JSON.parse(await readFile(shadowFiles(main).environmentState, "utf8"))).toMatchObject({
      addresses: [RECORD],
    });
    expect(JSON.parse(await readFile(shadowFiles(main).removalState, "utf8")).addresses).toContain(
      "module.server.hcloud_server.this",
    );
    await expect(readFile(main.statePath)).rejects.toThrow();
    expect(JSON.parse(await readFile(tfvars, "utf8"))).toMatchObject({
      cloudflare_zone_id: w.bZone.id,
      cloudflare_account_id: w.fresh.id,
    });
    expect(w.deps.audit.entries.map((e) => e.action)).toContain("states swapped");
    // Only B's kept keys stay.
    const left = (await readFile(keys, "utf8")).trim().split("\n");
    expect(left.map((line) => JSON.parse(line).account)).toEqual([w.fresh.id, w.fresh.id]);
    // Nothing of A's was written through Cloudflare's API.
    expect(w.aWrites()).toEqual([]);
    expect(w.leaks()).toBe(false);
  });

  it("gives an own server's connector B's tunnel and token from B's state", async () => {
    const w = await world("own");
    await finish(w);
    expect(trail).toEqual([
      "recover prod",
      "shared",
      "window",
      "secrets",
      "deploy",
      "copy",
      `connector tunnel=${B_TUNNEL}`,
      "adopt",
      "remove A adopted",
      "end",
    ]);
    const [, , tunnels] = steps.takeOverConnector.mock.calls[0] ?? [];
    expect(tunnels).toEqual([{ module: "tunnel", tunnelId: B_TUNNEL, token: TUNNEL_TOKEN }]);
    expect(w.leaks()).toBe(false);
  });

  it("gives Portainer's connectors B's tunnels and tokens from B's state", async () => {
    const w = await world("portainer");
    await finish(w);
    expect(trail).toContain(`connector tunnel=${B_TUNNEL} portainer_tunnel=${B_WEBHOOK_TUNNEL}`);
    const [, , tunnels, options] = steps.takeOverConnector.mock.calls[0] ?? [];
    expect(tunnels?.map((tunnel) => tunnel.token)).toEqual([TUNNEL_TOKEN, WEBHOOK_TOKEN]);
    // The default restarts them through the stacks with B's values (`stacksForB`).
    expect(options).toBeUndefined();
    expect(w.leaks()).toBe(false);
  });

  it("adopts a Workers site's custom domains before its swap, with nothing to point", async () => {
    const w = await world("site");
    point = { done: true, pointing: false };
    await finish(w);
    expect(trail).toEqual(["recover prod", "shared", "copy", "adopt", "remove A adopted", "end"]);
    expect(await stepOf(w)).toBe("adopted");
    expect(w.leaks()).toBe(false);
  });

  for (const name of ["planBShared", "bucketWindow", "lastCopyOnce", "adoptSite"] as const) {
    it(`goes on after a stop at ${name}, the steps before it run again and find them done`, async () => {
      const w = await world("cloud", { buckets: true });
      point = { done: false, pointing: false };
      const stop = { next: [`Run it again after ${name}.`] };
      const once = steps[name] as unknown as {
        mockImplementationOnce(f: () => Promise<unknown>): void;
      };
      once.mockImplementationOnce(async () => {
        trail.push(`${name} stopped`);
        return name === "planBShared" ? { stop } : stop;
      });
      expect(await finish(w)).toEqual({ step: "prepared", done: false, ...stop });
      expect(await stepOf(w)).toBe("prepared");
      trail = [];
      expect(await finish(w)).toMatchObject({ step: "finished", done: true });
      expect(trail.at(0)).toBe("recover prod");
      expect(trail.slice(-3)).toEqual(["adopt", "remove A adopted", "end"]);
      expect(await stepOf(w)).toBe("adopted");
    });
  }

  it("takes B's origin certificate and records: A's aside for its revocation, B's in place", async () => {
    const w = await world("cloud");
    const { paths } = w.environment;
    const aRecord = sharedRecord(w.cloudflare.zone(ZONE, "Old").id);
    const bRecord = sharedRecord(w.bZone.id);
    const values = generatedValuesFile({ paths });
    await mkdir(dirname(values), { recursive: true });
    const keyA = fakeSecret("private-key-pem", "a-origin");
    const keyB = fakeSecret("private-key-pem", "b-origin");
    await writeFile(
      values,
      JSON.stringify({
        originTls: { ORIGIN_TLS_KEY: keyA, ORIGIN_TLS_CERT: "A's", ORIGIN_PULL_CERT: "pull" },
        originTlsNext: { ORIGIN_TLS_KEY: keyB, ORIGIN_TLS_CERT: "B's" },
      }),
    );
    // A script stops at the window's approval: B's certificate is taken already.
    const stop = await finish(w, asScript(w));
    expect(stop).toMatchObject({ step: "prepared", done: false, pendingPlanHash: "f".repeat(64) });
    expect(await readFile(paths.files.cloudflareRecord, "utf8")).toBe(bRecord);
    expect(await readFile(aSharedRecordPath(w.environment), "utf8")).toBe(aRecord);
    await expect(readFile(bSharedRecordPath(w.environment))).rejects.toThrow();
    expect(JSON.parse(await readFile(values, "utf8"))).toEqual({
      originTls: { ORIGIN_TLS_KEY: keyB, ORIGIN_TLS_CERT: "B's", ORIGIN_PULL_CERT: "pull" },
    });
    // The run after it plans B's shared pieces no more and moves nothing again.
    trail = [];
    await finish(w);
    expect(trail).not.toContain("shared");
    expect(await readFile(aSharedRecordPath(w.environment), "utf8")).toBe(aRecord);
    expect(w.leaks()).toBe(false);
  });

  it("stops a script at step 1's hash before the window, then goes on with --approve and --allow-downtime", async () => {
    const w = await world("cloud", { buckets: true });
    const hash = "f".repeat(64);
    point = { done: false, pointing: false, asks: { hash, details: "B's deploy secrets" } };
    const stop = await finish(w, asScript(w));
    expect(stop).toEqual({
      step: "prepared",
      done: false,
      pendingPlanHash: hash,
      next: [
        `Review the plan above, then run \`opscrew cloudflare move --finish --allow-downtime --approve ${hash}\` to apply it and continue.`,
      ],
    });
    expect(trail).toEqual(["recover prod", "shared"]);
    expect(w.deps.reporter.text()).toContain("B's deploy secrets");
    expect((await readAppProgress(w.session.paths)).pending).toMatchObject({
      action: "window",
      environment: "prod",
      planHash: hash,
    });

    trail = [];
    const done = await finish(w, asScript(w, hash), true);
    expect(done).toMatchObject({ step: "finished", done: true });
    // B's shared pieces and records were taken by the first run.
    expect(trail.slice(0, 5)).toEqual(["recover prod", "window", "secrets", "deploy", "copy"]);
    const [, , options] = steps.bucketWindow.mock.calls[0] ?? [];
    expect(options?.allowDowntime).toBe(true);
    expect((await readAppProgress(w.session.paths)).pending).toBeUndefined();
  });

  it("only goes forward, without a window, once the app reads B's bucket; skips step 1 once it is done", async () => {
    const w = await world("cloud", { buckets: true });
    point = { done: false, pointing: true };
    await finish(w);
    expect(trail).not.toContain("window");
    expect(trail.slice(1, 4)).toEqual(["shared", "secrets", "deploy"]);
    expect(trail).toContain("copy");

    const d = await world("cloud", { buckets: true });
    trail = [];
    point = { done: true, pointing: true };
    await finish(d);
    expect(trail).not.toContain("window");
    expect(trail).not.toContain("secrets");
  });

  it("goes on with the swap alone once it began, after its check plan's approval", async () => {
    const w = await world("own");
    point = { done: true, pointing: false };
    w.engine.checkChanges = [change(RECORD, "update")];
    const stop = await finish(w, asScript(w));
    const hash = stop.pendingPlanHash ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stop.next[0]).toContain(`--approve ${hash}`);
    expect(await stepOf(w)).toBe("prepared");
    expect(trail.at(-1)).toBe("adopt");

    trail = [];
    expect(await finish(w, asScript(w, hash))).toMatchObject({ done: true });
    // The steps before the swap are not run again.
    expect(trail).toEqual(["recover prod", "remove A adopted", "end"]);
    expect(await stepOf(w)).toBe("adopted");
  });

  it("goes straight to A's removal once every environment is adopted", async () => {
    const w = await world("own");
    steps.removeA.mockImplementationOnce(async () => {
      trail.push("remove A stopped");
      return { next: ["Run it again after the deploy."] };
    });
    const stop = await finish(w);
    expect(stop).toEqual({
      step: "adopted",
      done: false,
      next: ["Run it again after the deploy."],
    });
    trail = [];
    await finish(w);
    expect(trail).toEqual(["remove A adopted", "end"]);
  });

  it("recovers a window whose record was lost first, told by the deploys still paused for it", async () => {
    const w = await world("cloud", { buckets: true });
    await setDeployPause(w.session.deps, w.session.github, w.environment.plan, {
      reason: "move",
      since: "2026-11-21T09:00:00.000Z",
    });
    let recorded: unknown;
    steps.recoverWindow.mockImplementationOnce(async (session, environment, back) => {
      recorded = (await readAppProgress(session.paths)).window?.environment;
      trail.push(`recover ${environment.environment}`);
      await back();
    });
    await finish(w);
    expect(recorded).toBe("prod");
    expect(trail.slice(0, 3)).toEqual(["recover prod", "back to A", "shared"]);
    expect(w.deps.reporter.text()).toContain(
      "this computer has no record of where the window got to",
    );
  });

  it("refuses, changing nothing, before every environment is prepared or while B's zone is pending", async () => {
    const started = await world("own", { step: "started" });
    const error = await caught(finish(started));
    expect(error.message).toBe(
      "Shop (prod) is not prepared in the new Cloudflare account yet, so the move can't finish. Nothing was changed.",
    );
    expect(trail).toEqual([]);

    const pending = await world("own");
    pending.bZone.status = "pending";
    const refused = await caught(finish(pending));
    expect(refused.message).toBe(
      `${ZONE} is not active in the new Cloudflare account yet, so the move can't finish. Nothing was changed.`,
    );
    expect(refused.hint).toContain("opscrew cloudflare move --switch");
    expect(trail).toEqual([]);
    expect(pending.handler.requests).toEqual([]);
  });

  it("leaves A's token refusing the moved zone after the finish", async () => {
    const w = await world("own");
    await finish(w);
    const plan = await readArtifact("plan", w.environment.paths.files.plan);
    const error = await caught(
      setupCloudflare({ ...w.session.deps, paths: w.environment.paths }, plan, {
        cloudflare: w.session.accounts.a.client,
      }),
    );
    expect(error.message).toBe(
      `${ZONE} moved to another Cloudflare account: set CLOUDFLARE_API_TOKEN to that account's token, then run the command again. Nothing was changed.`,
    );
  });
});

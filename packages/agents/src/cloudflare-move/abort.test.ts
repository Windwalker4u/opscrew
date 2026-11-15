import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeTunnel } from "@opscrew/connector-cloudflare/testing";
import { portainerClient } from "@opscrew/connector-portainer";
import type { CommandResult, RemoteExec, RemoteRunOptions } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES, storageRootDir } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { originTlsApply, planOriginTls, readOriginTlsValues } from "../provision/origin-tls";
import { applySharedCloudflare, planSharedCloudflare } from "../provision/shared-cloudflare";
import { NEW_OFFSITE_KEY_VARS, NEW_STORAGE_KEY_VARS } from "../provision/storage";
import type { StorageLogin } from "../shared";
import { recordPortainerConnection, updateServerAddresses } from "../shared/server-record";
import {
  fakeCertificate,
  fakePortainer,
  freshFacts,
  OLD_DS,
  ownPlan,
  PORTAINER_URL,
  pagesTestPlan,
  portainerPlan,
  sitePlan,
  unusedRemote,
  withBucket,
} from "../testing";
import {
  type AbortHarness,
  type AbortHarnessOptions,
  abortHarness,
  B_PIECES,
  COPIED_SERVER,
} from "./abort.fakes";
import { APP_BUCKET, BACKUPS_BUCKET, FakeR2 } from "./buckets.fakes";
import { B_TUNNEL, B_WEBHOOK_TUNNEL, ConnectorHost, fakeClock } from "./connector.fakes";
import { readAppProgress } from "./progress";
import { serverPlan, unencrypted, ZONE } from "./session.fakes";
import { bSharedRecordPath, planBShared } from "./shared";
import { BLOG } from "./switch.fakes";
import type { MoveResult } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The error a run stops with, checked to say nothing was changed. */
async function refused(run: Promise<unknown>): Promise<OpsCrewError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect((error as OpsCrewError).message).toMatch(/Nothing was changed\.$/);
  return error as OpsCrewError;
}

/** Each approval asked: its kind, whether it allows a deletion, and the name typed. */
const asked = (h: AbortHarness) =>
  h.handler.requests.map((r) => [r.kind, r.allowDestroy === true, r.confirmPhrase]);

/** True while New holds the zone. */
const bHasZone = (h: AbortHarness) =>
  h.cloudflare.zones.some((zone) => zone.name === ZONE && zone.accountId === h.fresh.id);

/** prod's record of the move, as its plan holds it now. */
const recordNow = async (h: AbortHarness) =>
  (await readArtifact("plan", h.prodPaths.files.plan)).cloudflareMove;

/** True when the environment's move folder is gone. */
const folderGone = async (h: AbortHarness) =>
  readdir(join(h.prodPaths.stateDir, "cloudflare-move")).then(
    () => false,
    () => true,
  );

/** What a finished abort leaves: no record, no folder, no local file, Old as it was. */
async function expectAborted(h: AbortHarness, result: MoveResult) {
  expect(result).toEqual(expect.objectContaining({ step: "aborted", done: true }));
  expect(await recordNow(h)).toBeUndefined();
  expect(await folderGone(h)).toBe(true);
  expect(await readAppProgress(h.deps.paths)).toEqual({});
  expect(h.writes("Old")).toEqual([]);
  expect(h.aUnchanged()).toBe(true);
  expect(result.next.at(-1)).toBe(
    `${ZONE} goes on serving from the account Old, which the move never changed. To move later, start again with \`opscrew cloudflare move --to <account>\`.`,
  );
}

/** Runs a script's abort to its end: each stop's hash approved by the next run. */
async function scripted(h: AbortHarness): Promise<{ result: MoveResult; stops: MoveResult[] }> {
  const stops: MoveResult[] = [];
  let result = await h.run();
  while (!result.done) {
    expect(result.pendingPlanHash).toMatch(/^[0-9a-f]{64}$/);
    stops.push(result);
    if (stops.length > 12) throw new Error("the abort never ends");
    result = await h.run({ approvePlanHash: result.pendingPlanHash as string });
  }
  return { result, stops };
}

describe.skipIf(!findExecutable("git"))("abortMove: a proxied cloud server", () => {
  it("deletes the mark, destroys New's pieces with the app's name typed and New's zone with its name typed; Old sees no write", async () => {
    const h = await abortHarness();
    h.deps.interactive = true;
    const result = await h.run();
    await expectAborted(h, result);
    expect(asked(h)).toEqual([
      ["cloudflare-apply", false, undefined],
      ["iac-apply", true, "shop"],
      ["cloudflare-apply", true, ZONE],
    ]);
    expect(h.handler.requests[0]?.details).toContain("Delete the app's mark of the move");
    expect(h.handler.requests[2]?.title).toBe(
      `Delete the zone ${ZONE} from the Cloudflare account New`,
    );
    // The copied server stays out of the destroy plan, which runs with New's token and ids.
    expect(h.engine.planOptions.at(-1)?.env?.CLOUDFLARE_API_TOKEN).toBe(h.tokens.b);
    const [main] = h.roots;
    expect(h.engine.planOptions.at(-1)?.vars).toEqual(main?.vars);
    expect(h.engine.applied).toHaveLength(1);
    expect(bHasZone(h)).toBe(false);
    expect(h.deps.audit.entries.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "cloudflare mark records deleted",
        "abort zone deleted",
        "abort ended",
      ]),
    );
    expect(await h.leaks([], JSON.stringify(result))).toBe(false);
  });

  it("removes New's shared pieces after the shadow roots, with the app's name typed, and forgets originTlsNext", async () => {
    const h = await abortHarness();
    h.deps.interactive = true;
    const prepared = await h.open();
    const [environment] = prepared.environments;
    if (environment === undefined) throw new Error("prod is covered");
    const deps = { ...h.deps, paths: environment.paths };
    // The app as provision left it in Old: its shared plan with its origin TLS.
    const { plan } = environment;
    const { a } = prepared.accounts;
    const tls = await planOriginTls(deps, { plan, record: undefined, served: undefined });
    const planned = await planSharedCloudflare(deps, {
      services: {},
      plan,
      cloudflare: { zoneId: a.zoneId, zoneName: ZONE, accountId: a.accountId },
      command: "opscrew provision",
      tls: { ...(tls === undefined ? {} : { tls: tls.desired }) },
      client: a.client,
    });
    await applySharedCloudflare(deps, planned as NonNullable<typeof planned>, {
      app: plan.app.name,
      planOnly: false,
      command: "opscrew provision",
      phase: "provision",
      ...originTlsApply(deps, tls, { sleep: async () => undefined }),
    });
    expect(await planBShared(prepared, environment)).toEqual({});
    expect(await readFile(bSharedRecordPath(environment), "utf8")).toContain(h.bZone?.id);
    h.handler.requests.length = 0;
    h.cloudflare.calls.length = 0;
    const result = await h.run();
    await expectAborted(h, result);
    expect(asked(h)).toEqual([
      ["cloudflare-apply", false, undefined],
      ["iac-apply", true, "shop"],
      ["cloudflare-apply", true, "shop"],
      ["cloudflare-apply", true, ZONE],
    ]);
    expect(await readOriginTlsValues(deps, "originTlsNext")).toEqual({});
    expect(await h.leaks([], JSON.stringify(result))).toBe(false);
  });

  it("keeps New's zone while another app is prepared there, and says why", async () => {
    const h = await abortHarness({ marks: [BLOG] });
    h.deps.interactive = true;
    const result = await h.run();
    await expectAborted(h, result);
    expect(asked(h).map(([kind]) => kind)).toEqual(["cloudflare-apply", "iac-apply"]);
    expect(bHasZone(h)).toBe(true);
    expect(result.next[0]).toBe(
      `${ZONE} stays in the account New: it holds the move mark of blog, prepared there from its own repository. The last abort of an app prepared there deletes it.`,
    );
    // Only this app's mark and records went.
    expect(h.bZone?.records.map((r) => r.name).sort()).toEqual(
      [ZONE, `_opscrew-move.blog-0123abcd.${ZONE}`].sort(),
    );
  });

  it("keeps New's zone while it holds another app's OpsCrew record", async () => {
    const h = await abortHarness();
    const { bZone } = h;
    if (bZone === undefined) throw new Error("New has the zone");
    h.cloudflare.addRecord(bZone, {
      type: "A",
      name: `blog.${ZONE}`,
      content: "192.0.2.2",
      proxied: true,
      comment: "Managed by OpsCrew",
    });
    h.deps.interactive = true;
    const result = await h.run();
    await expectAborted(h, result);
    expect(bHasZone(h)).toBe(true);
    expect(result.next[0]).toContain(`it holds OpsCrew's records of other apps (blog.${ZONE})`);
  });

  it("goes on in a script from each step's hash, asking each approval once, the names given with --confirm", async () => {
    const h = await abortHarness();
    const { result, stops } = await scripted(h);
    await expectAborted(h, result);
    expect(stops).toHaveLength(3);
    expect(stops[1]?.next[0]).toContain(`--confirm shop --approve ${stops[1]?.pendingPlanHash}\``);
    expect(stops[2]?.next[0]).toContain(
      `--confirm ${ZONE} --approve ${stops[2]?.pendingPlanHash}\``,
    );
    expect(h.handler.requests.map((r) => r.planHash)).toEqual(
      stops.map((stop) => stop.pendingPlanHash),
    );
    expect(bHasZone(h)).toBe(false);
    const again = await refused(h.run());
    expect(again.message).toContain("is not moving to another Cloudflare account");
    expect(await h.leaks([], JSON.stringify(stops))).toBe(false);
  });

  it("records the abort before its first change, and refuses the switch from then on", async () => {
    const h = await abortHarness();
    const stop = await h.run();
    expect(stop.done).toBe(false);
    expect(await recordNow(h)).toMatchObject({ step: "prepared", abort: { step: "started" } });
    expect((await readAppProgress(h.deps.paths)).pending).toMatchObject({
      action: "mark-delete",
      planHash: stop.pendingPlanHash,
    });
  });

  for (const at of [0, 1, 2]) {
    it(`is resumed after a refusal at approval ${at + 1}, repeating nothing done`, async () => {
      const h = await abortHarness();
      h.deps.interactive = true;
      let count = 0;
      h.answers.approve = () => count++ !== at;
      await expect(h.run()).rejects.toBeInstanceOf(OpsCrewError);
      h.answers.approve = () => true;
      await expectAborted(h, await h.run());
      const titles = h.handler.requests.map((r) => r.title);
      expect(titles).toHaveLength(4);
      expect(new Set(titles).size).toBe(3);
      expect(h.engine.applied).toHaveLength(1);
      expect(bHasZone(h)).toBe(false);
    });
  }

  it("goes on after an interruption past New's destroy, with nothing destroyed twice", async () => {
    const h = await abortHarness();
    h.deps.interactive = true;
    h.answers.approve = (request) => {
      if (request.kind === "cloudflare-apply" && request.confirmPhrase === ZONE) {
        throw new Error("interrupted");
      }
      return true;
    };
    await expect(h.run()).rejects.toThrow("interrupted");
    expect(await recordNow(h)).toMatchObject({ abort: { step: "removed" } });
    h.answers.approve = () => true;
    await expectAborted(h, await h.run());
    expect(h.engine.applied).toHaveLength(1);
    expect(asked(h).filter(([kind]) => kind === "iac-apply")).toHaveLength(1);
  });

  it("right after the start, with no zone in New yet, only forgets the move", async () => {
    const h = await abortHarness({ bZone: false, step: "started" });
    h.deps.interactive = true;
    const result = await h.run();
    await expectAborted(h, result);
    expect(h.handler.requests).toEqual([]);
    expect(h.writes("New")).toEqual([]);
  });

  it("with the DS record still published (DNSSEC at the start) aborts", async () => {
    const h = await abortHarness({ dsAtStart: true });
    h.api.dsRecords.set(ZONE, [OLD_DS]);
    h.web.ds = [OLD_DS];
    h.deps.interactive = true;
    await expectAborted(h, await h.run());
  });
});

describe.skipIf(!findExecutable("git"))(
  "abortMove: refused once the switch changed anything",
  () => {
    /** Checks the refusal changed nothing anywhere. */
    async function unchanged(h: AbortHarness, error: OpsCrewError, why: string) {
      expect(error.message).toBe(
        `The switch of ${ZONE} to the new Cloudflare account has begun (${why}), so the move can't be aborted. Nothing was changed.`,
      );
      expect(error.hint).toContain(
        "run `opscrew cloudflare move --switch`, then `opscrew cloudflare move --finish`",
      );
      expect(error.hint).toContain("never publishes a removed DNSSEC (DS) record again");
      expect(h.handler.requests).toEqual([]);
      expect(h.cloudflare.calls.every((call) => call.method === "GET")).toBe(true);
      expect((await recordNow(h))?.abort).toBeUndefined();
      expect(bHasZone(h)).toBe(true);
    }

    it("after the nameservers changed at the registrar", async () => {
      const h = await abortHarness();
      h.api.nameservers.set(ZONE, [...(h.bZone?.nameServers ?? [])]);
      const error = await refused(h.run());
      await unchanged(h, error, "its nameservers are no longer those of the account Old");
    });

    it("after the nameservers changed at a registrar OpsCrew reads through the public DNS", async () => {
      const h = await abortHarness({ registrar: "other" });
      h.web.ns = [...(h.bZone?.nameServers ?? [])];
      const error = await refused(h.run());
      await unchanged(h, error, "its nameservers are no longer those of the account Old");
    });

    it("after the DS record was removed", async () => {
      const h = await abortHarness({ dsAtStart: true });
      const error = await refused(h.run());
      await unchanged(h, error, "its DNSSEC (DS) record is no longer published");
    });

    it("once New's zone is active", async () => {
      const h = await abortHarness();
      if (h.bZone !== undefined) h.bZone.status = "active";
      const error = await refused(h.run());
      await unchanged(h, error, `${ZONE} is active in the new account`);
    });

    it("once the finish adopted an environment", async () => {
      const h = await abortHarness({ step: "adopted" });
      const error = await refused(h.run());
      await unchanged(h, error, "the finish has moved the app to the new account");
    });

    it("without a move", async () => {
      const h = await abortHarness();
      h.deps.interactive = true;
      await h.run();
      const error = await refused(h.run());
      expect(error.message).toBe(
        "shop is not moving to another Cloudflare account, so there is no move to abort. Nothing was changed.",
      );
    });
  },
);

describe.skipIf(!findExecutable("git"))("abortMove: by target", () => {
  it("an own server in tunnel mode: the _NEW secrets deleted, the connector beside removed, New's tunnel waited on, then destroyed", async () => {
    const plan = unencrypted(ownPlan({ access: "tunnel", deployed: true }));
    const h = await abortHarness({
      plan,
      shadow: { main: [B_PIECES.record(`shop.${ZONE}`), B_PIECES.tunnel] },
    });
    const tunnel: FakeTunnel = {
      id: B_TUNNEL,
      name: "shop",
      connections: [
        {
          id: "beside",
          colo_name: "fra08",
          opened_at: "2026-11-20T10:00:00.000Z",
          origin_ip: "192.0.2.80",
        },
      ],
    };
    h.fresh.tunnels.push(tunnel);
    const tunnelToken = fakeSecret("cloudflare-token", "b-tunnel");
    h.engine.shown = { tunnel_id: B_TUNNEL, tunnel_token: tunnelToken };
    const plain = fakeSecret("generic-password", "a-service-token");
    const next = fakeSecret("generic-password", "b-service-token");
    h.github.secrets.set("OPSCREW_TUNNEL_SERVICE_TOKEN_ID", plain);
    h.github.secrets.set("OPSCREW_TUNNEL_SERVICE_TOKEN_ID_NEW", next);
    h.github.secrets.set("OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET_NEW", next);
    await updateServerAddresses(h.deps.paths, (current) => ({
      ...current,
      own: { host: "192.0.2.50", port: 22, user: "admin", agent: true },
    }));
    const facts = freshFacts({ user: "admin", privilege: "sudo" });
    const host = new ConnectorHost(
      {
        ...facts,
        containers: [
          ...facts.containers,
          {
            name: "shop-tunnel-next-cloudflared-1",
            project: "shop-tunnel-next",
            ports: "",
            running: true,
          },
        ],
      },
      tunnel,
    );
    h.deps.interactive = true;
    const result = await h.run({ services: { host, remote: unusedRemote, ...fakeClock() } });
    await expectAborted(h, result);
    expect(asked(h).map(([kind]) => kind)).toEqual([
      "cloudflare-apply",
      "github-secrets",
      "host-apply",
      "iac-apply",
      "cloudflare-apply",
    ]);
    expect([...h.github.secrets.keys()]).toEqual(["OPSCREW_TUNNEL_SERVICE_TOKEN_ID"]);
    expect(tunnel.connections).toEqual([]);
    expect(host.applies).toHaveLength(1);
    expect(await h.leaks([tunnelToken, plain, next], JSON.stringify(result))).toBe(false);
  });

  it("a Workers site: its _NEW deploy secrets deleted and its Worker destroyed in New", async () => {
    const plan = unencrypted(sitePlan({ domain: `shop.${ZONE}`, deployed: true }));
    const h = await abortHarness({ plan, shadow: { main: [B_PIECES.worker] } });
    const token = fakeSecret("cloudflare-token", "b-workers-deploy");
    h.github.secrets.set("OPSCREW_CLOUDFLARE_API_TOKEN_NEW", token);
    h.github.secrets.set("OPSCREW_CLOUDFLARE_ACCOUNT_ID_NEW", h.fresh.id);
    h.deps.interactive = true;
    const result = await h.run();
    await expectAborted(h, result);
    expect(asked(h)).toEqual([
      ["cloudflare-apply", false, undefined],
      ["github-secrets", false, undefined],
      ["iac-apply", true, plan.app.name],
      ["cloudflare-apply", true, ZONE],
    ]);
    expect([...h.github.secrets.keys()]).toEqual([]);
    expect(h.engine.planOptions.at(-1)?.vars).toMatchObject({ custom_domains: "false" });
    expect(await h.leaks([token], JSON.stringify(result))).toBe(false);
  });

  it("Portainer behind its tunnels: the webhook's _NEW Access client deleted, no stack beside left, both of New's tunnels waited on, then destroyed", async () => {
    const plan = unencrypted(
      portainerPlan({ web: { mode: "tunnel" }, redeploy: "cloudflare", deployed: true }),
    );
    const portainerToken = fakeSecret("generic-password", "abort portainer token");
    const h = await abortHarness({
      plan,
      env: { PORTAINER_API_KEY: portainerToken },
      shadow: { main: [B_PIECES.record(`shop.${ZONE}`), B_PIECES.tunnel] },
    });
    const cert = fakeCertificate("abort portainer");
    await recordPortainerConnection(h.deps.paths, {
      url: PORTAINER_URL,
      certFingerprint: cert.fingerprint,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
      redeploy: "cloudflare",
      web: { mode: "tunnel" },
    });
    const portainer = fakePortainer({ token: portainerToken });
    const tunnels: FakeTunnel[] = [B_TUNNEL, B_WEBHOOK_TUNNEL].map((id) => ({
      id,
      name: id,
      connections: [],
    }));
    h.fresh.tunnels.push(...tunnels);
    h.engine.shown = { tunnel_id: B_TUNNEL, portainer_tunnel_id: B_WEBHOOK_TUNNEL };
    const next = fakeSecret("generic-password", "b-webhook-client");
    h.github.secrets.set("OPSCREW_PORTAINER_ACCESS_CLIENT_ID_NEW", next);
    h.github.secrets.set("OPSCREW_PORTAINER_ACCESS_CLIENT_SECRET_NEW", next);
    h.deps.interactive = true;
    const result = await h.run({
      services: {
        portainer: {
          client: (endpoint, token, clientDeps) =>
            portainerClient(endpoint, token, { ...clientDeps, request: portainer.request }),
          inspectCertificate: async () => cert,
        },
      },
    });
    await expectAborted(h, result);
    expect(asked(h).map(([kind]) => kind)).toEqual([
      "cloudflare-apply",
      "github-secrets",
      "iac-apply",
      "cloudflare-apply",
    ]);
    expect([...h.github.secrets.keys()]).toEqual([]);
    // Both of New's tunnels read before their destroy.
    for (const id of [B_TUNNEL, B_WEBHOOK_TUNNEL]) {
      expect(h.cloudflare.calls.some((call) => call.path.endsWith(`/cfd_tunnel/${id}`))).toBe(true);
    }
    expect(await h.leaks([portainerToken, next], JSON.stringify(result))).toBe(false);
  });

  it("GitHub Pages: the DNS root and the verification root destroyed", async () => {
    const h = await abortHarness({
      plan: unencrypted(pagesTestPlan()),
      shadow: {
        main: [B_PIECES.record("docs.example.com")],
        "pages-verification": [B_PIECES.verification],
      },
    });
    h.deps.interactive = true;
    await expectAborted(h, await h.run());
    expect(asked(h)).toEqual([
      ["cloudflare-apply", false, undefined],
      ["iac-apply", true, "example-app"],
      ["iac-apply", true, "example-app"],
      ["cloudflare-apply", true, ZONE],
    ]);
    expect(h.engine.applied).toHaveLength(2);
  });

  describe("R2", () => {
    const key = (seed: string): StorageLogin => ({
      accessKeyId: fakeSecret("aws-access-key-id", seed),
      secretAccessKey: fakeSecret("aws-secret-access-key", seed),
    });

    /** A cloud server with its files and its snapshots' copies on R2, both copied to New. */
    async function r2World() {
      const keys = { storage: key("b-storage"), backups: key("b-backups") };
      const plan: DeployPlan = DeployPlanSchema.parse({
        ...withBucket(serverPlan(), "r2"),
        snapshots: { offsite: { provider: "r2", bucket: BACKUPS_BUCKET } },
      });
      const options: AbortHarnessOptions = {
        plan,
        env: {
          [NEW_STORAGE_KEY_VARS.accessKeyId]: keys.storage.accessKeyId,
          [NEW_STORAGE_KEY_VARS.secretAccessKey]: keys.storage.secretAccessKey,
          [NEW_OFFSITE_KEY_VARS.accessKeyId]: keys.backups.accessKeyId,
          [NEW_OFFSITE_KEY_VARS.secretAccessKey]: keys.backups.secretAccessKey,
        },
        shadow: {
          main: [...COPIED_SERVER, B_PIECES.record(`shop.${ZONE}`)],
          storage: [B_PIECES.bucket],
          backups: [B_PIECES.bucket],
        },
      };
      const h = await abortHarness(options);
      const r2 = new FakeR2([], () => ({ deploys: false, check: false }));
      const aKey = key("a-storage");
      r2.add(h.old.id, APP_BUCKET, aKey, { "a.png": "aaaa" });
      r2.add(h.fresh.id, APP_BUCKET, keys.storage, { "a.png": "aaaa" });
      r2.add(h.fresh.id, BACKUPS_BUCKET, keys.backups, { "backups/1/db.age": "one" });
      const remote = (address: string): RemoteExec => ({
        host: address,
        run: async (command: string, run?: RemoteRunOptions): Promise<CommandResult> => {
          if (!command.includes(IMAGES.rclone.ref)) throw new Error(`unexpected: ${command}`);
          const args = /exec rclone --config \/tmp\/r\.conf (.*)'$/.exec(command)?.[1] ?? "";
          return r2.run("ssh", args.split(" "), run?.input ?? "");
        },
      });
      const secrets = [aKey, ...Object.values(keys)].flatMap((one) => [
        one.accessKeyId,
        one.secretAccessKey,
      ]);
      return { h, r2, remote, plan, secrets };
    }

    it("empties New's buckets (each name typed), destroys their roots from a copy without prevent_destroy, and never touches Old's", async () => {
      const { h, r2, remote, plan, secrets } = await r2World();
      h.deps.interactive = true;
      const result = await h.run({ services: { remote } });
      await expectAborted(h, result);
      expect(asked(h)).toEqual([
        ["cloudflare-apply", false, undefined],
        ["remote-exec", true, APP_BUCKET],
        ["remote-exec", true, BACKUPS_BUCKET],
        ["iac-apply", true, "shop"],
        ["iac-apply", true, "shop"],
        ["iac-apply", true, "shop"],
        ["cloudflare-apply", true, ZONE],
      ]);
      expect([...r2.objects(h.fresh.id, APP_BUCKET).keys()]).toEqual([]);
      expect([...r2.objects(h.fresh.id, BACKUPS_BUCKET).keys()]).toEqual([]);
      expect([...r2.objects(h.old.id, APP_BUCKET).keys()]).toEqual(["a.png"]);
      expect(r2.runs.every((run) => run.args.every((arg) => !arg.startsWith("a:")))).toBe(true);
      const [storage, backups, main] = h.engine.destroyPlans;
      for (const copy of [storage, backups]) {
        expect(copy?.dir).toContain(join("cloudflare-move", "delete"));
        expect(copy?.mainTf).toContain('resource "cloudflare_r2_bucket" "this"');
        expect(copy?.mainTf).not.toContain("prevent_destroy");
      }
      expect(main?.dir).toBe(join(h.root, plan.infra.dir));
      expect(await readFile(join(h.root, storageRootDir(plan), "main.tf"), "utf8")).toContain(
        "prevent_destroy = true",
      );
      expect(await h.leaks(secrets, JSON.stringify(result))).toBe(false);
    });

    it("in a script, empties one bucket per run and goes on after each", async () => {
      const { h, r2, remote } = await r2World();
      const services = { remote };
      const stops: MoveResult[] = [];
      let result = await h.run({ services });
      while (!result.done && stops.length < 12) {
        stops.push(result);
        result = await h.run({ services, approvePlanHash: result.pendingPlanHash as string });
      }
      await expectAborted(h, result);
      expect(stops).toHaveLength(7);
      expect(stops[1]?.next[0]).toContain(`--confirm ${APP_BUCKET} --approve`);
      expect(r2.runs.filter((run) => run.verb === "delete")).toHaveLength(2);
    });
  });
});

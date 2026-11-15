import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findExecutable, fingerprintSha256, OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { edgeReadCommand } from "../provision/origin-tls";
import { generatedValuesFile } from "../shared/app-secrets";
import { APP_BUCKET, BACKUPS_BUCKET } from "./buckets.fakes";
import { NEW_DEPLOY_TOKEN_VAR } from "./deploy-secrets";
import { endFinish, removeA } from "./finish-removal";
import {
  A_TUNNEL,
  A_WEBHOOK_TUNNEL,
  asScript,
  type FinishWorld,
  finishWorld,
} from "./finish-removal.fakes";
import { appMark, markContents, markName } from "./marks";
import { appProgressFile, writePending } from "./progress";
import { ZONE } from "./session.fakes";
import { shadowFiles } from "./shadow";
import { SERVER_ADDRESSES } from "./shadow.fakes";
import { aSharedRecordPath } from "./shared";
import { MARK_COMMENT } from "./zone";

/** Two origin certificates (PEM blocks): A's and B's. */
const A_PEM = pem("the certificate issued in Old");
const B_PEM = pem("the certificate issued in New");

function pem(text: string): string {
  return `-----BEGIN CERTIFICATE-----\n${Buffer.from(text).toString("base64")}\n-----END CERTIFICATE-----\n`;
}

/** The server's edge serving `cert` as the app's origin certificate. */
function serving(w: FinishWorld, cert: string): void {
  w.session.services.remote = (host) => ({
    host,
    run: async (command) =>
      command === edgeReadCommand(w.environment.plan.app.name)
        ? {
            exitCode: 0,
            stdout: `opscrew-edge-read 1\nproxy=caddy\n--origin--\n${cert}--site--\n--end--\n`,
            stderr: "",
          }
        : { exitCode: 255, stdout: "", stderr: "" },
  });
}

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.catch((e: unknown) => e);
  if (!(error instanceof OpsCrewError)) throw new Error(`expected a stop, got ${String(error)}`);
  return error;
}

/** The app's tunnel and Access in a root, as addresses. */
const TUNNEL = [
  "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
  "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared_config.this",
  "module.tunnel.random_password.secret",
];
const ACCESS = [
  "module.access.cloudflare_zero_trust_access_service_token.ssh[0]",
  "module.access.cloudflare_zero_trust_access_policy.ssh[0]",
  "module.access.cloudflare_zero_trust_access_application.ssh[0]",
];
const RECORD = `module.dns.cloudflare_dns_record.this["shop.${ZONE}"]`;
const ROUTE = `module.tunnel.cloudflare_dns_record.route["ssh-shop.${ZONE}"]`;
const R2 = ["cloudflare_r2_bucket.this"];
const R2_BACKUPS = ["cloudflare_r2_bucket.this", "cloudflare_r2_bucket_lifecycle.this"];

/** The approvals asked so far: kind, title and the typed name. */
function asked(w: FinishWorld) {
  return w.handler.requests.map((r) => [r.kind, r.title, r.confirmPhrase]);
}

/** The addresses left in A's former state of a root. */
async function leftIn(w: FinishWorld, name: Parameters<FinishWorld["rootOf"]>[0]) {
  const text = await readFile(shadowFiles(w.rootOf(name)).removalState, "utf8");
  return (JSON.parse(text) as { addresses: string[] }).addresses;
}

/** B's buckets holding every file of A's, as the finish's window and last copy leave them. */
function copiedToB(w: FinishWorld): void {
  const r2 = w.r2;
  if (r2 === undefined) throw new Error("no buckets");
  for (const bucket of [APP_BUCKET, BACKUPS_BUCKET]) {
    for (const [name, data] of r2.objects(w.old.id, bucket)) {
      r2.objects(w.fresh.id, bucket).set(name, data);
    }
  }
}

describe.skipIf(!findExecutable("git"))("removeA", () => {
  for (const target of ["cloud", "portainer"] as const) {
    it(`removes A's account-scoped pieces and buckets only, each approved with its name typed (${target})`, async () => {
      const w = await finishWorld(target, { buckets: true });
      const portainer = target === "portainer";
      w.old.tunnels.push({ id: A_TUNNEL, name: "opscrew-shop", connections: [] });
      await w.seedRemoval(
        "main",
        portainer
          ? [...TUNNEL, `module.tunnel.cloudflare_dns_record.route["shop.${ZONE}"]`]
          : [...SERVER_ADDRESSES, RECORD],
        portainer ? { tunnel_id: A_TUNNEL } : {},
      );
      await w.seedRemoval("storage", R2);
      await w.seedRemoval("backups", R2_BACKUPS);
      copiedToB(w);
      const copies: { dir: string; main: string }[] = [];
      const original = w.engine.plan.bind(w.engine);
      w.engine.plan = async (dir, planFile, options) => {
        if (dir.includes("a-removal")) {
          copies.push({ dir, main: await readFile(join(dir, "main.tf"), "utf8") });
        }
        return original(dir, planFile, options);
      };

      expect(await removeA(w.session, w.environment)).toBeUndefined();
      const deletions = [
        ...(portainer
          ? [
              [
                "iac-apply",
                "Delete shop's Cloudflare pieces (prod) in the Cloudflare account Old",
                "shop",
              ],
            ]
          : []),
        [
          "remote-exec",
          `Empty the bucket ${APP_BUCKET} in the current Cloudflare account Old`,
          APP_BUCKET,
        ],
        [
          "remote-exec",
          `Empty the bucket ${BACKUPS_BUCKET} in the current Cloudflare account Old`,
          BACKUPS_BUCKET,
        ],
        ["iac-apply", "Delete shop's bucket (prod) in the Cloudflare account Old", "shop"],
        [
          "iac-apply",
          "Delete shop's bucket of the snapshots' copies (prod) in the Cloudflare account Old",
          "shop",
        ],
      ];
      expect(asked(w)).toEqual(deletions);
      expect(w.handler.requests.every((r) => r.allowDestroy === true)).toBe(true);
      // Only A's account-scoped pieces were planned: A's record and the server stay out.
      expect(await leftIn(w, "main")).toEqual([]);
      expect(await leftIn(w, "storage")).toEqual([]);
      expect(await leftIn(w, "backups")).toEqual([]);
      const mainPlan = w.engine.planOptions.find((options) => options?.destroy === true);
      if (portainer) expect(mainPlan?.env?.CLOUDFLARE_API_TOKEN).toBe(w.tokens.a);
      // Each bucket root was planned from a copy without the guard; the committed root keeps it.
      const planned = copies;
      expect(planned.map((one) => one.dir.replaceAll("\\", "/"))).toEqual([
        expect.stringMatching(/cloudflare-move\/a-removal\/root\/storage$/),
        expect.stringMatching(/cloudflare-move\/a-removal\/root\/backups$/),
      ]);
      for (const one of planned) {
        expect(one.main).toContain("cloudflare_r2_bucket");
        expect(one.main).not.toContain("prevent_destroy");
      }
      const committed = await readFile(join(w.rootOf("storage").dir, "main.tf"), "utf8");
      expect(committed).toContain("prevent_destroy = true");
      await expect(readFile(join(planned[0]?.dir ?? "", "main.tf"))).rejects.toThrow();
      expect(Object.keys(Object.fromEntries(w.r2?.objects(w.old.id, APP_BUCKET) ?? []))).toEqual(
        [],
      );
      expect(w.r2?.objects(w.fresh.id, APP_BUCKET).size).toBe(3);
      expect(w.deps.audit.entries.map((e) => e.action)).toEqual(
        expect.arrayContaining(["A removed storage", "A removed backups"]),
      );
      // Nothing in A changed through Cloudflare's API: its zone is left to Cloudflare.
      expect(w.aWrites()).toEqual([]);

      // A run after the removal asks nothing again.
      const count = w.handler.requests.length;
      expect(await removeA(w.session, w.environment)).toBeUndefined();
      expect(w.handler.requests).toHaveLength(count);
      expect(w.leaks()).toBe(false);
    });
  }

  it("waits until A's tunnels have no connection before their removal (own server)", async () => {
    const w = await finishWorld("own");
    const tunnel = { id: A_TUNNEL, name: "opscrew-shop", connections: [connection()] };
    w.old.tunnels.push(tunnel);
    await w.seedRemoval("main", [...TUNNEL, ...ACCESS, ROUTE, RECORD], { tunnel_id: A_TUNNEL });
    const sleep = w.session.services.sleep as (ms: number) => Promise<void>;
    let removedWhileConnected = false;
    w.answers.approve = () => {
      removedWhileConnected = tunnel.connections.length > 0;
      return true;
    };
    const session = {
      ...w.session,
      services: {
        ...w.session.services,
        sleep: async (ms: number) => {
          tunnel.connections = [];
          await sleep(ms);
        },
      },
    };
    expect(await removeA(session, w.environment)).toBeUndefined();
    expect(removedWhileConnected).toBe(false);
    expect(w.deps.reporter.text()).toContain(
      "Cloudflare reports no active connections for the tunnel.",
    );
    expect(asked(w)).toEqual([
      ["iac-apply", "Delete shop's Cloudflare pieces (prod) in the Cloudflare account Old", "shop"],
    ]);
    const destroy = w.engine.planOptions.find((options) => options?.destroy === true);
    expect(destroy?.vars).toMatchObject({
      cloudflare_zone_id: w.cloudflare.zone(ZONE, "Old").id,
      cloudflare_account_id: w.old.id,
    });
    expect(await leftIn(w, "main")).toEqual([]);
    expect(w.aWrites()).toEqual([]);
    expect(w.leaks()).toBe(false);
  });

  it("waits for the tunnel in front of Portainer's webhook too", async () => {
    const w = await finishWorld("portainer");
    w.old.tunnels.push(
      { id: A_TUNNEL, name: "opscrew-shop", connections: [] },
      { id: A_WEBHOOK_TUNNEL, name: "opscrew-shop-portainer", connections: [] },
    );
    await w.seedRemoval("main", TUNNEL, {
      tunnel_id: A_TUNNEL,
      portainer_tunnel_id: A_WEBHOOK_TUNNEL,
    });
    expect(await removeA(w.session, w.environment)).toBeUndefined();
    const reads = w.cloudflare.calls.filter((call) => call.path.includes("/cfd_tunnel/"));
    expect(reads.map((call) => call.path.split("/").at(-1))).toEqual([A_TUNNEL, A_WEBHOOK_TUNNEL]);
    expect(w.leaks()).toBe(false);
  });

  it("deletes a site's Worker and custom domains in A, never its records", async () => {
    const w = await finishWorld("site");
    const worker = [
      "module.worker.cloudflare_workers_script.this",
      "module.worker.cloudflare_workers_custom_domain.domain[0]",
    ];
    await w.seedRemoval("main", worker);
    expect(await removeA(w.session, w.environment)).toBeUndefined();
    const [request] = w.handler.requests;
    expect(request?.details).toContain("module.worker.cloudflare_workers_script.this");
    expect(request?.confirmPhrase).toBe("example-app");
    expect(await leftIn(w, "main")).toEqual([]);
    expect(w.aWrites()).toEqual([]);
  });

  it("a refused typed name deletes nothing, keeps the app on B, and the step runs again", async () => {
    const w = await finishWorld("own");
    await w.seedRemoval("main", [...TUNNEL, ROUTE]);
    w.answers.approve = (request) =>
      request.confirmPhrase === undefined ? true : { approved: true, confirmation: "shp" };
    const error = await caught(removeA(w.session, w.environment));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(await leftIn(w, "main")).toEqual(TUNNEL);
    const plan = await readArtifact("plan", w.environment.paths.files.plan);
    expect(plan.cloudflareMove?.step).toBe("adopted");

    w.answers.approve = () => true;
    expect(await removeA(w.session, w.environment)).toBeUndefined();
    expect(await leftIn(w, "main")).toEqual([]);
    expect(w.leaks(error.message, error.hint ?? "")).toBe(false);
  });

  it("stops a script with the hash, the app's name to type, then applies with --approve", async () => {
    const w = await finishWorld("own");
    await w.seedRemoval("main", TUNNEL);
    const stop = await removeA(asScript(w), w.environment);
    const hash = stop?.pendingPlanHash ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stop?.next).toEqual([
      `Review the plan above, then run \`opscrew cloudflare move --finish --confirm shop --approve ${hash}\` to apply it and continue.`,
    ]);
    expect(await leftIn(w, "main")).toEqual(TUNNEL);
    expect(w.handler.requests).toEqual([]);

    expect(await removeA(asScript(w, hash), w.environment)).toBeUndefined();
    expect(await leftIn(w, "main")).toEqual([]);
  });

  it("stops before any bucket is emptied when a bucket root's guard can't be taken off", async () => {
    const w = await finishWorld("cloud", { buckets: true });
    await w.seedRemoval("main", [...SERVER_ADDRESSES, RECORD]);
    await w.seedRemoval("storage", R2);
    await w.seedRemoval("backups", R2_BACKUPS);
    copiedToB(w);
    const file = join(w.rootOf("storage").dir, "main.tf");
    const committed = await readFile(file, "utf8");
    await writeFile(
      file,
      committed.replace(
        "prevent_destroy = true",
        "prevent_destroy = true\n    ignore_changes  = [name]",
      ),
    );
    const error = await caught(removeA(w.session, w.environment));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe(
      "OpsCrew couldn't take the guard off the bucket in storage/main.tf for its removal, so it planned nothing. Nothing was changed.",
    );
    // No bucket root was planned.
    expect(w.engine.planDirs.filter((dir) => dir.includes("a-removal"))).toEqual([]);
    expect(await leftIn(w, "storage")).toEqual(R2);
    expect(w.r2?.objects(w.old.id, APP_BUCKET).size).toBe(3);
    expect(w.handler.requests).toEqual([]);
  });

  it("goes on after the storage bucket's deletion: nothing emptied twice, the backups bucket deleted", async () => {
    const w = await finishWorld("cloud", { buckets: true });
    await w.seedRemoval("main", [...SERVER_ADDRESSES, RECORD]);
    await w.seedRemoval("storage", R2);
    await w.seedRemoval("backups", R2_BACKUPS);
    copiedToB(w);
    w.answers.approve = (request) => !request.title.includes("snapshots' copies (prod)");
    const error = await caught(removeA(w.session, w.environment));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(await leftIn(w, "storage")).toEqual([]);
    expect(await leftIn(w, "backups")).toEqual(R2_BACKUPS);
    const deletes = () => w.r2?.runs.filter((run) => run.verb === "delete").length;
    expect(deletes()).toBe(2);

    w.answers.approve = () => true;
    w.handler.requests.length = 0;
    const runs = w.r2?.runs.length ?? 0;
    expect(await removeA(w.session, w.environment)).toBeUndefined();
    expect(deletes()).toBe(2);
    // The deleted storage bucket is never read again.
    expect(
      w.r2?.runs.slice(runs).map((run) => run.args.find((arg) => arg.startsWith("a:"))),
    ).toEqual([`a:${BACKUPS_BUCKET}`]);
    expect(asked(w)).toEqual([
      [
        "iac-apply",
        "Delete shop's bucket of the snapshots' copies (prod) in the Cloudflare account Old",
        "shop",
      ],
    ]);
    expect(await leftIn(w, "backups")).toEqual([]);
    expect(w.leaks()).toBe(false);
  });

  it("revokes A's origin certificate only once the server serves B's, then forgets A's record", async () => {
    const w = await finishWorld("cloud");
    await w.seedRemoval("main", [...SERVER_ADDRESSES, RECORD]);
    const aZone = w.cloudflare.zone(ZONE, "Old");
    aZone.data.originCertificates.push({
      id: "a-origin",
      hostnames: [`shop.${ZONE}`],
      expires_on: "2041-10-16 23:53:00 +0000 UTC",
      certificate: A_PEM,
    });
    const record = aSharedRecordPath(w.environment);
    await mkdir(dirname(record), { recursive: true });
    await writeFile(
      record,
      JSON.stringify({
        zoneId: aZone.id,
        hostnames: {},
        createdEntrypoints: [],
        tls: {
          origin: {
            id: "a-origin",
            hostnames: [`shop.${ZONE}`],
            expiresAt: "2041-10-16T23:53:00.000Z",
            sha256: fingerprintSha256(A_PEM),
            superseded: [],
          },
        },
      }),
    );
    const deps = { ...w.session.deps, paths: w.environment.paths };
    await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
    await writeFile(
      generatedValuesFile(deps),
      JSON.stringify({ originTls: { ORIGIN_TLS_CERT: B_PEM } }),
    );
    await mkdir(dirname(w.environment.paths.files.deployKey), { recursive: true });
    await writeFile(w.environment.paths.files.deployKey, "a placeholder deploy key\n");

    serving(w, A_PEM);
    expect(await removeA(w.session, w.environment)).toEqual({
      next: [
        "Once the deploy has brought the new origin certificate to the server, run `opscrew cloudflare move --finish` again.",
      ],
    });
    expect(w.handler.requests).toEqual([]);
    expect(aZone.data.originCertificates[0]?.revoked_at).toBeUndefined();
    expect(await readFile(record, "utf8")).toContain("a-origin");

    serving(w, B_PEM);
    expect(await removeA(w.session, w.environment)).toBeUndefined();
    expect(w.handler.requests).toEqual([
      expect.objectContaining({
        kind: "cloudflare-apply",
        allowDestroy: true,
        confirmPhrase: "shop",
      }),
    ]);
    expect(aZone.data.originCertificates[0]?.revoked_at).toBeDefined();
    expect(w.aWrites().map((call) => call.method)).toEqual(["DELETE"]);
    await expect(readFile(record)).rejects.toThrow();
    expect(w.leaks()).toBe(false);
  });

  it("refuses before the finish adopted the app in B, changing nothing", async () => {
    const w = await finishWorld("own", { step: "prepared" });
    await w.seedRemoval("main", TUNNEL);
    const error = await caught(removeA(w.session, w.environment));
    expect(error.message).toBe(
      "shop (prod) still runs on its pieces in the Cloudflare account Old: OpsCrew removes them only once the finish has moved the app to the new account. Nothing was changed.",
    );
    expect(w.engine.calls).toEqual([]);
    expect(await leftIn(w, "main")).toEqual(TUNNEL);
  });
});

/** A connection of a tunnel's connector. */
function connection() {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    colo_name: "fra",
    opened_at: "2026-11-20T10:00:00Z",
    origin_ip: "198.51.100.7",
  };
}

/** Writes the app's mark into B's zone, and another app's. */
async function marks(w: FinishWorld): Promise<void> {
  const name = await markName(w.session);
  for (const content of markContents(await appMark(w.session))) {
    w.cloudflare.addRecord(w.bZone, { type: "TXT", name, content, comment: MARK_COMMENT });
  }
  const other = markContents({
    app: "blog",
    envs: ["prod"],
    hosts: [`blog.${ZONE}`],
    sites: [],
    access: [],
  });
  for (const content of other) {
    w.cloudflare.addRecord(w.bZone, {
      type: "TXT",
      name: `_opscrew-move.blog-1234abcd.${ZONE}`,
      content,
      comment: MARK_COMMENT,
    });
  }
}

/** The TXT records of marks in B's zone, by name. */
function markNames(w: FinishWorld): string[] {
  return w.bZone.records.filter((r) => r.type === "TXT").map((r) => r.name);
}

describe.skipIf(!findExecutable("git"))("endFinish", () => {
  it("deletes the app's mark, the move's local files and its record, and names the variables", async () => {
    const w = await finishWorld("cloud", { buckets: true });
    await marks(w);
    await w.seedRemoval("main", []);
    await w.seedRemoval("storage", []);
    await w.seedRemoval("backups", []);
    await writePending(
      w.session.deps,
      { action: "a-removal", environment: "prod", root: "main" },
      "a".repeat(64),
    );
    const folder = join(w.environment.paths.stateDir, "cloudflare-move");
    await writeFile(join(folder, "cloudflare.json"), "{}\n");

    const result = await endFinish(w.session);
    expect(result).toMatchObject({ step: "finished", done: true });
    expect(markNames(w)).toEqual([`_opscrew-move.blog-1234abcd.${ZONE}`]);
    const plan = await readArtifact("plan", w.environment.paths.files.plan);
    expect(plan.cloudflareMove).toBeUndefined();
    await expect(readFile(join(folder, "cloudflare.json"))).rejects.toThrow();
    await expect(readFile(appProgressFile(w.session.paths))).rejects.toThrow();
    expect(result.next).toEqual([
      `Once blog in ${ZONE} has finished its move too, give these variables the new account's values wherever you run OpsCrew (this computer, your scripts):`,
      "  CLOUDFLARE_API_TOKEN: the value of OPSCREW_NEW_CLOUDFLARE_API_TOKEN; then remove OPSCREW_NEW_CLOUDFLARE_API_TOKEN.",
      "  OPSCREW_STORAGE_ACCESS_KEY_ID: the value of OPSCREW_NEW_STORAGE_ACCESS_KEY_ID; then remove OPSCREW_NEW_STORAGE_ACCESS_KEY_ID.",
      "  OPSCREW_STORAGE_SECRET_ACCESS_KEY: the value of OPSCREW_NEW_STORAGE_SECRET_ACCESS_KEY; then remove OPSCREW_NEW_STORAGE_SECRET_ACCESS_KEY.",
      "  OPSCREW_OFFSITE_ACCESS_KEY_ID: the value of OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID; then remove OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID.",
      "  OPSCREW_OFFSITE_SECRET_ACCESS_KEY: the value of OPSCREW_NEW_OFFSITE_SECRET_ACCESS_KEY; then remove OPSCREW_NEW_OFFSITE_SECRET_ACCESS_KEY.",
    ]);
    expect(w.handler.requests.map((r) => r.kind)).toEqual(["cloudflare-apply"]);
    expect(w.aWrites()).toEqual([]);
    expect(w.leaks(...result.next)).toBe(false);
  });

  it("says now, and names a site's deploy token, when no other app is left to move", async () => {
    const w = await finishWorld("site");
    await w.seedRemoval("main", []);
    const result = await endFinish(w.session);
    expect(result.next[0]).toBe(
      `Every OpsCrew app in ${ZONE} has finished its move, so now give these variables the new account's values wherever you run OpsCrew (this computer, your scripts):`,
    );
    expect(result.next.at(-1)).toBe(
      `  OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: the value of ${NEW_DEPLOY_TOKEN_VAR}; then remove ${NEW_DEPLOY_TOKEN_VAR}.`,
    );
    expect(w.handler.requests).toEqual([]);
  });

  it("keeps the files and the record while A's former state still holds pieces", async () => {
    const w = await finishWorld("own");
    await marks(w);
    await w.seedRemoval("main", TUNNEL);
    const error = await caught(endFinish(w.session));
    expect(error.message).toContain("still holds pieces of shop OpsCrew hasn't removed");
    expect(error.message).toContain("Nothing was changed.");
    expect(await leftIn(w, "main")).toEqual(TUNNEL);
    // A refused end changes nothing: the mark stays, and no approval was asked.
    expect(markNames(w)).toHaveLength(2);
    expect(w.handler.requests).toEqual([]);
    const plan = await readArtifact("plan", w.environment.paths.files.plan);
    expect(plan.cloudflareMove?.step).toBe("adopted");

    // Once A's pieces are removed, the end goes on where it stopped.
    await w.seedRemoval("main", []);
    expect(await endFinish(w.session)).toMatchObject({ step: "finished", done: true });
  });

  it("refuses while A's origin certificate is still to be revoked, changing nothing", async () => {
    const w = await finishWorld("cloud");
    await marks(w);
    await w.seedRemoval("main", []);
    const record = aSharedRecordPath(w.environment);
    await mkdir(dirname(record), { recursive: true });
    await writeFile(record, "{}\n");
    const error = await caught(endFinish(w.session));
    expect(error.message).toBe(
      "The origin certificate of shop (prod) in the Cloudflare account Old isn't revoked yet, so the move can't end. Nothing was changed.",
    );
    expect(markNames(w)).toHaveLength(2);
    expect(await readFile(record, "utf8")).toBe("{}\n");
    expect(w.handler.requests).toEqual([]);
  });

  it("refuses before every environment is adopted in B", async () => {
    const w = await finishWorld("own", { step: "prepared" });
    await marks(w);
    const error = await caught(endFinish(w.session));
    expect(error.message).toBe(
      "The finish hasn't moved shop (prod) to the new account yet, so the move can't end. Nothing was changed.",
    );
    expect(markNames(w)).toHaveLength(2);
    expect(w.handler.requests).toEqual([]);
  });
});

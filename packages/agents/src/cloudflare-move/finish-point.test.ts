import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { findExecutable, fingerprintSha256, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  NEW_OFFSITE_KEY_VARS,
  NEW_STORAGE_KEY_VARS,
  OFFSITE_KEY_VARS,
  STORAGE_KEY_VARS,
} from "../provision/storage";
import { r2Endpoint } from "../shared";
import { generatedValuesFile } from "../shared/app-secrets";
import { BACKUPS_BUCKET } from "./buckets.fakes";
import { backToA, lastCopyOnce, pointAtB } from "./finish-point";
import { type FinishWorld, finishWorld } from "./finish-removal.fakes";
import { ZONE } from "./session.fakes";

/** An origin certificate issued in New, and the app's client certificate. */
const B_PEM = pem("the certificate issued in New");
const PULL_PEM = pem("the app's client certificate");
const ORIGIN_KEY = fakeSecret("private-key-pem", "b-origin");
const PULL_KEY = fakeSecret("private-key-pem", "client");
/** The app's own value on the server, besides its bucket's settings. */
const APP_KEY = fakeSecret("generic-password", "app-key");

function pem(text: string): string {
  return `-----BEGIN CERTIFICATE-----\n${Buffer.from(text).toString("base64")}\n-----END CERTIFICATE-----\n`;
}

/** A bucket's login as the environment holds it: the key's two parts. */
function key(w: FinishWorld, vars: { accessKeyId: string; secretAccessKey: string }) {
  return {
    accessKeyId: w.deps.env[vars.accessKeyId] ?? "",
    secretAccessKey: w.deps.env[vars.secretAccessKey] ?? "",
  };
}

/** The app's settings as a deploy writes them, with the bucket's key and endpoint of `account`. */
function appEnv(login: { accessKeyId: string; secretAccessKey: string }, account: string): string {
  return [
    `APP_KEY=${APP_KEY}`,
    `AWS_ACCESS_KEY_ID=${login.accessKeyId}`,
    `AWS_ENDPOINT_URL_S3=${r2Endpoint(account)}`,
    "AWS_REGION=auto",
    `AWS_SECRET_ACCESS_KEY=${login.secretAccessKey}`,
    "S3_BUCKET=shop-uploads",
    "",
  ].join("\n");
}

/**
 * The cloud server with both buckets on R2, prepared, after the switch: its server's `app.env`
 * on A's bucket (`cat` answers it; a successful deploy writes GitHub's), B's record and origin
 * certificate taken already, the recovery copy's age key known.
 */
async function pointWorld() {
  const w = await finishWorld("cloud", { buckets: true, step: "prepared" });
  const a = { storage: key(w, STORAGE_KEY_VARS), backups: key(w, OFFSITE_KEY_VARS) };
  const b = { storage: key(w, NEW_STORAGE_KEY_VARS), backups: key(w, NEW_OFFSITE_KEY_VARS) };
  const server = { appEnv: appEnv(a.storage, w.old.id) };
  const inner = w.session.services.remote as (host: string) => RemoteExec;
  w.session.services.remote = (host) => ({
    host,
    run: async (command, options): Promise<CommandResult> =>
      command === "cat /srv/apps/shop/app.env"
        ? { exitCode: 0, stdout: server.appEnv, stderr: "" }
        : inner(host).run(command, options),
  });
  w.github.deploy = () => {
    server.appEnv = w.github.secrets.get("OPSCREW_APP_ENV") ?? "";
  };
  const { paths } = w.environment;
  await writeFile(join(paths.stateDir, "recovery.json"), '{"recipients":["age1recipient"]}\n');
  const host = `shop.${ZONE}`;
  await writeFile(
    paths.files.cloudflareRecord,
    JSON.stringify({
      zoneId: w.bZone.id,
      hostnames: {},
      createdEntrypoints: [],
      tls: {
        origin: {
          id: "b-origin",
          hostnames: [host],
          expiresAt: "2041-10-16T23:53:00.000Z",
          sha256: fingerprintSha256(B_PEM),
          superseded: [],
        },
        client: {
          id: "client",
          expiresAt: "2041-10-16T23:53:00.000Z",
          sha256: fingerprintSha256(PULL_PEM),
          enabled: [host],
          retiring: [],
        },
      },
    }),
  );
  const values = generatedValuesFile({ paths });
  await mkdir(dirname(values), { recursive: true });
  await writeFile(
    values,
    JSON.stringify({
      originTls: {
        ORIGIN_TLS_KEY: ORIGIN_KEY,
        ORIGIN_TLS_CERT: B_PEM,
        ORIGIN_PULL_KEY: PULL_KEY,
        ORIGIN_PULL_CERT: PULL_PEM,
      },
    }),
  );
  const secrets = [
    ...Object.values(a).flatMap((one) => [one.accessKeyId, one.secretAccessKey]),
    ...Object.values(b).flatMap((one) => [one.accessKeyId, one.secretAccessKey]),
    ORIGIN_KEY,
    PULL_KEY,
    APP_KEY,
  ];
  /** True when a key, the app's values or the origin's key was said, asked or audited. */
  const leaks = (...texts: string[]) => {
    const said = [
      ...texts,
      w.deps.reporter.text(),
      JSON.stringify(w.deps.audit.entries),
      JSON.stringify(w.handler.requests),
    ].join("\n");
    return w.leaks(...texts) || secrets.some((secret) => said.includes(secret));
  };
  return { ...w, a, b, server, leaks };
}

describe.skipIf(!findExecutable("git"))("pointAtB on a server", () => {
  it("gives the deploy secrets B's values in one approval, names only, then deploys once", async () => {
    const w = await pointWorld();
    const point = await pointAtB(w.session, w.environment);
    expect(point).toMatchObject({ done: false, pointing: false });
    expect(point.asks?.hash).toMatch(/^[0-9a-f]{64}$/);

    await point.secrets();
    expect(w.handler.requests.map((r) => [r.kind, r.title])).toEqual([
      [
        "github-secrets",
        "Give the deploy secrets of prod their values for the Cloudflare account New",
      ],
    ]);
    const [request] = w.handler.requests;
    expect(request?.planHash).toBe(point.asks?.hash);
    for (const name of ["OPSCREW_APP_ENV", "OPSCREW_OFFSITE_ENV", "OPSCREW_ORIGIN_TLS"]) {
      expect(request?.details).toContain(`  ${name}`);
    }
    // The app's settings keep everything but the bucket's key and endpoint, which are B's.
    expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(appEnv(w.b.storage, w.fresh.id));
    const offsite = w.github.secrets.get("OPSCREW_OFFSITE_ENV") ?? "";
    expect(offsite).toContain(`=${r2Endpoint(w.fresh.id)}`);
    expect(offsite).toContain(`=${w.b.backups.secretAccessKey}`);
    expect(offsite).not.toContain(w.a.backups.secretAccessKey);
    expect(w.github.secrets.get("OPSCREW_ORIGIN_TLS")).toBe(`${B_PEM}${ORIGIN_KEY}`);
    expect(w.github.dispatches).toEqual([]);

    await point.deploy();
    expect(w.github.dispatches).toEqual([{ workflowFile: "opscrew-deploy.yml", ref: "main" }]);
    expect(w.server.appEnv).toBe(appEnv(w.b.storage, w.fresh.id));

    // A run after it finds the app on B's values: nothing asked, nothing deployed again.
    const again = await pointAtB(w.session, w.environment);
    expect(again).toMatchObject({ done: true, pointing: true });
    expect(again.asks).toBeUndefined();
    await again.secrets();
    await again.deploy();
    expect(w.handler.requests).toHaveLength(1);
    expect(w.github.dispatches).toHaveLength(1);
    expect(w.leaks()).toBe(false);
  });

  it("puts A's bucket settings back without a deploy or an approval, and keeps B's origin certificate", async () => {
    const w = await pointWorld();
    // Nothing of B's written yet: nothing to put back.
    await backToA(w.session, w.environment);
    expect(w.github.secrets.size).toBe(0);

    const point = await pointAtB(w.session, w.environment);
    await point.secrets();
    const asked = w.handler.requests.length;
    await backToA(w.session, w.environment);
    expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(appEnv(w.a.storage, w.old.id));
    const offsite = w.github.secrets.get("OPSCREW_OFFSITE_ENV") ?? "";
    expect(offsite).toContain(`=${r2Endpoint(w.old.id)}`);
    expect(offsite).toContain(`=${w.a.backups.secretAccessKey}`);
    expect(w.github.secrets.get("OPSCREW_ORIGIN_TLS")).toBe(`${B_PEM}${ORIGIN_KEY}`);
    expect(w.handler.requests).toHaveLength(asked);
    expect(w.github.dispatches).toEqual([]);

    // The next window asks for B's values again.
    const next = await pointAtB(w.session, w.environment);
    expect(next.asks?.hash).toBe(point.asks?.hash);
    expect(w.leaks()).toBe(false);
  });

  it("stops plainly, naming no address, when the server's settings can't be read", async () => {
    const w = await pointWorld();
    w.session.services.remote = (host) => ({
      host,
      run: async () => ({ exitCode: 1, stdout: "", stderr: `cat: ${host}: Permission denied` }),
    });
    const error = await pointAtB(w.session, w.environment).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      "OpsCrew could not read the app's settings on the app's server: cat: the app's server: Permission denied.",
    );
    expect(w.leaks((error as OpsCrewError).message)).toBe(false);
  });

  it("copies the snapshots' copies once more after the deploy, then never again", async () => {
    const w = await pointWorld();
    const point = await pointAtB(w.session, w.environment);
    await point.secrets();
    await point.deploy();
    expect(await lastCopyOnce(w.session, w.environment)).toBeUndefined();
    const copies = () => w.r2?.runs.filter((run) => run.verb === "copy").length;
    expect(copies()).toBe(1);
    expect(w.r2?.objects(w.fresh.id, BACKUPS_BUCKET).size).toBe(2);
    const asked = w.handler.requests.length;
    expect(await lastCopyOnce(w.session, w.environment)).toBeUndefined();
    expect(copies()).toBe(1);
    expect(w.handler.requests).toHaveLength(asked);
    expect(w.leaks()).toBe(false);
  });
});

describe.skipIf(!findExecutable("git"))("pointAtB elsewhere", () => {
  it("stops before any change for off-server copies on R2 in Portainer, which it can't point yet", async () => {
    const w = await finishWorld("portainer", { buckets: true, step: "prepared" });
    const error = await pointAtB(w.session, w.environment).catch((e: unknown) => e);
    expect((error as OpsCrewError).message).toBe(
      "OpsCrew can't give the off-server copies of shop (prod) in your Portainer their bucket in the new Cloudflare account yet, so the finish stopped. Nothing was changed.",
    );
    expect(w.handler.requests).toEqual([]);
  });

  it("has nothing to point for a site or an own server without buckets or origin certificate", async () => {
    for (const target of ["site", "own"] as const) {
      const w = await finishWorld(target, { step: "prepared" });
      const point = await pointAtB(w.session, w.environment);
      expect(point).toMatchObject({ done: true });
      expect(point.asks).toBeUndefined();
      await point.secrets();
      await point.deploy();
      expect(w.handler.requests).toEqual([]);
      expect(w.github.dispatches).toEqual([]);
    }
  });
});

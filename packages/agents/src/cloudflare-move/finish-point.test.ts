import { findExecutable, OpsCrewError } from "@opscrew/core";
import { PORTAINER_OFFSITE_VARIABLES, PORTAINER_STACK_VARIABLES } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { r2Endpoint } from "../shared";
import { appEnvText } from "../shared/app-env";
import { readAppValues, writeAppValues } from "../values/record";
import { BACKUPS_BUCKET } from "./buckets.fakes";
import {
  A_TUNNEL_TOKEN,
  APP_KEY,
  appEnv,
  B_PEM,
  ORIGIN_KEY,
  portainerFinishWorld,
  serverPointWorld,
} from "./finish.fakes";
import { backToA, lastCopyOnce, pointAtB } from "./finish-point";
import { finishWorld } from "./finish-removal.fakes";
import { environmentDeps } from "./texts";

describe.skipIf(!findExecutable("git"))("pointAtB on a server", () => {
  it("gives the deploy secrets B's values in one approval, names only, then deploys once", async () => {
    const w = await serverPointWorld();
    const point = await pointAtB(w.session, w.environment);
    expect(point).toMatchObject({ done: false, pointing: false });
    expect(point.asks?.hash).toMatch(/^[0-9a-f]{64}$/);

    await point.approve();
    expect(w.github.secrets.size).toBe(0);
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
    await again.approve();
    await again.secrets();
    await again.deploy();
    expect(w.handler.requests).toHaveLength(1);
    expect(w.github.dispatches).toHaveLength(1);
    expect(w.leaks()).toBe(false);
  });

  it("keeps OpsCrew's record of the app's values with the settings it stores (048)", async () => {
    const w = await serverPointWorld();
    const deps = environmentDeps(w.session, w.environment);
    await writeAppValues(deps, { app: { STALE: "x" }, build: {} });
    const point = await pointAtB(w.session, w.environment);
    await point.approve();
    await point.secrets();
    const record = await readAppValues(deps);
    expect(appEnvText(record?.app ?? {})).toBe(w.github.secrets.get("OPSCREW_APP_ENV"));
  });

  it("writes nothing when what it would write no longer has the approved hash, or without the approval", async () => {
    const w = await serverPointWorld();
    const point = await pointAtB(w.session, w.environment);
    const unapproved = await point.secrets().catch((e: unknown) => e);
    expect((unapproved as OpsCrewError).code).toBe("INTERNAL");
    await point.approve();
    // The server's settings changed since the approval.
    w.server.appEnv = `${w.server.appEnv}NEW_SETTING=1\n`;
    const error = await point.secrets().catch((e: unknown) => e);
    expect((error as OpsCrewError).message).toBe(
      "What the deploy secrets of prod would hold for the Cloudflare account New changed since you approved it, so OpsCrew wrote none of them.",
    );
    expect(w.github.secrets.size).toBe(0);
    expect(w.leaks((error as OpsCrewError).message)).toBe(false);
  });

  it("tells by each bucket variable whether the server reads B's bucket already", async () => {
    const w = await serverPointWorld();
    // B's key and endpoint, the lines in another order and another value beside them.
    w.server.appEnv = `ZZZ=1\n${appEnv(w.b.storage, w.fresh.id).split("\n").reverse().join("\n")}\n`;
    expect((await pointAtB(w.session, w.environment)).pointing).toBe(true);
    // B's key with A's endpoint: not yet.
    w.server.appEnv = appEnv(w.b.storage, w.old.id);
    expect((await pointAtB(w.session, w.environment)).pointing).toBe(false);
  });

  it("puts A's bucket settings back without a deploy or an approval, and keeps B's origin certificate", async () => {
    const w = await serverPointWorld();
    // No record of A's values: they are written (a write of B's may have stopped part-way), once.
    await backToA(w.session, w.environment);
    expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(appEnv(w.a.storage, w.old.id));
    const written = w.deps.audit.entries.length;
    await backToA(w.session, w.environment);
    expect(w.deps.audit.entries).toHaveLength(written);

    const point = await pointAtB(w.session, w.environment);
    await point.approve();
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

  it("hides the app's secret values once it read them, never its bucket's name, region or endpoint", async () => {
    const w = await serverPointWorld();
    await pointAtB(w.session, w.environment);
    const shown = w.deps.redactor.redact(w.server.appEnv);
    expect(shown).not.toContain(APP_KEY);
    expect(shown).not.toContain(w.a.storage.secretAccessKey);
    for (const line of [
      "S3_BUCKET=shop-uploads",
      "AWS_REGION=auto",
      `AWS_ENDPOINT_URL_S3=${r2Endpoint(w.old.id)}`,
    ]) {
      expect(shown).toContain(line);
    }
  });

  it("stops plainly, naming no address, when the server's settings can't be read", async () => {
    const w = await serverPointWorld();
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
    const w = await serverPointWorld();
    const point = await pointAtB(w.session, w.environment);
    await point.approve();
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

describe.skipIf(!findExecutable("git"))("pointAtB in Portainer", () => {
  it("plans the app's stacks once with B's bucket keys and endpoints, approved by hash, values never shown", async () => {
    const w = await portainerFinishWorld();
    const point = await pointAtB(w.session, w.environment);
    expect(point).toMatchObject({ done: false, pointing: false });
    const hash = point.asks?.hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.portainer.stacks).toEqual([]);

    await point.approve();
    expect(w.handler.requests.map((r) => [r.kind, r.planHash])).toEqual([["stack-apply", hash]]);
    await point.secrets();
    expect(w.portainer.stacks).toEqual([]);
    await point.deploy();
    const stack = w.appStack();
    const endpoint = r2Endpoint(w.fresh.id);
    const v = PORTAINER_OFFSITE_VARIABLES;
    expect(stack).toMatchObject({
      AWS_ACCESS_KEY_ID: w.keys.b.storage.accessKeyId,
      AWS_SECRET_ACCESS_KEY: w.keys.b.storage.secretAccessKey,
      AWS_ENDPOINT_URL_S3: endpoint,
      [v.endpoint]: endpoint,
      [v.accessKeyId]: w.keys.b.backups.accessKeyId,
      [v.secretAccessKey]: w.keys.b.backups.secretAccessKey,
      [PORTAINER_STACK_VARIABLES.tunnelToken]: A_TUNNEL_TOKEN,
    });
    const held = Object.values(stack);
    for (const key of Object.values(w.keys.a)) {
      expect(held).not.toContain(key.accessKeyId);
      expect(held).not.toContain(key.secretAccessKey);
    }

    // The stacks hold B's values now: nothing is planned or asked again.
    const again = await pointAtB(w.session, w.environment);
    expect(again).toMatchObject({ done: true, pointing: true });
    expect(again.asks).toBeUndefined();
    expect(w.handler.requests).toHaveLength(1);
    expect(await w.leaks()).toBe(false);
  });

  it("changes nothing in Portainer when its stack plan is refused", async () => {
    const w = await portainerFinishWorld();
    w.answers.approve = () => false;
    const point = await pointAtB(w.session, w.environment);
    const error = await point.approve().catch((e: unknown) => e);
    expect((error as OpsCrewError).code).toBe("APPROVAL_REFUSED");
    expect(await point.deploy().catch((e: unknown) => (e as OpsCrewError).code)).toBe("INTERNAL");
    expect((error as OpsCrewError).message).toContain("Nothing in Portainer was changed.");
    expect(w.portainer.stacks).toEqual([]);
    expect(await w.leaks((error as OpsCrewError).message)).toBe(false);
  });
});

describe.skipIf(!findExecutable("git"))("pointAtB elsewhere", () => {
  it("has nothing to point for a site or an own server without buckets or origin certificate", async () => {
    for (const target of ["site", "own"] as const) {
      const w = await finishWorld(target, { step: "prepared" });
      const point = await pointAtB(w.session, w.environment);
      expect(point).toMatchObject({ done: true });
      expect(point.asks).toBeUndefined();
      await point.approve();
      await point.secrets();
      await point.deploy();
      expect(w.handler.requests).toEqual([]);
      expect(w.github.dispatches).toEqual([]);
    }
  });
});

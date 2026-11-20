import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  knownHostsName,
  type OwnServerConnectionInput,
  readOwnServer,
  recordOwnServer,
  type SharesReference,
  serverAddressesFile,
} from "../shared";
import {
  createTestPhaseDeps,
  ED25519,
  ED25519_FINGERPRINT,
  ownPlan,
  previewTestPlan,
  SERVER_IPV4,
  sharedServerProject,
} from "../testing";
import { ownFirstApp, recordOwnFirstApp } from "./own-first-app";
import { firstAppPaths } from "./reference";

const PORT = 2222;

/**
 * A first app, `shop`, provisioned on this computer on a server the user owns at
 * {@link SERVER_IPV4}, SSH port {@link PORT}: its plan (`plan`, by default proxied), its record
 * (`record` over the default login with a key file) and the server's host key pinned for it.
 */
async function ownFirst(o: { plan?: DeployPlan; record?: Partial<OwnServerConnectionInput> } = {}) {
  const deps = await createTestPhaseDeps();
  const ref: SharesReference = {
    root: await mkdtemp(join(tmpdir(), "opscrew-own-first-app-")),
    environment: "prod",
  };
  const first = firstAppPaths(deps.paths, ref);
  await writeArtifact("plan", first.files.plan, o.plan ?? ownPlan({ deployed: true }));
  const keyPath = join(ref.root, "..", "keys-of-the-user", "id_ed25519");
  const key = fakeSecret("private-key-pem", "the-user-s-own-key");
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, key, { mode: 0o600 });
  await recordOwnServer(first, {
    host: SERVER_IPV4,
    port: PORT,
    user: "admin",
    agent: false,
    keyPath,
    reachable: true,
    serve: "proxy",
    hostKey: ED25519_FINGERPRINT,
    publicIpv4: SERVER_IPV4,
    ...o.record,
  });
  await mkdir(dirname(first.files.knownHosts), { recursive: true });
  await writeFile(
    first.files.knownHosts,
    `${knownHostsName(SERVER_IPV4, PORT)} ssh-ed25519 ${ED25519}\n`,
  );
  return { deps, ref, first, keyPath, key };
}

type OwnFirst = Awaited<ReturnType<typeof ownFirst>>;

/** Expects `ownFirstApp` to refuse before any change with `message`; answers the error. */
async function refuses(project: OwnFirst, message: RegExp) {
  const error = await ownFirstApp(project.deps, project.ref).then(
    () => undefined,
    (thrown: unknown) => thrown as { code: string; message: string; hint?: string },
  );
  expect(error).toMatchObject({ code: "PHASE_PRECONDITION", message });
  expect(error?.message).toMatch(/Nothing was changed\.$/);
  for (const hidden of [SERVER_IPV4, project.keyPath, project.key]) {
    expect(JSON.stringify(error)).not.toContain(hidden);
  }
  return error;
}

describe("ownFirstApp", () => {
  it("reads the server's login, way of serving and pinned host key behind Cloudflare's proxy", async () => {
    const project = await ownFirst();
    const own = await ownFirstApp(project.deps, project.ref);
    expect(own?.plan.app.name).toBe("shop");
    expect(own?.paths).toEqual(project.first);
    expect(own?.answers).toEqual({
      host: SERVER_IPV4,
      port: PORT,
      user: "admin",
      agent: false,
      keyPath: project.keyPath,
      reachable: true,
      serve: "proxy",
    });
    expect(own?.hostKey).toEqual({
      type: "ssh-ed25519",
      key: ED25519,
      fingerprint: ED25519_FINGERPRINT,
    });
    // The key is read by path only, never opened.
    expect(JSON.stringify(own)).not.toContain(project.key);
  });

  it("serves DNS only as the first app does, and takes the SSH agent", async () => {
    const project = await ownFirst({
      plan: ownPlan({ deployed: true, proxied: false }),
      record: { agent: true, keyPath: undefined, serve: "dns-only" },
    });
    const own = await ownFirstApp(project.deps, project.ref);
    expect(own?.answers).toEqual({
      host: SERVER_IPV4,
      port: PORT,
      user: "admin",
      agent: true,
      reachable: true,
      serve: "dns-only",
    });
  });

  it("records the server as this app's own, with the host key pinned and no reference kept", async () => {
    const project = await ownFirst();
    const own = await ownFirstApp(project.deps, project.ref);
    if (own === undefined) throw new Error("no own first app");
    const { paths } = project.deps;
    await recordOwnFirstApp(paths, own);
    expect(await readOwnServer(paths)).toEqual({
      host: SERVER_IPV4,
      port: PORT,
      user: "admin",
      agent: false,
      keyPath: project.keyPath,
      reachable: true,
      serve: "proxy",
      hostKey: ED25519_FINGERPRINT,
      publicIpv4: SERVER_IPV4,
    });
    expect(await readFile(paths.files.knownHosts, "utf8")).toBe(
      `${knownHostsName(SERVER_IPV4, PORT)} ssh-ed25519 ${ED25519}\n`,
    );
    expect(await readFile(serverAddressesFile(paths), "utf8")).not.toContain(project.key);
  });

  it("leaves an app on a server OpsCrew created, and a second app there, to firstApp", async () => {
    const created = await sharedServerProject();
    expect(await ownFirstApp(created.deps, created.ref)).toBeUndefined();
    // A second app on a created server: its plan's target names the first app.
    const base = ownPlan({ deployed: true });
    const second = await ownFirst({
      plan: DeployPlanSchema.parse({
        ...base,
        app: { ...base.app, name: "blog" },
        target: { ...base.target, shares: { app: "shop", provider: "hetzner" } },
      }),
    });
    expect(await ownFirstApp(second.deps, second.ref)).toBeUndefined();
    // Its record names the first app's folder.
    const recorded = await ownFirst({
      record: {
        user: "deploy",
        reachable: undefined,
        serve: undefined,
        shares: { root: created.ref.root },
      },
    });
    expect(await ownFirstApp(recorded.deps, recorded.ref)).toBeUndefined();
    // No plan at all.
    await rm(recorded.first.files.plan);
    expect(await ownFirstApp(recorded.deps, recorded.ref)).toBeUndefined();
  });

  it("refuses an app served through a Cloudflare Tunnel, pointing to the server's own login", async () => {
    const tunnel = await ownFirst({
      plan: ownPlan({ deployed: true, access: "tunnel" }),
      record: { reachable: false, serve: undefined },
    });
    const error = await refuses(tunnel, /^"shop" is served through a Cloudflare Tunnel/);
    expect(error?.hint).toMatch(/server questions with your server's own login instead/);
    expect(error?.hint).toMatch(/several apps on one server of yours work through the tunnel/);
    // A record that says the internet can't reach the server is the tunnel too.
    const unreachable = await ownFirst({ record: { reachable: false } });
    await refuses(unreachable, /Cloudflare Tunnel/);
  });

  it("refuses a server at home, pointing to the server's own login", async () => {
    const base = ownPlan({ deployed: true });
    const home = await ownFirst({
      plan: DeployPlanSchema.parse({
        ...base,
        target: { ...base.target, home: { ipv4: true } },
        environment: { runner: "server" },
      }),
      record: { reachable: undefined, publicIpv4: undefined, home: {} },
    });
    const error = await refuses(home, /^"shop" runs on a server at your home/);
    expect(error?.hint).toMatch(/server questions with your server's own login instead/);
  });

  it("refuses an app in the middle of a move to another server", async () => {
    const base = ownPlan({ deployed: true });
    const project = await ownFirst({
      plan: DeployPlanSchema.parse({
        ...base,
        retarget: {
          from: { target: base.target },
          step: "created",
          startedAt: "2026-11-05T12:00:00.000Z",
        },
      }),
    });
    const error = await refuses(project, /^"shop" is in the middle of a move to another server/);
    expect(error?.hint).toMatch(/opscrew retarget --finish/);
  });

  it("refuses a preview environment", async () => {
    const project = await ownFirst({ plan: previewTestPlan({ own: true }) });
    await refuses(project, /^"shop-preview" is a preview environment/);
  });

  it("refuses an app not provisioned, or whose login or pinned key this computer lacks", async () => {
    const notYet = await ownFirst({ plan: ownPlan() });
    const error = await refuses(notYet, /^"shop" is not provisioned on this computer/);
    expect(error?.hint).toContain("`opscrew provision`");
    const noRecord = await ownFirst();
    await rm(serverAddressesFile(noRecord.first));
    await refuses(noRecord, /^This computer does not have the login of "shop"'s server\./);
    const noKey = await ownFirst();
    await rm(noKey.first.files.knownHosts);
    await refuses(noKey, /^This computer does not have the pinned SSH host key/);
    // A known_hosts line for another key than the one pinned in the record is no pin.
    const otherKey = await ownFirst({ record: { hostKey: undefined } });
    await refuses(otherKey, /pinned SSH host key/);
  });
});

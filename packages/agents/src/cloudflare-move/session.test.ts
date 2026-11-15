import { findExecutable, OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { appPlan } from "../apps/__fixtures__/sites";
import { projectEngine } from "../shared";
import { ownPlan, portainerPlan, previewTestPlan, testPlan } from "../testing";
import { accountNeeds, checkMoveStart, otherAppHostnames } from "./checks";
import { bSetup } from "./session";
import {
  type MoveHarness,
  moveHarness,
  OTHER_ZONE,
  recordedMove,
  STALE_ZONE,
  serverPlan,
  unencrypted,
  ZONE,
} from "./session.fakes";
import { B_TOKEN_VAR } from "./texts";

/** prod and staging in the zone, dev in another zone, old in the zone and never deployed. */
const SEVERAL = () => ({
  prod: serverPlan(),
  dev: serverPlan(`dev.${OTHER_ZONE}`, "dev"),
  old: serverPlan(`old.shop.${ZONE}`, "old", false),
  staging: serverPlan(`staging.shop.${ZONE}`, "staging"),
});

/** The refusal `run` stops with, checked to have changed nothing and leaked nothing. */
async function refused(h: MoveHarness, run: Promise<unknown>): Promise<OpsCrewError> {
  const error = await run.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  const { message, hint } = error as OpsCrewError;
  expect(message).toMatch(/Nothing was changed\.$/);
  expect(hint).toBeTruthy();
  expect(h.readOnly()).toBe(true);
  expect(h.leaks(message, hint ?? "")).toBe(false);
  return error as OpsCrewError;
}

/** Each zone lookup named its account. */
function zonesByAccount(h: MoveHarness): boolean {
  return h.cloudflare.calls
    .filter((call) => call.method === "GET" && call.path.startsWith("/zones?"))
    .every((call) => call.path.includes("account.id="));
}

describe.skipIf(!findExecutable("git"))("openMoveSession", () => {
  it("covers every deployed environment in the zone and names those staying and skipped", async () => {
    const h = await moveHarness({ plans: SEVERAL });
    const session = await h.open({ to: "New" });
    const old = h.cloudflare.account("Old");
    const fresh = h.cloudflare.account("New");
    expect(session.zone).toBe(ZONE);
    expect(session.environments.map((env) => env.environment)).toEqual(["prod", "staging"]);
    expect(session.environments[1]?.paths.environment).toBe("staging");
    expect(session.staying).toEqual([{ name: "dev", cloudflare: true, zone: OTHER_ZONE }]);
    expect(session.skipped).toEqual(["old"]);
    expect(session.accounts.a).toMatchObject({
      accountId: old.id,
      name: "Old",
      zoneId: h.cloudflare.zone(ZONE, "Old").id,
      zone: { status: "active" },
    });
    expect(session.accounts.b).toMatchObject({ accountId: fresh.id, name: "New" });
    expect(session.accounts.b.zone).toBeUndefined();
    expect(await bSetup(session)).toBeUndefined();
    expect(session.github).toMatchObject({ owner: "acme", repo: "shop" });
    expect(session.engine).toBe(h.engine);
    expect(session.approve).toBeUndefined();
    await expect(checkMoveStart(session)).resolves.toBeUndefined();
    expect(zonesByAccount(h)).toBe(true);
    expect(h.readOnly()).toBe(true);
    expect(h.leaks()).toBe(false);
  });

  it("finds the other OpsCrew apps in the zone by hostname: records and Workers custom domains", async () => {
    const h = await moveHarness({ plans: SEVERAL });
    const session = await h.open({ to: "New" });
    // shop.example.com is this app's, the MX record is the user's.
    expect(await otherAppHostnames(session)).toEqual([`blog.${ZONE}`, `docs.${ZONE}`]);
  });

  it("leaves Workers custom domains out when A's token can't read the account's Workers", async () => {
    const h = await moveHarness();
    h.cloudflare.tokens.get(h.tokens.a)?.denied.add("workers");
    const session = await h.open({ to: "New" });
    expect(await otherAppHostnames(session)).toEqual([`blog.${ZONE}`]);
  });

  it("reads B's zone and its Cloudflare setup with B's token once B has the zone", async () => {
    const h = await moveHarness({ bZone: true });
    const session = await h.open({ to: h.cloudflare.account("New").id });
    const zone = h.cloudflare.zone(ZONE, "New");
    expect(session.accounts.b.zone).toMatchObject({ id: zone.id, status: "pending" });
    expect(session.accounts.b.setup).toBeUndefined();
    expect(await bSetup(session)).toMatchObject({
      zoneId: zone.id,
      zoneName: ZONE,
      accountId: zone.accountId,
    });
    expect(zonesByAccount(h)).toBe(true);
    expect(h.leaks()).toBe(false);
  });

  it("finds no zone in B when B holds only its moved copy, as on a move back", async () => {
    const h = await moveHarness({ bZone: true });
    h.cloudflare.move(h.cloudflare.zone(ZONE, "New"));
    const session = await h.open({ to: "New" });
    expect(session.accounts.b.zone).toBeUndefined();
    expect(await bSetup(session)).toBeUndefined();
    expect(h.readOnly()).toBe(true);
  });

  it("continues a recorded move without --to, and refuses another --to", async () => {
    const h = await moveHarness({
      plans: (cloudflare) => ({ prod: recordedMove(serverPlan(), cloudflare) }),
    });
    const session = await h.open();
    expect(session.accounts.b.accountId).toBe(h.cloudflare.account("New").id);
    const error = await refused(h, h.open({ to: "Spare" }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain(
      `goes to the Cloudflare account ${session.accounts.b.accountId}`,
    );
  });

  it("asks for --to when no move is recorded", async () => {
    const h = await moveHarness();
    const error = await refused(h, h.open());
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.hint).toContain("--to <account id or exact name>");
  });

  it("reads the state passphrase as the engine needs it, and never makes one", async () => {
    const encrypted = testPlan({ domain: `shop.${ZONE}`, deployed: true });
    const h = await moveHarness({ plans: () => ({ prod: encrypted }) });
    const missing = await h.open({ to: "New" }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OpsCrewError);
    expect((missing as OpsCrewError).message).toContain("passphrase");
    await projectEngine(h.deps, encrypted, { services: h.services });
    const session = await h.open({ to: "New" });
    expect(session.env.TF_ENCRYPTION).toBeTruthy();
    expect(h.leaks()).toBe(false);
  });
});

describe.skipIf(!findExecutable("git"))("openMoveSession, by account and record", () => {
  it("takes A as the account whose copy of the zone is active, of several A's token sees", async () => {
    const h = await moveHarness({
      stale: true,
      plans: () => ({
        prod: serverPlan(),
        dev: serverPlan(`dev.${STALE_ZONE}`, "dev"),
        lost: serverPlan("lost.example.invalid", "lost"),
      }),
    });
    const session = await h.open({ to: "New" });
    expect(session.accounts.a).toMatchObject({
      accountId: h.cloudflare.account("Old").id,
      zoneId: h.cloudflare.zone(ZONE, "Old").id,
      zone: { status: "active" },
    });
    expect(session.staying).toEqual([
      { name: "dev", cloudflare: true, zone: STALE_ZONE },
      { name: "lost", cloudflare: true },
    ]);
    expect(zonesByAccount(h)).toBe(true);
    expect(h.leaks()).toBe(false);
  });

  it("covers the recorded environments without a zone lookup once A's moved zone is gone", async () => {
    const h = await moveHarness({
      plans: (cloudflare) => ({
        prod: recordedMove(serverPlan(), cloudflare),
        staging: recordedMove(serverPlan(`staging.shop.${ZONE}`, "staging"), cloudflare),
      }),
    });
    const old = h.cloudflare.zone(ZONE, "Old");
    h.cloudflare.zones.splice(h.cloudflare.zones.indexOf(old), 1);
    const session = await h.open();
    expect(session.environments.map((env) => env.environment)).toEqual(["prod", "staging"]);
    expect(session.accounts.a).toMatchObject({ accountId: old.accountId, zoneId: old.id });
    expect(session.accounts.a.zone).toBeUndefined();
    expect(await otherAppHostnames(session)).toEqual([]);
  });

  it("asks only for a tunnel's permission for a Portainer app served through a tunnel", async () => {
    const plan = unencrypted(portainerPlan({ web: { mode: "tunnel" }, deployed: true }));
    expect(accountNeeds(plan)).toEqual(["tunnel"]);
    const h = await moveHarness({
      plans: () => ({ prod: plan }),
      bDenied: ["access-apps", "access-service-tokens", "access-organization"],
    });
    await expect(h.open({ to: "New" }).then(checkMoveStart)).resolves.toBeUndefined();
  });

  it("asks for Access with its service tokens in tunnel mode", () => {
    expect(accountNeeds(ownPlan({ access: "tunnel", deployed: true }))).toEqual([
      "tunnel",
      "access-apps",
      "access-organization",
      "access-service-tokens",
    ]);
    expect(accountNeeds(serverPlan())).toEqual([]);
  });
});

describe.skipIf(!findExecutable("git"))("the move's refusals before any change", () => {
  it("refuses without A's token, before any call", async () => {
    const h = await moveHarness({ env: { CLOUDFLARE_API_TOKEN: undefined } });
    const error = await refused(h, h.open({ to: "New" }));
    expect(error).toMatchObject({ code: "CREDENTIALS_MISSING" });
    expect(error.message).toContain("CLOUDFLARE_API_TOKEN is not set");
    expect(h.cloudflare.calls).toEqual([]);
  });

  it("refuses without B's token, before any call", async () => {
    const h = await moveHarness({ env: { OPSCREW_NEW_CLOUDFLARE_API_TOKEN: undefined } });
    const error = await refused(h, h.open({ to: "New" }));
    expect(error).toMatchObject({ code: "CREDENTIALS_MISSING" });
    expect(error.message).toContain(`${B_TOKEN_VAR} is not set`);
    expect(h.cloudflare.calls).toEqual([]);
  });

  it("refuses a token Cloudflare doesn't know", async () => {
    const h = await moveHarness({ env: { OPSCREW_NEW_CLOUDFLARE_API_TOKEN: "not-a-token" } });
    const error = await refused(h, h.open({ to: "New" }));
    expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect(error.message).toContain(`${B_TOKEN_VAR} does not work`);
  });

  it("refuses an account B's token can't use", async () => {
    const h = await moveHarness();
    const error = await refused(h, h.open({ to: "Elsewhere" }));
    expect(error.message).toContain(`${B_TOKEN_VAR}: This Cloudflare token cannot use the account`);
    expect(h.deps.redactor.redact(h.tokens.b)).not.toContain(h.tokens.b);
    expect(h.deps.redactor.redact(h.tokens.a)).not.toContain(h.tokens.a);
  });

  it("refuses when a covered environment's infrastructure state is not on this computer", async () => {
    const h = await moveHarness({ plans: SEVERAL, noState: ["staging"] });
    const session = await h.open({ to: "New" });
    const error = await refused(h, checkMoveStart(session));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("is not on this computer");
    expect(error.message).toContain("move it to another Cloudflare account");
    expect(error.hint).toContain("`opscrew provision --env staging`");
  });

  it("refuses B when it is A", async () => {
    const h = await moveHarness();
    h.deps.env.OPSCREW_NEW_CLOUDFLARE_API_TOKEN = h.tokens.a;
    const error = await refused(h, h.open({ to: "Old" }));
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(error.message).toContain(`holds ${ZONE} already`);
  });

  it("refuses a zone that isn't active in A", async () => {
    const h = await moveHarness({ aStatus: "pending" });
    const session = await h.open({ to: "New" });
    const error = await refused(h, checkMoveStart(session));
    expect(error.message).toContain(`${ZONE} is pending in the account`);
    expect(await otherAppHostnames(session)).toEqual([]);
  });

  it("refuses a zone that has moved already", async () => {
    const h = await moveHarness({ aStatus: "moved" });
    const error = await refused(h, h.open({ to: "New" }).then(checkMoveStart));
    expect(error.message).toContain("has moved to another Cloudflare account already");
  });

  it("refuses a zone with a zone hold", async () => {
    const h = await moveHarness();
    h.cloudflare.zone(ZONE, "Old").hold.hold = true;
    const error = await refused(h, h.open({ to: "New" }).then(checkMoveStart));
    expect(error.message).toContain("zone hold");
    expect(error.hint).toContain("Release the hold");
  });

  it("refuses while the app moves to another server, before any call", async () => {
    const plan = serverPlan();
    const moving = DeployPlanSchema.parse({
      ...plan,
      retarget: {
        from: { target: plan.target },
        step: "started",
        startedAt: "2026-11-20T09:00:00.000Z",
      },
      target: testPlan({ provider: "digitalocean" }).target,
    });
    const h = await moveHarness({ plans: () => ({ prod: moving }) });
    const error = await refused(h, h.open({ to: "New" }));
    expect(error.message).toContain("is moving to another server");
    expect(error.hint).toContain("`opscrew retarget --abort`");
    expect(h.cloudflare.calls).toEqual([]);
  });

  it("refuses when another app of the repository moves the zone to another account", async () => {
    const h = await moveHarness({
      apps: (cloudflare) => ({
        blog: recordedMove(
          appPlan("blog", undefined, serverPlan(`blog.${ZONE}`)),
          cloudflare,
          "Spare",
        ),
      }),
    });
    const session = await h.open({ to: "New" });
    const error = await refused(h, checkMoveStart(session));
    expect(error.message).toContain(
      `moving ${ZONE} to the Cloudflare account ${h.cloudflare.account("Spare").id}`,
    );
    expect(error.hint).toContain("--abort --app blog");
  });

  it("refuses an app with previews per pull request, before any call", async () => {
    const h = await moveHarness({
      plans: () => ({ prod: serverPlan(), preview: unencrypted(previewTestPlan()) }),
    });
    const error = await refused(h, h.open({ to: "New" }));
    expect(error.message).toContain("previews per pull request (the environment preview)");
    expect(error.hint).toContain("`opscrew destroy --env preview`");
    expect(h.cloudflare.calls).toEqual([]);
  });

  it("refuses the localhost target", async () => {
    const local = DeployPlanSchema.parse({
      ...testPlan({ deployed: true }),
      target: {
        provider: "localhost",
        mode: "local-compose",
        arch: "amd64",
        ports: { https: 443, http: 80 },
        image: "registry",
      },
    });
    const h = await moveHarness({ plans: () => ({ prod: unencrypted(local) }) });
    const error = await refused(h, h.open({ to: "New" }));
    expect(error.message).toContain("runs on this computer (the localhost target)");
  });

  it("names only the account permissions B lacks for the app's pieces", async () => {
    const h = await moveHarness({
      plans: () => ({ prod: unencrypted(ownPlan({ access: "tunnel", deployed: true })) }),
      bDenied: ["tunnel", "access-service-tokens", "r2", "workers"],
    });
    const session = await h.open({ to: "New" });
    const error = await refused(h, checkMoveStart(session));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toBe(
      `${B_TOKEN_VAR} lacks Account → Cloudflare Tunnel → Edit and Account → Access: Service Tokens → Edit for the account New, which the app's pieces need there. Nothing was changed.`,
    );
  });

  it("refuses committed files the move can't use yet", async () => {
    const h = await moveHarness({
      plans: () => ({ prod: unencrypted(ownPlan({ access: "tunnel", deployed: true })) }),
      files: { ".github/workflows/opscrew-deploy.yml": "name: deploy\n" },
    });
    const session = await h.open({ to: "New" });
    const error = await refused(h, checkMoveStart(session));
    expect(error.message).toContain("come from an earlier version of OpsCrew");
    expect(error.hint).toBe(
      "Run `opscrew provision` to bring the app's files up to date and commit them, then start the move.",
    );
  });
});

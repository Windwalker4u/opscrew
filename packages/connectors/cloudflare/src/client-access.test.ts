import { errorText, OpsCrewError } from "@opscrew/core";
import { type FakeReply, fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { type AccessApplicationInput, CLOUDFLARE_API, CloudflareClient } from "./client";

const TOKEN = fakeSecret("cloudflare-token", "account-b");
const ACCOUNT = "b".repeat(32);
const TUNNELS = `/accounts/${ACCOUNT}/cfd_tunnel`;
const POLICIES = `/accounts/${ACCOUNT}/access/policies`;
const APPS = `/accounts/${ACCOUNT}/access/apps`;

const ok = (result: unknown, extra: Record<string, unknown> = {}): FakeReply => ({
  body: { success: true, errors: [], messages: [], result, ...extra },
});
const fail = (status: number, code: number, message: string): FakeReply => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});
const pages = (n: number) => ({ result_info: { total_pages: n } });

function client(routes: Record<string, FakeReply | FakeReply[]>) {
  const { fetch, calls } = fakeFetch(routes, { base: CLOUDFLARE_API });
  return { cf: new CloudflareClient({ token: TOKEN, fetch, sleep: async () => {} }), calls };
}

/** The error a promise rejects with, checked to name no token. */
async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect(errorText(error)).not.toContain(TOKEN);
  return error as OpsCrewError;
}

const APP: AccessApplicationInput = {
  name: "OpsCrew Portainer (shop)",
  domain: "portainer.shop.example.com",
  appLauncherVisible: false,
  sessionDuration: "24h",
  policies: [{ id: "policy-2", precedence: 1 }],
  allowedIdps: ["pin-1"],
  autoRedirectToIdentity: true,
};

describe("CloudflareClient: tunnels and Access by name", () => {
  it("lists the account's tunnels page by page, deleted ones marked", async () => {
    const { cf, calls } = client({
      [`GET ${TUNNELS}?page=1`]: ok(
        [{ id: "t1", name: "opscrew-shop", deleted_at: null, connections: [] }],
        pages(2),
      ),
      [`GET ${TUNNELS}?page=2`]: ok(
        [{ id: "t2", name: "opscrew-blog", deleted_at: "2026-11-20T10:00:00Z" }],
        pages(2),
      ),
    });
    expect(await cf.listTunnels(ACCOUNT)).toEqual([
      { id: "t1", name: "opscrew-shop", deleted: false },
      { id: "t2", name: "opscrew-blog", deleted: true },
    ]);
    expect(calls.map((c) => c.path)).toEqual([
      `${TUNNELS}?page=1&per_page=50`,
      `${TUNNELS}?page=2&per_page=50`,
    ]);
  });

  it("lists the account's Access policies and applications with their hostnames", async () => {
    const { cf } = client({
      [`GET ${POLICIES}`]: ok([
        { id: "p1", name: "OpsCrew deploy (shop)", decision: "non_identity" },
      ]),
      [`GET ${APPS}`]: ok([
        {
          id: "a1",
          name: "OpsCrew SSH (shop)",
          domain: "ssh-shop.example.com",
          type: "self_hosted",
        },
        { id: "a2", name: "A launcher app", domain: null },
      ]),
    });
    expect(await cf.listAccessPolicies(ACCOUNT)).toEqual([
      { id: "p1", name: "OpsCrew deploy (shop)" },
    ]);
    expect(await cf.listAccessApplications(ACCOUNT)).toEqual([
      { id: "a1", name: "OpsCrew SSH (shop)", domain: "ssh-shop.example.com" },
      { id: "a2", name: "A launcher app" },
    ]);
  });

  it("retries a list Cloudflare answered with a server error, and names the permission it lacks", async () => {
    const { cf, calls } = client({
      [`GET ${APPS}`]: [fail(502, 0, "Bad gateway"), ok([])],
      [`GET ${POLICIES}`]: fail(403, 10000, "Authentication error"),
    });
    expect(await cf.listAccessApplications(ACCOUNT)).toEqual([]);
    expect(calls).toHaveLength(2);
    const error = await rejection(cf.listAccessPolicies(ACCOUNT));
    expect(error.hint).toContain("Access: Apps and Policies");
  });

  it("creates a self-hosted Access application with the settings given and answers its id", async () => {
    const { cf, calls } = client({ [`POST ${APPS}`]: ok({ id: "a9", name: APP.name }) });
    expect(await cf.createAccessApplication(ACCOUNT, APP)).toBe("a9");
    expect(calls[0]?.body).toEqual({
      name: APP.name,
      type: "self_hosted",
      domain: APP.domain,
      destinations: [{ type: "public", uri: APP.domain }],
      app_launcher_visible: false,
      session_duration: "24h",
      policies: [{ id: "policy-2", precedence: 1 }],
      allowed_idps: ["pin-1"],
      auto_redirect_to_identity: true,
    });
  });

  it("sends the create once: a server error says it may have reached Cloudflare, a refusal says why", async () => {
    const lost = client({ [`POST ${APPS}`]: { status: 500, body: { success: false } } });
    const unclear = await rejection(lost.cf.createAccessApplication(ACCOUNT, APP));
    expect(unclear.message).toContain("may still have reached Cloudflare");
    expect(lost.calls).toHaveLength(1);

    const pending = client({
      [`POST ${APPS}`]: fail(
        400,
        12130,
        "access.api.error.invalid_request: domain does not belong to zone",
      ),
    });
    const refused = await rejection(pending.cf.createAccessApplication(ACCOUNT, APP));
    expect(refused.code).toBe("PROVIDER_ERROR");
    expect(refused.message).toContain("domain does not belong to zone");
    expect(pending.calls).toHaveLength(1);

    const denied = client({ [`POST ${APPS}`]: fail(403, 10000, "Authentication error") });
    const error = await rejection(denied.cf.createAccessApplication(ACCOUNT, APP));
    expect(error.hint).toContain("Access: Apps and Policies → Edit");
  });
});

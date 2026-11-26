import { generateKeyPairSync } from "node:crypto";
import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { syncFastlyOriginMtls } from "./fastly-origin-mtls";

const API_KEY = fakeSecret("generic-password", "fastly-mtls-test-key");
const CERT_PEM = "-----BEGIN CERTIFICATE-----\nFASTLY-TEST-CERT\n-----END CERTIFICATE-----";
const KEY_PEM = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function fakeFastlyFetch(initialCert: string | null = null) {
  let activeVersion = 4;
  let cert = initialCert;
  const calls: string[] = [];

  const fetch: FetchLike = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && href.endsWith("/version")) {
      return new Response(JSON.stringify([{ number: activeVersion, active: true }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "GET" && href.includes("/backend/")) {
      return new Response(
        JSON.stringify({ name: "opscrew_origin", address: "203.0.113.10", ssl_client_cert: cert }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (method === "PUT" && href.endsWith("/clone")) {
      const next = activeVersion + 1;
      calls.push(`clone:${activeVersion}->${next}`);
      return new Response(JSON.stringify({ number: next }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "PUT" && href.includes("/backend/")) {
      const body = JSON.parse(String(init?.body)) as { ssl_client_cert: string };
      const match = /\/version\/(\d+)\//.exec(href);
      calls.push(`update:v${match?.[1]}`);
      cert = body.ssl_client_cert;
      return new Response(JSON.stringify({ name: "opscrew_origin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "PUT" && href.endsWith("/activate")) {
      const match = /\/version\/(\d+)\//.exec(href);
      const next = Number(match?.[1]);
      calls.push(`activate:v${next}`);
      activeVersion = next;
      return new Response(JSON.stringify({ number: next, active: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as FetchLike;

  return { calls, fetch };
}

describe("syncFastlyOriginMtls (036 PR 4)", () => {
  it("asks for plan-hash approval without leaking the private key, then clones, updates, and activates via registry", async () => {
    const handler = new ScriptedApprovalHandler(() => true);
    const deps = await createTestPhaseDeps({ approvalHandler: handler });
    const fake = fakeFastlyFetch(null);

    const res = await syncFastlyOriginMtls(deps, {
      apiKey: API_KEY,
      serviceId: "svc-123",
      backendName: "opscrew_origin",
      clientCertPem: CERT_PEM,
      clientKeyPem: KEY_PEM,
      fetch: fake.fetch,
      command: "opscrew provision",
    });
    expect(res.applied).toBe(true);
    expect(res.activatedVersion).toBe(5);
    expect(fake.calls).toEqual(["clone:4->5", "update:v5", "activate:v5"]);
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]?.details).not.toContain(KEY_PEM);
    expect(handler.requests[0]?.details).not.toContain(API_KEY);

    // Second run is a noop without prompting.
    const second = await syncFastlyOriginMtls(deps, {
      apiKey: API_KEY,
      serviceId: "svc-123",
      backendName: "opscrew_origin",
      clientCertPem: CERT_PEM,
      clientKeyPem: KEY_PEM,
      fetch: fake.fetch,
      command: "opscrew provision",
    });
    expect(second.applied).toBe(false);
    expect(second.plan.action).toBe("noop");
    expect(handler.requests).toHaveLength(1);
  });

  it("leaves Fastly untouched when approval is refused or planOnly is true", async () => {
    const fake = fakeFastlyFetch(null);
    const deps = await createTestPhaseDeps({
      approvalHandler: new ScriptedApprovalHandler(() => false),
    });

    const planOnly = await syncFastlyOriginMtls(deps, {
      apiKey: API_KEY,
      serviceId: "svc-123",
      backendName: "opscrew_origin",
      clientCertPem: CERT_PEM,
      clientKeyPem: KEY_PEM,
      fetch: fake.fetch,
      command: "opscrew provision",
      planOnly: true,
    });
    expect(planOnly.applied).toBe(false);
    expect(fake.calls).toEqual([]);

    await expect(
      syncFastlyOriginMtls(deps, {
        apiKey: API_KEY,
        serviceId: "svc-123",
        backendName: "opscrew_origin",
        clientCertPem: CERT_PEM,
        clientKeyPem: KEY_PEM,
        fetch: fake.fetch,
        command: "opscrew provision",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(fake.calls).toEqual([]);
  });
});

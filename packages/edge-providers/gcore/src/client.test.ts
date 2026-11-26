import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { gcoreClient } from "./client";

const API_TOKEN = fakeSecret("generic-password", "gcore-api-token");
const TOKEN_HEX = "c".repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("gcoreClient", () => {
  it("verifies credentials via Authorization: APIKey and refuses invalid or missing tokens", async () => {
    const missing = gcoreClient({ apiToken: "  " });
    expect((await missing.verifyCredentials()).ok).toBe(false);

    const seenHeaders: Record<string, string>[] = [];
    const okClient = gcoreClient({
      apiToken: API_TOKEN,
      fetch: (async (_url: string | URL, init?: RequestInit) => {
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return jsonResponse({ zones: [] });
      }) as unknown as FetchLike,
    });
    expect(await okClient.verifyCredentials()).toEqual({
      ok: true,
      message: "Gcore permanent API token verified.",
    });
    expect(seenHeaders[0]?.Authorization).toBe(`APIKey ${API_TOKEN}`);

    const badClient = gcoreClient({
      apiToken: API_TOKEN,
      fetch: (async () => jsonResponse({ message: "Unauthorized" }, 401)) as unknown as FetchLike,
    });
    const bad = await badClient.verifyCredentials();
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("HTTP 401");
    expect(bad.message).not.toContain(API_TOKEN);
  });

  it("finds the longest matching DNS zone and validates responses with zod", async () => {
    const client = gcoreClient({
      apiToken: API_TOKEN,
      fetch: (async () =>
        jsonResponse({
          zones: [{ name: "example.com" }, { name: "eu.example.com" }],
        })) as unknown as FetchLike,
    });
    expect(await client.findDnsZone("api.eu.example.com")).toEqual({ name: "eu.example.com" });
    expect(await client.findDnsZone("example.com")).toEqual({ name: "example.com" });
    expect(await client.findDnsZone("other.org")).toBeUndefined();

    const malformed = gcoreClient({
      apiToken: API_TOKEN,
      fetch: (async () => jsonResponse({ zones: "bad" })) as unknown as FetchLike,
    });
    await expect(malformed.findDnsZone("example.com")).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("patches staticRequestHeaders via PATCH /cdn/resources/{id} and redacts secrets on errors", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const redactor = new Redactor();
    const client = gcoreClient({
      apiToken: API_TOKEN,
      redactor,
      fetch: (async (url: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({ id: 99, cname: "shop.example.com" });
      }) as unknown as FetchLike,
    });

    await client.patchStaticRequestHeaders({
      resourceId: 99,
      headers: {
        "X-Keep": "1",
        "X-OpsCrew-Origin-Token": TOKEN_HEX,
      },
    });
    expect(calls).toEqual([
      {
        url: "https://api.gcore.com/cdn/resources/99",
        method: "PATCH",
        body: {
          options: {
            staticRequestHeaders: {
              enabled: true,
              value: {
                "X-Keep": "1",
                "X-OpsCrew-Origin-Token": TOKEN_HEX,
              },
            },
          },
        },
      },
    ]);

    const failing = gcoreClient({
      apiToken: API_TOKEN,
      redactor,
      fetch: (async () =>
        new Response(`echo ${TOKEN_HEX} and ${API_TOKEN}`, {
          status: 500,
        })) as unknown as FetchLike,
    });
    const err = await failing
      .patchStaticRequestHeaders({
        resourceId: 99,
        headers: { "X-OpsCrew-Origin-Token": TOKEN_HEX },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpsCrewError);
    expect((err as OpsCrewError).message).not.toContain(TOKEN_HEX);
    expect((err as OpsCrewError).message).not.toContain(API_TOKEN);
  });
});

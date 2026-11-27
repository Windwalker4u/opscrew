import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  BUNNY_ACTION_SET_REQUEST_HEADER,
  BUNNY_TRIGGER_URL,
  bunnyClient,
  OPSCREW_ORIGIN_HEADER_DESCRIPTION,
} from "./client";

const API_KEY = fakeSecret("generic-password", "bunny-api-key");
const TOKEN_HEX = "a".repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("bunnyClient", () => {
  it("verifies valid credentials via AccessKey and refuses invalid or missing keys", async () => {
    const missing = bunnyClient({ apiKey: "  " });
    expect((await missing.verifyCredentials()).ok).toBe(false);

    const seenHeaders: Record<string, string>[] = [];
    const okClient = bunnyClient({
      apiKey: API_KEY,
      fetch: (async (_url: string | URL, init?: RequestInit) => {
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return jsonResponse({ Items: [] });
      }) as unknown as FetchLike,
    });
    expect(await okClient.verifyCredentials()).toEqual({
      ok: true,
      message: "Bunny.net API key verified.",
    });
    expect(seenHeaders[0]?.AccessKey).toBe(API_KEY);

    const badClient = bunnyClient({
      apiKey: API_KEY,
      fetch: (async () => jsonResponse({ Message: "Unauthorized" }, 401)) as unknown as FetchLike,
    });
    const bad = await badClient.verifyCredentials();
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("HTTP 401");
    expect(bad.message).not.toContain(API_KEY);
  });

  it("finds the longest matching DNS zone for a domain and validates the API response with zod", async () => {
    const client = bunnyClient({
      apiKey: API_KEY,
      fetch: (async () =>
        jsonResponse({
          Items: [
            { Id: 10, Domain: "example.com" },
            { Id: 20, Domain: "eu.example.com" },
          ],
        })) as unknown as FetchLike,
    });
    expect(await client.findDnsZone("api.eu.example.com")).toEqual({
      id: 20,
      domain: "eu.example.com",
    });
    expect(await client.findDnsZone("example.com")).toEqual({
      id: 10,
      domain: "example.com",
    });
    expect(await client.findDnsZone("other.org")).toBeUndefined();

    const malformed = bunnyClient({
      apiKey: API_KEY,
      fetch: (async () => jsonResponse({ Items: "not-an-array" })) as unknown as FetchLike,
    });
    await expect(malformed.findDnsZone("example.com")).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("upserts the origin-verification SetRequestHeader Edge Rule and redacts the token on error", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const redactor = new Redactor();
    const client = bunnyClient({
      apiKey: API_KEY,
      redactor,
      fetch: (async (url: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(null, { status: 201 });
      }) as unknown as FetchLike,
    });

    await client.upsertOriginHeaderRule({
      pullZoneId: 42,
      guid: "rule-guid-1",
      headerName: "X-OpsCrew-Origin-Token",
      token: TOKEN_HEX,
    });

    expect(calls).toEqual([
      {
        url: "https://api.bunny.net/pullzone/42/edgerules/addOrUpdate",
        method: "POST",
        body: {
          Guid: "rule-guid-1",
          ActionType: BUNNY_ACTION_SET_REQUEST_HEADER,
          ActionParameter1: "X-OpsCrew-Origin-Token",
          ActionParameter2: TOKEN_HEX,
          ActionParameter3: null,
          Description: OPSCREW_ORIGIN_HEADER_DESCRIPTION,
          Enabled: true,
          Triggers: [{ Type: BUNNY_TRIGGER_URL, PatternMatches: ["*"], Parameter1: "" }],
        },
      },
    ]);
    expect(redactor.redact(`leaked ${TOKEN_HEX} and ${API_KEY}`)).not.toContain(TOKEN_HEX);
    expect(redactor.redact(`leaked ${TOKEN_HEX} and ${API_KEY}`)).not.toContain(API_KEY);

    const failing = bunnyClient({
      apiKey: API_KEY,
      redactor,
      fetch: (async () =>
        new Response(`server echoed ${TOKEN_HEX} and ${API_KEY}`, {
          status: 500,
        })) as unknown as FetchLike,
    });
    const err = await failing
      .upsertOriginHeaderRule({
        pullZoneId: 42,
        headerName: "X-OpsCrew-Origin-Token",
        token: TOKEN_HEX,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpsCrewError);
    expect((err as OpsCrewError).message).not.toContain(TOKEN_HEX);
    expect((err as OpsCrewError).message).not.toContain(API_KEY);
  });
});

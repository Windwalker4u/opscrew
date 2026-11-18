import { createHash } from "node:crypto";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import {
  type FakeCloudflarePermission,
  fakeCloudflareAccounts,
} from "@opscrew/connector-cloudflare/testing";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { checkUpdaterToken, type UpdaterTokenCheck } from "./token";

const OWN = fakeSecret("cloudflare-token", "own");
const UPDATER = fakeSecret("cloudflare-token", "updater");

/** Every permission the fake knows but the zone's DNS. */
const ALL_BUT_DNS: FakeCloudflarePermission[] = [
  "zone",
  "ssl",
  "settings",
  "http_config_settings",
  "http_request_firewall_custom",
  "http_request_dynamic_redirect",
  "page-rules",
  "email-routing",
  "tunnel",
  "access-apps",
  "access-service-tokens",
  "access-organization",
  "r2",
  "workers",
  "pages",
  "turnstile",
  "web-analytics",
];

/** The fake's verify id of a token. */
const idOf = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 32);

/** A Cloudflare account with OpsCrew's token, the updater's (DNS only unless said) and a zone. */
function setup(options: { denied?: FakeCloudflarePermission[]; token?: string | undefined } = {}) {
  const fake = fakeCloudflareAccounts({
    accounts: [{ name: "home", token: OWN }],
    zones: [{ name: "example.com", account: "home" }],
  });
  const account = fake.account("home");
  fake.tokens.set(UPDATER, {
    accounts: [account.id],
    denied: new Set(options.denied ?? ALL_BUT_DNS),
  });
  const zone = fake.zone("example.com", "home");
  const redactor = new Redactor();
  const input: UpdaterTokenCheck = {
    token: "token" in options ? options.token : UPDATER,
    own: { token: OWN, client: new CloudflareClient({ token: OWN, fetch: fake.fetch }) },
    zone: { id: zone.id, name: "example.com", accountId: account.id },
    command: "npx opscrew provision",
    deps: { fetch: fake.fetch, redactor, version: "0.0.0-test" },
  };
  return { fake, input, redactor, account, zone };
}

/** The refusal `checkUpdaterToken` throws for `input`. */
async function refusal(input: UpdaterTokenCheck): Promise<OpsCrewError> {
  const error = await checkUpdaterToken(input).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** A refusal that names the recipe and ends "Nothing was changed.". */
function expectRecipe(error: OpsCrewError): void {
  expect(error.message).toMatch(/Nothing was changed\.$/);
  expect(error.hint).toContain("Zone → DNS → Edit");
  expect(error.hint).toContain("Include → Specific zone → example.com");
  expect(error.hint).toContain("https://dash.cloudflare.com/profile/api-tokens");
  expect(error.hint).toContain("`npx opscrew provision`");
}

/** Neither token in anything the fake saw or the error says, and both masked by the redactor. */
function expectNoLeak(
  fake: ReturnType<typeof setup>["fake"],
  redactor: Redactor,
  error?: OpsCrewError,
  registered: string | null = UPDATER,
): void {
  const seen = JSON.stringify({
    calls: fake.calls,
    error: error && { message: error.message, hint: error.hint },
  });
  for (const token of [OWN, UPDATER]) expect(seen).not.toContain(token);
  if (registered) expect(redactor.redact(`the token ${registered}`)).not.toContain(registered);
}

describe("checkUpdaterToken", () => {
  it("passes a token with only the zone's DNS, read-only, and registers it", async () => {
    const { fake, input, redactor } = setup();
    const checked = await checkUpdaterToken(input);
    expect(checked.token).toBe(UPDATER);
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
    expectNoLeak(fake, redactor);
  });

  it("refuses a missing or blank token with the recipe, before any call", async () => {
    for (const token of [undefined, "  "]) {
      const { fake, input, redactor } = setup({ token });
      const error = await refusal(input);
      expect(error.code).toBe("CREDENTIALS_MISSING");
      expect(error.message).toContain("limited to example.com's DNS");
      expect(error.hint).toContain("set OPSCREW_DNS_UPDATER_TOKEN");
      expectRecipe(error);
      expect(error.hint).toContain("the token can change any record in example.com");
      expect(fake.calls).toEqual([]);
      expectNoLeak(fake, redactor, error, null);
    }
  });

  it("names the variable it was given", async () => {
    const { input } = setup({ token: undefined });
    const error = await refusal({ ...input, variable: "OPSCREW_NEW_DNS_UPDATER_TOKEN" });
    expect(error.hint).toContain("set OPSCREW_NEW_DNS_UPDATER_TOKEN");
  });

  it("refuses OpsCrew's own token's value, before any call", async () => {
    const { fake, input, redactor } = setup({ token: ` ${OWN} ` });
    const error = await refusal(input);
    expect(error.message).toContain("OpsCrew's own Cloudflare token");
    expectRecipe(error);
    expect(fake.calls).toEqual([]);
    expectNoLeak(fake, redactor, error, OWN);
  });

  it("refuses the same token as OpsCrew's own (by the verify answer's id)", async () => {
    const { fake, input, redactor } = setup();
    fake.faults.push({
      match: "GET /user/tokens/verify",
      reply: {
        body: {
          success: true,
          errors: [],
          messages: [],
          result: { id: idOf(OWN), status: "active" },
        },
      },
    });
    const error = await refusal(input);
    expect(error.message).toContain("OpsCrew's own Cloudflare token");
    expectRecipe(error);
    expectNoLeak(fake, redactor, error);
  });

  it("refuses a token Cloudflare rejects", async () => {
    const { fake, input, redactor } = setup();
    fake.tokens.delete(UPDATER);
    const error = await refusal(input);
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("OPSCREW_DNS_UPDATER_TOKEN does not work");
    expectRecipe(error);
    expectNoLeak(fake, redactor, error);
  });

  it("refuses a token that isn't active", async () => {
    const { fake, input, redactor } = setup();
    fake.faults.push({
      match: "GET /user/tokens/verify",
      reply: {
        body: {
          success: true,
          errors: [],
          messages: [],
          result: { id: idOf(UPDATER), status: "disabled" },
        },
      },
    });
    const error = await refusal(input);
    expect(error.message).toContain("is disabled");
    expectRecipe(error);
    expectNoLeak(fake, redactor, error);
  });

  it("refuses an account-owned token (no id or status), naming the user token's page", async () => {
    const { fake, input, redactor } = setup();
    fake.faults.push({
      match: "GET /user/tokens/verify",
      reply: {
        status: 401,
        body: {
          success: false,
          errors: [{ code: 1000, message: "Invalid API Token" }],
          messages: [],
          result: null,
        },
      },
    });
    const error = await refusal(input);
    expect(error.message).toContain("account");
    expect(error.hint).toContain("My Profile → API Tokens");
    expectRecipe(error);
    expectNoLeak(fake, redactor, error);
  });

  it("refuses a token that can't read the zone's DNS records", async () => {
    const { fake, input, redactor } = setup({ denied: [...ALL_BUT_DNS, "dns"] });
    const error = await refusal(input);
    expect(error.message).toContain("can't read example.com's DNS records");
    expectRecipe(error);
    expectNoLeak(fake, redactor, error);
  });

  it("refuses a token wider than the zone's DNS, naming what else it reaches", async () => {
    const { fake, input, redactor } = setup({
      denied: ALL_BUT_DNS.filter((p) => p !== "ssl" && p !== "tunnel"),
    });
    const error = await refusal(input);
    expect(error.message).toContain("wider than example.com's DNS");
    expect(error.message).toContain("the zone's SSL and certificates");
    expect(error.message).toContain("the account's Cloudflare Tunnels");
    expect(error.message).not.toContain("Workers");
    expectRecipe(error);
    expectNoLeak(fake, redactor, error);
  });

  it("refuses OpsCrew's whole permission set as wider (every probe counts)", async () => {
    const { fake, input, redactor } = setup({ denied: [] });
    const error = await refusal(input);
    for (const reach of [
      "the zone's Config Rules",
      "the zone's custom WAF rules",
      "the zone's redirect rules",
      "the zone's SSL and certificates",
      "the zone's settings",
      "the account's Cloudflare Tunnels",
      "the account's Access applications",
      "the account's Access service tokens",
      "the account's Access login methods",
      "the account's R2 buckets",
      "the account's Workers",
    ]) {
      expect(error.message).toContain(reach);
    }
    expectNoLeak(fake, redactor, error);
  });

  it("counts Access as out of reach when the account has no Access", async () => {
    const { fake, input, account } = setup();
    for (const path of ["/access/apps", "/access/service_tokens", "/access/identity_providers"]) {
      fake.faults.push({
        match: `GET /accounts/${account.id}${path}`,
        reply: {
          status: 400,
          body: {
            success: false,
            errors: [{ code: 12006, message: "access.api.error.not_enabled" }],
            messages: [],
            result: null,
          },
        },
      });
    }
    await expect(checkUpdaterToken(input)).resolves.toMatchObject({ token: UPDATER });
  });
});

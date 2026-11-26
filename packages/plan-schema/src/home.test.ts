// Feature 029: a server at the user's home, `target.home` (T2902, ADR 0033).
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { previewPlanOf } from "./__fixtures__/preview-plan";
import { DeployPlanSchema, OwnTargetSchema, parseArtifact, serializeArtifact } from "./index";
import { toJsonSchemas } from "./json-schema";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

const ownTarget = (overrides: Record<string, unknown> = {}) => ({
  provider: "own",
  mode: "vps-compose",
  arch: "arm64",
  access: "public",
  home: { ipv4: true },
  edge: "caddy",
  ...overrides,
});

/** A home plan behind Cloudflare's proxy at shop.example.com, deploying on the server's runner. */
async function homePlan(overrides: Record<string, unknown> = {}) {
  const plan = parseArtifact("plan", await fixture("plan.yaml"), "fixture");
  return {
    ...plan,
    target: ownTarget(),
    dns: {
      provider: "cloudflare",
      domain: "shop.example.com",
      zone: "example.com",
      proxied: true,
      www: false,
    },
    security: { ...plan.security, httpAllowedFrom: "edge" },
    environment: { deploySource: { from: "main" }, runner: "server" },
    ...overrides,
  };
}

function issues(input: unknown) {
  const result = DeployPlanSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message })) ?? [];
}

describe("target.home", () => {
  it("is a strict { ipv4 } on the own target, and optional", () => {
    expect(OwnTargetSchema.parse(ownTarget()).home).toEqual({ ipv4: true });
    const { home: _home, ...plain } = ownTarget();
    expect(OwnTargetSchema.parse(plain)).not.toHaveProperty("home");
    expect(OwnTargetSchema.safeParse(ownTarget({ home: { ipv4: true, lan: "x" } })).success).toBe(
      false,
    );
    expect(OwnTargetSchema.safeParse(ownTarget({ home: {} })).success).toBe(false);
  });

  it("parses a home plan behind the proxy and DNS only, with ipv4 true or false", async () => {
    for (const ipv4 of [true, false]) {
      const proxied = DeployPlanSchema.parse(
        await homePlan({ target: ownTarget({ home: { ipv4 } }) }),
      );
      expect(proxied.target).toMatchObject({ provider: "own", home: { ipv4 } });
      const base = await homePlan();
      const dnsOnly = DeployPlanSchema.parse({
        ...base,
        target: ownTarget({ home: { ipv4 } }),
        dns: { ...base.dns, proxied: false },
        security: { ...base.security, httpAllowedFrom: "any" },
      });
      expect(dnsOnly.target).toMatchObject({ home: { ipv4 } });
    }
  });

  it("accepts a runner machine in the home", async () => {
    const plan = await homePlan({
      environment: { runner: "host", runnerHost: { name: "office-pc", arch: "amd64" } },
    });
    expect(DeployPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("round-trips a home plan, and leaves a plan without home byte for byte", async () => {
    const text = serializeArtifact("plan", DeployPlanSchema.parse(await homePlan()));
    expect(text).toContain("home:\n    ipv4: true");
    expect(serializeArtifact("plan", parseArtifact("plan", text, "home"))).toBe(text);
    const plain = await fixture("plan.yaml");
    const once = serializeArtifact("plan", parseArtifact("plan", plain, "fixture"));
    expect(once).not.toContain("home:");
    expect(serializeArtifact("plan", parseArtifact("plan", once, "again"))).toBe(once);
  });

  it("is refused through the tunnel", async () => {
    expect(issues(await homePlan({ target: ownTarget({ access: "tunnel" }) }))).toEqual([
      {
        path: "target.home",
        message: expect.stringMatching(/^through the tunnel, a server at home needs no home/),
      },
    ]);
  });

  it("is refused in a preview environment's plan", async () => {
    const prod = DeployPlanSchema.parse(await homePlan());
    expect(issues(previewPlanOf(prod))).toContainEqual({
      path: "target.home",
      message: expect.stringContaining("previews can't run on a server at home"),
    });
  });

  it("is refused with GitHub's runner, named or by default", async () => {
    const expected = [
      {
        path: "environment.runner",
        message: expect.stringContaining("GitHub's machines can't reach a server"),
      },
    ];
    expect(issues(await homePlan({ environment: { runner: "github" } }))).toEqual(expected);
    expect(issues(await homePlan({ environment: undefined }))).toEqual(expected);
  });

  it("is refused with extra servers and with the private network", async () => {
    const servers = [
      { name: "db", target: { provider: "own", mode: "vps-compose", arch: "amd64" } },
    ];
    expect(issues(await homePlan({ servers }))).toContainEqual({
      path: "servers",
      message: expect.stringContaining("extra servers can't go with a server at home"),
    });
    const network = { range: "10.200.4.0/24", members: [] };
    expect(issues(await homePlan({ network }))).toContainEqual({
      path: "network",
      message: expect.stringContaining("the private network can't go with a server at home"),
    });
  });

  it("is refused without a domain", async () => {
    const base = await homePlan();
    const plan = {
      ...base,
      dns: { provider: "none", proxied: false, www: false },
      security: { ...base.security, httpAllowedFrom: "any" },
    };
    expect(issues(plan)).toEqual([
      { path: "dns.domain", message: expect.stringContaining("a server at home needs a domain") },
    ]);
  });

  it("ends every refusal saying what to change", async () => {
    const all = issues(
      await homePlan({
        target: ownTarget({ access: "tunnel" }),
        environment: { runner: "github" },
      }),
    );
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const { message } of all) expect(message).toMatch(/: /);
  });

  it("keeps the existing rules: the proxy's filter and the local runner", async () => {
    const base = await homePlan();
    expect(issues({ ...base, security: { ...base.security, httpAllowedFrom: "any" } })).toEqual([
      {
        path: "security.httpAllowedFrom",
        message: expect.stringContaining('must be "edge"'),
      },
    ]);
    expect(issues(await homePlan({ environment: { runner: "local" } }))).toContainEqual({
      path: "environment.runner",
      message: expect.stringContaining('can be "local" only with the localhost target'),
    });
  });

  it("is in the plan's JSON schema", () => {
    expect(JSON.stringify(toJsonSchemas().plan)).toContain(
      '"home":{"type":"object","properties":{"ipv4":{"type":"boolean"}},"required":["ipv4"],"additionalProperties":false}',
    );
  });
});

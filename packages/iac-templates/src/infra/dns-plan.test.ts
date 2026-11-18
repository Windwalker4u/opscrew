import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { detectEngines } from "@opscrew/iac-engine";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it, type TestContext } from "vitest";
import { homePlan, testCloudflare, testContext, testPlan } from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";
import { renderInfra, tfvars } from "./index";

describe("cloudflare-dns module", () => {
  const main = MODULE_FILES["cloudflare-dns/main.tf"] ?? "";

  it("creates the AAAA record only when asked", () => {
    expect(main).toMatch(
      /resource "cloudflare_dns_record" "aaaa" \{\n {2}count {3}= var\.ipv6_record \? 1 : 0\n/,
    );
    expect(main).not.toContain("moved {");
    const variables = MODULE_FILES["cloudflare-dns/variables.tf"] ?? "";
    expect(variables).toMatch(/variable "ipv6_record" \{[^}]*default {5}= true\n\}/);
  });

  it("creates the A record only when asked, with no address without it", () => {
    expect(main).toMatch(
      /resource "cloudflare_dns_record" "a" \{\n {2}count {3}= var\.ipv4_record \? 1 : 0\n/,
    );
    const variables = MODULE_FILES["cloudflare-dns/variables.tf"] ?? "";
    expect(variables).toMatch(
      /variable "ipv4_record" \{[^}]*type {8}= bool\n {2}default {5}= true\n\}/,
    );
    expect(variables).toMatch(/variable "ipv4" \{[^}]*default {5}= null\n\}/);
    // Beside ipv6_record.
    const names = [...variables.matchAll(/^variable "(\w+)"/gm)].map((match) => match[1]);
    expect(names.indexOf("ipv4_record")).toBe(names.indexOf("ipv6_record") - 1);
  });

  it("writes CAA at the domain, one per issuer, only when not proxied", () => {
    expect(main).toContain(
      [
        'resource "cloudflare_dns_record" "caa" {',
        "  for_each = var.proxied ? toset([]) : toset(var.caa_issuers)",
        "  zone_id  = var.zone_id",
        "  name     = var.domain",
        '  type     = "CAA"',
        "  ttl      = 1",
        "  data = {",
        "    flags = 0",
        '    tag   = "issue"',
        "    value = each.value",
        "  }",
        '  comment = "Managed by OpsCrew"',
        "}",
      ].join("\n"),
    );
    const variables = MODULE_FILES["cloudflare-dns/variables.tf"] ?? "";
    expect(variables).toMatch(
      /variable "caa_issuers" \{[^}]*type {8}= list\(string\)\n {2}default {5}= \[\]\n\}/,
    );
  });

  it("names the authorities of the plan's edge, and none for an app on the zone apex", () => {
    const issuers = (plan: DeployPlan) =>
      tfvars(plan, testContext({ cloudflare: testCloudflare() })).caa_issuers;
    const withEdge = (plan: DeployPlan, edge: "caddy" | "nginx" | "openlitespeed") =>
      DeployPlanSchema.parse({ ...plan, target: { ...plan.target, edge } });
    for (const provider of ["hetzner", "digitalocean", "own"] as const) {
      const plan = testPlan({ provider, domain: "shop.example.com" });
      expect(issuers(plan)).toEqual(["letsencrypt.org", "sectigo.com"]);
      expect(issuers(withEdge(plan, "nginx"))).toEqual(["letsencrypt.org"]);
      // certbot gets OpenLiteSpeed's certificates too.
      expect(issuers(withEdge(plan, "openlitespeed"))).toEqual(["letsencrypt.org"]);
      const apex = testPlan({ provider, domain: "example.com" });
      expect(issuers(apex)).toEqual([]);
      expect(issuers(withEdge(apex, "nginx"))).toEqual([]);
    }
    const root = renderInfra(
      testPlan({ domain: "shop.example.com" }),
      testContext({ cloudflare: testCloudflare() }),
    ).find((f) => f.path.endsWith("prod/main.tf"))?.content;
    expect(root).toMatch(/module "dns" \{[^}]*caa_issuers += var\.caa_issuers\n/);
  });

  it("is always on for OpsCrew-created servers (their roots do not pass ipv6_record)", () => {
    for (const provider of ["hetzner", "digitalocean"] as const) {
      const files = renderInfra(
        testPlan({ provider, domain: "shop.example.com" }),
        testContext({ cloudflare: testCloudflare() }),
      );
      const root = files.find((f) => f.path.endsWith("prod/main.tf"))?.content ?? "";
      expect(root).not.toContain("ipv6_record");
    }
  });
});

// Plans an own-server root offline (fake token, -refresh=false, local state) to show what the
// engines would do. Needs the cloudflare provider from the registry, so only with OPSCREW_IT=1.
const runIt = process.env.OPSCREW_IT === "1";
const detected = runIt ? await detectEngines() : [];
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;
// Not a credential: a placeholder of the right shape, so the provider configures without a network.
const PLACEHOLDER_TOKEN = "0".repeat(40);

/**
 * A local state holding the proxied A record at `module.dns.cloudflare_dns_record.a`, without an
 * index, as the module left it before its `count`, written by `engine` with its registry's provider.
 */
function unindexedARecordState(engine: { name: string; version: string }): unknown {
  const registry = engine.name === "tofu" ? "registry.opentofu.org" : "registry.terraform.io";
  return {
    version: 4,
    terraform_version: engine.version,
    serial: 1,
    lineage: "6f1d2c3b-0000-4000-8000-000000000001",
    outputs: {},
    resources: [
      {
        module: "module.dns",
        mode: "managed",
        type: "cloudflare_dns_record",
        name: "a",
        provider: `provider["${registry}/cloudflare/cloudflare"]`,
        instances: [
          {
            schema_version: 500,
            attributes: {
              id: "a".repeat(32),
              zone_id: testCloudflare().zoneId,
              name: "shop.example.com",
              type: "A",
              content: "203.0.113.10",
              ttl: 1,
              proxied: true,
              comment: "Managed by OpsCrew",
            },
            sensitive_attributes: [],
          },
        ],
      },
    ],
  };
}

describe.skipIf(!runIt)("own-server DNS plans (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    const bin = engine?.binary ?? name;

    /**
     * DNS only by default; `filtered` serves behind Cloudflare's proxy with the web filter, and
     * `deployPlan` is another plan's root. `state` is the state the plan starts from.
     */
    async function plan(
      test: TestContext,
      vars: Record<string, string>,
      filtered = false,
      o: { deployPlan?: DeployPlan; state?: unknown } = {},
    ): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), `opscrew-dns-plan-${name}-`));
      const proxied = testPlan({ provider: "own", domain: "shop.example.com" });
      const deployPlan =
        o.deployPlan ??
        (filtered
          ? proxied
          : DeployPlanSchema.parse({
              ...proxied,
              dns: { ...proxied.dns, proxied: false },
              security: { ...proxied.security, httpAllowedFrom: "any" },
            }));
      const files = renderInfra(deployPlan, testContext({ cloudflare: testCloudflare() }));
      for (const file of files) {
        const target = join(root, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      const statePath = join(root, "state.tfstate");
      if (o.state !== undefined) await writeFile(statePath, JSON.stringify(o.state));
      const runner = new NodeCommandRunner();
      const cwd = join(root, "opscrew/infra/prod");
      const init = await runner.run(
        bin,
        ["init", "-input=false", "-no-color", `-backend-config=path=${statePath}`],
        { cwd },
      );
      if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
        test.skip(`${name} could not download the providers (network needed)`);
      }
      expect(init.exitCode, init.stdout + init.stderr).toBe(0);
      const env: Record<string, string | undefined> = {
        ...process.env,
        CLOUDFLARE_API_TOKEN: PLACEHOLDER_TOKEN,
      };
      for (const [key, value] of Object.entries(vars)) env[`TF_VAR_${key}`] = value;
      const result = await runner.run(
        bin,
        ["plan", "-refresh=false", "-input=false", "-lock=false", "-no-color"],
        { cwd, env },
      );
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    }

    it.skipIf(!engine)(
      `gives an IPv4-only own server no AAAA record (${name})`,
      async (test) => {
        const out = await plan(test, { server_ipv4: "203.0.113.10" });
        expect(out).toContain("module.dns.cloudflare_dns_record.a[0] will be created");
        expect(out).not.toContain("cloudflare_dns_record.aaaa");
      },
      300_000,
    );

    it.skipIf(!engine)(
      `writes Caddy's CAA records at the DNS-only domain (${name})`,
      async (test) => {
        const out = await plan(test, { server_ipv4: "203.0.113.10" });
        for (const issuer of ["letsencrypt.org", "sectigo.com"]) {
          expect(out).toContain(
            `module.dns.cloudflare_dns_record.caa["${issuer}"] will be created`,
          );
        }
      },
      300_000,
    );

    it.skipIf(!engine)(
      `creates the AAAA record when the server has IPv6 (${name})`,
      async (test) => {
        const out = await plan(test, { server_ipv4: "203.0.113.10", server_ipv6: "2001:db8::10" });
        expect(out).toContain("module.dns.cloudflare_dns_record.aaaa[0] will be created");
      },
      300_000,
    );

    it.skipIf(!engine)(
      `gives no AAAA record behind the web filter, also with IPv6 (${name})`,
      async (test) => {
        const out = await plan(
          test,
          { server_ipv4: "203.0.113.10", server_ipv6: "2001:db8::10" },
          true,
        );
        expect(out).toContain("module.dns.cloudflare_dns_record.a[0] will be created");
        expect(out).not.toContain("cloudflare_dns_record.aaaa");
        expect(out).not.toContain("cloudflare_dns_record.caa");
      },
      300_000,
    );

    it.skipIf(!engine)(
      `moves an A record from before the module's count to a[0] by itself, with no moved block (${name})`,
      async (test) => {
        const state = engine ? unindexedARecordState(engine) : undefined;
        const out = await plan(test, { server_ipv4: "203.0.113.10" }, true, { state });
        expect(out).toContain("# (moved from module.dns.cloudflare_dns_record.a)");
        expect(out).toMatch(/Plan: 0 to add, \d+ to change, 0 to destroy\./);
      },
      300_000,
    );

    it.skipIf(!engine)(
      `leaves a server at home's A and AAAA records to its address updater (${name})`,
      async (test) => {
        const deployPlan = homePlan({ proxied: false, www: true });
        const out = await plan(test, {}, false, { deployPlan });
        expect(out).not.toMatch(/cloudflare_dns_record\.(?:a|aaaa)\[/);
        expect(out).toContain("module.dns.cloudflare_dns_record.www[0] will be created");
        expect(out).toContain(
          'module.dns.cloudflare_dns_record.caa["letsencrypt.org"] will be created',
        );
      },
      300_000,
    );
  }
});

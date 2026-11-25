// A provider's root variable (ADR 0029, D11) reaches every engine command as `TF_VAR_<name>`, so
// its name must differ from every root variable the renderer declares itself. The fixed names are
// read from the `variables.tf` of rendered roots, not copied by hand.
import type { CloudProviderDefinition } from "@opscrew/contracts";
import { CLOUD_PROVIDERS, cloudProvider } from "@opscrew/providers";
import { describe, expect, it } from "vitest";
import {
  testCloudflare,
  testCloudflareAccount,
  testContext,
  testPlan,
} from "../__fixtures__/plans";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { previewPlan } from "../previews/__fixtures__/plans";
import type { RenderedFile } from "../types";
import { movePlan, sideTarget } from "./__fixtures__/sides";
import { renderInfra } from "./index";
import { moveLayout } from "./layouts";

const zone = () => testContext({ cloudflare: testCloudflare() });
const account = () => testContext({ cloudflare: testCloudflareAccount() });

/**
 * Roots that together declare every fixed root variable: a cloud server with its DNS and the
 * scheduled check's key, a server the user owns (public and tunnel), a move from one, a Portainer
 * target's webhook tunnel and a preview environment.
 */
function roots(): RenderedFile[][] {
  const moving = movePlan("hetzner");
  return [
    renderInfra(
      testPlan({ provider: "hetzner", domain: "shop.example.com" }),
      testContext({ cloudflare: testCloudflare(), checkKeyLine: "check key line" }),
    ),
    renderInfra(testPlan({ provider: "own", domain: "shop.example.com" }), zone()),
    renderInfra(
      moving,
      testContext({
        cloudflare: testCloudflare(),
        layout: moveLayout("both", sideTarget("own"), moving.target),
      }),
    ),
    renderInfra(
      testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" }),
      testContext({ cloudflare: testCloudflareAccount(), sshPort: 2222 }),
    ),
    renderInfra(
      portainerTestPlan({ web: { mode: "caddy" }, redeploy: "cloudflare", proxied: false }),
      account(),
    ),
    renderInfra(previewPlan(), zone()),
  ];
}

/** Every variable name the roots' `variables.tf` declare. */
function fixedNames(): Set<string> {
  const names = new Set<string>();
  for (const file of roots().flat()) {
    if (!/\/infra\/[^/]+\/variables\.tf$/.test(file.path)) continue;
    for (const [, name] of file.content.matchAll(/^variable "(\w+)" \{$/gm)) names.add(name ?? "");
  }
  return names;
}

/** `<provider>: <name>` for each provider's root variable that a fixed root variable already is. */
function clashes(providers: readonly CloudProviderDefinition[], fixed: ReadonlySet<string>) {
  return providers.flatMap(({ id, terraform }) =>
    (terraform.rootVariables ?? [])
      .filter(({ name }) => fixed.has(name))
      .map(({ name }) => `${id}: ${name}`),
  );
}

describe("a provider's root variable names", () => {
  const fixed = fixedNames();

  it("are checked against every fixed root variable, server and app wide", () => {
    for (const name of [
      "app_name",
      "location",
      "server_type",
      "deploy_ssh_public_key",
      "check_key_line",
      "ssh_allowed_cidrs",
      "http_allowed_cidrs",
      "server_ipv4",
      "server_ipv6",
      "previous_server_ipv4",
      "previous_server_ipv6",
      "domain",
      "preview_domain",
      "cloudflare_zone_id",
      "proxied",
      "www",
      "caa_issuers",
      "cloudflare_account_id",
      "portainer_hostname",
      "portainer_origin",
      "access_applications",
      "protected_route_records",
    ]) {
      expect(fixed, name).toContain(name);
    }
  });

  it("differ from every fixed root variable for each built-in provider", () => {
    expect(clashes(CLOUD_PROVIDERS, fixed)).toEqual([]);
  });

  it("catch a provider whose root variable has a fixed one's name", () => {
    const hetzner = cloudProvider("hetzner");
    const clashing: CloudProviderDefinition = {
      ...hetzner,
      terraform: {
        ...hetzner.terraform,
        rootVariables: [
          { name: "project_id", description: "Not fixed.", fromEnv: "HCLOUD_TOKEN" },
          { name: "app_name", description: "Clashes.", fromEnv: "HCLOUD_TOKEN" },
          { name: "portainer_origin", description: "Clashes.", fromEnv: "HCLOUD_TOKEN" },
        ],
      },
    };
    expect(clashes([...CLOUD_PROVIDERS, clashing], fixed)).toEqual([
      "hetzner: app_name",
      "hetzner: portainer_origin",
    ]);
  });
});

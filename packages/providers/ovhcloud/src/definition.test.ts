import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUD_PROVIDER_CONTRACT_VERSION, type PlannedResourceJson } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner, Redactor } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { collectProviderModule } from "../../../../scripts/gen-provider-modules";
import { CREDENTIALS_ENV } from "./__fixtures__/fixtures";
import { OVHCLOUD_CREDENTIALS_URL } from "./client";
import { definition, OVHCLOUD_LOCATIONS } from "./index";
import { STATIC_SNAPSHOT_PER_GB_HOUR_EUR, STATIC_SNAPSHOT_PER_GB_MONTH_EUR } from "./static-prices";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
/** OpsCrew's regions (plan-schema's `RegionSchema`, which a provider package does not import). */
const REGIONS = ["eu-central", "eu-north", "us-east", "us-west", "ap-southeast"];
const ENV_VARS = [
  "OVH_ENDPOINT",
  "OVH_CLIENT_ID",
  "OVH_CLIENT_SECRET",
  "OVH_CLOUD_PROJECT_SERVICE",
];
/** OVHcloud's public Public Cloud price page for its EUR subsidiaries. */
const PRICING_URL = "https://www.ovhcloud.com/en-ie/public-cloud/prices/";

/** A planned resource of `type` with `values` and the attributes known only after apply. */
function resource(
  address: string,
  type: string,
  values: Record<string, unknown>,
  unknown: Record<string, unknown> = {},
): PlannedResourceJson {
  return { address, type, name: address.split(".").at(-1) ?? "", values, unknown };
}

/** A rule of `ovh_cloud_security_group.rule`, as a plan's JSON lists it (every attribute). */
function plannedRule(rule: {
  ethernet_type: "IPV4" | "IPV6";
  protocol: string | null;
  port_range_min?: number | null;
  port_range_max?: number | null;
  remote_ip_prefix?: string | null;
  remote_group_id?: string | null;
  direction?: string;
}): Record<string, unknown> {
  return {
    description: null,
    direction: "INGRESS",
    port_range_min: null,
    port_range_max: null,
    remote_ip_prefix: null,
    remote_group_id: null,
    ...rule,
  };
}

/**
 * A plan's JSON `configuration` with one server module call per entry of `modules`: its
 * `ovh_cloud_instance.this`, whose `security_group_ids` expression has the references given
 * (none: the attribute is not set), and its `ovh_cloud_security_group.this`.
 */
function planJson(modules: Record<string, string[] | undefined>): unknown {
  const moduleCall = (references: string[] | undefined) => ({
    source: "./modules/ovhcloud-instance",
    module: {
      resources: [
        {
          address: "ovh_cloud_security_group.this",
          mode: "managed",
          type: "ovh_cloud_security_group",
          name: "this",
          expressions: { name: { references: ["var.name"] } },
        },
        {
          address: "ovh_cloud_instance.this",
          mode: "managed",
          type: "ovh_cloud_instance",
          name: "this",
          expressions: {
            name: { references: ["var.name"] },
            ...(references === undefined ? {} : { security_group_ids: { references } }),
          },
        },
      ],
    },
  });
  return {
    format_version: "1.2",
    configuration: {
      provider_config: { ovh: { name: "ovh", full_name: "registry.opentofu.org/ovh/ovh" } },
      root_module: {
        module_calls: Object.fromEntries(
          Object.entries(modules).map(([name, references]) => [name, moduleCall(references)]),
        ),
      },
    },
  };
}

/** The references a plan lists for `security_group_ids = [ovh_cloud_security_group.this.id]`. */
const GROUP_REFERENCES = ["ovh_cloud_security_group.this.id", "ovh_cloud_security_group.this"];

describe("OVHcloud's cloud provider definition", () => {
  it("has the contract's version, its names, its pages and every part", () => {
    expect(definition.contractVersion).toBe(CLOUD_PROVIDER_CONTRACT_VERSION);
    expect(definition).toMatchObject({
      id: "ovhcloud",
      displayName: "OVHcloud",
      name: "OVHcloud",
      serverNoun: "server",
      // The control panel's word: "Select a model" when creating an instance.
      sizeNoun: "model",
      consoleUrl: "https://manager.eu.ovhcloud.com/",
      accountUrl: "https://manager.eu.ovhcloud.com/",
      signupUrl: "https://manager.eu.ovhcloud.com/account-creation/",
      pricingUrl: PRICING_URL,
    });
    // Plain pages: no query string or fragment that could carry a referral.
    expect(definition.signupUrl).toMatch(/^https:\/\/[^?#]+$/);
    expect(definition.pricingUrl).toMatch(/^https:\/\/[^?#]+$/);
    for (const part of ["credentials", "regions", "offering", "terraform", "texts"] as const) {
      expect(definition[part]).toBeDefined();
    }
  });

  it("needs all four values of a service account, which have no recognisable format", () => {
    const { credentials } = definition;
    expect(credentials).toMatchObject({
      envVars: ENV_VARS,
      mode: "all",
      createUrl: OVHCLOUD_CREDENTIALS_URL,
      tokenRules: [],
      envPrefixes: ["OVH"],
    });
    expect(Object.keys(credentials.labels).sort()).toEqual([...ENV_VARS].sort());
    for (const name of ENV_VARS) expect(credentials.labels[name], name).toMatch(/^OVHcloud /);
    expect(credentials.labels.OVH_ENDPOINT).toContain("ovh-eu");
    for (const text of [
      "Error: calling Get https://api.eu.ovhcloud.com/v2/publicCloud/project/abc/compute/instance: 403",
      "Error: calling Post https://eu.api.ovh.com/1.0/cloud/project/abc/instance: 403",
      "oauth2: cannot fetch token: Post https://auth.eu.ovhcloud.com/oauth2/token",
      "with module.server.ovh_cloud_instance.this",
    ]) {
      expect(credentials.apiPattern.test(text), text).toBe(true);
    }
    for (const text of ["api.hetzner.cloud", "with contabo_instance.this", "api.cloudflare.com"]) {
      expect(credentials.apiPattern.test(text), text).toBe(false);
    }
  });

  it("maps every OpsCrew region to OVHcloud's regions, with a note where it maps far away", () => {
    const { locations, locationNames, coordinates, notes } = definition.regions;
    expect(locations).toEqual({
      "eu-central": ["DE1", "SBG5", "GRA11", "WAW1"],
      "eu-north": ["WAW1"],
      "us-east": ["BHS5"],
      "us-west": ["BHS5"],
      "ap-southeast": ["SGP1", "SYD1"],
    });
    expect(Object.keys(locations).sort()).toEqual([...REGIONS].sort());
    // The catalogue offers every plan in exactly these locations.
    expect([...new Set(Object.values(locations).flat())].sort()).toEqual(
      [...OVHCLOUD_LOCATIONS].sort(),
    );
    expect(locationNames).toMatchObject({
      DE1: expect.stringContaining("Limburg"),
      SBG5: "Strasbourg",
      GRA11: "Gravelines",
      WAW1: "Warsaw",
      BHS5: expect.stringContaining("Beauharnois"),
      SGP1: "Singapore",
      SYD1: "Sydney",
    });
    for (const location of OVHCLOUD_LOCATIONS) {
      const [latitude, longitude] = coordinates[location] ?? [];
      expect(Math.abs(latitude ?? 99), location).toBeLessThanOrEqual(90);
      expect(Math.abs(longitude ?? 999), location).toBeLessThanOrEqual(180);
    }
    expect(coordinates.SYD1?.[0]).toBeLessThan(0);
    expect(coordinates.BHS5?.[1]).toBeLessThan(0);
    expect(Object.keys(notes).sort()).toEqual(["eu-north", "us-east", "us-west"]);
    expect(notes["eu-north"]).toContain("Warsaw");
    for (const region of ["us-east", "us-west"]) {
      expect(notes[region]).toContain("Beauharnois");
      expect(notes[region]).toContain("Montreal");
      expect(notes[region]).toContain("OVHcloud US");
    }
    expect(notes["us-west"]).toContain("west coast");
  });

  it("bills by the second until the server is deleted, with snapshots per GB that outlive it", () => {
    expect(definition.offering).toEqual({
      currency: "EUR",
      billing: { model: "hourly", counts: "second", setupFee: false },
      defaultImage: "Ubuntu 24.04",
      backupPercent: 0,
      providerBackups: false,
      backupsOutliveServer: false,
      snapshots: {
        kind: "per-gb",
        perGbMonth: STATIC_SNAPSHOT_PER_GB_MONTH_EUR,
        perGbHour: STATIC_SNAPSHOT_PER_GB_HOUR_EUR,
      },
      serverSnapshotsOutliveServer: true,
      deleteProtection: false,
      resize: false,
      offAfterRefusedResize: false,
      removal: { kind: "delete" },
      unavailable: expect.any(RegExp),
      serverLimit: expect.any(RegExp),
    });
  });

  it("tells an unavailable model from a full quota, and neither from a refused right", () => {
    const { unavailable, serverLimit } = definition.offering;
    for (const text of [
      "stockStatus OUT_OF_STOCK",
      "The flavor d2-2 is out of stock in GRA11",
      "No valid host was found. There are not enough hosts available.",
      "The flavor is not available in this region",
      "The region WAW1 is not activated on this project",
    ]) {
      expect(unavailable.test(text), text).toBe(true);
    }
    for (const text of [
      "Quota exceeded for cores: Requested 4, but already used 20 of 20 cores",
      "quotaStatus INSUFFICIENT",
      "Insufficient quota for instances",
    ]) {
      expect(serverLimit.test(text), text).toBe(true);
      expect(unavailable.test(text), text).toBe(false);
    }
    for (const text of [
      "Service Temporarily Unavailable",
      "This call has not been granted",
      "Insufficient rights: publicCloudProject:apiovh:instance/create",
    ]) {
      expect(unavailable.test(text), text).toBe(false);
      expect(serverLimit.test(text), text).toBe(false);
    }
  });

  it("prices its static offers by its billing facts", async () => {
    const { billing, snapshots, currency } = definition.offering;
    const catalog = definition.connector({ env: {} }).catalog();
    const offers = await catalog.listOffers();
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.billing).toBe(billing.model);
      expect(offer.hourly?.currency).toBe(currency);
      expect(offer.hourly?.amount ?? Infinity).toBeLessThan(offer.monthly.amount);
      expect(offer.setupFee).toBeUndefined();
    }
    const extras = await catalog.extras("GRA11");
    expect(snapshots.kind).toBe("per-gb");
    if (snapshots.kind !== "per-gb") return;
    expect(extras.snapshotPerGbMonth).toEqual({ amount: snapshots.perGbMonth, currency });
    expect(extras.snapshotPerGbHour).toEqual({ amount: snapshots.perGbHour, currency });
  });

  it("has servers only with the four values set", () => {
    const without = definition.connector({ env: {} });
    expect(without.configured).toBe(false);
    expect(without.servers).toBeUndefined();
    const connector = definition.connector({
      env: CREDENTIALS_ENV,
      redactor: new Redactor(),
      fetch: () => Promise.reject(new Error("no request in this test")),
    });
    expect(connector.configured).toBe(true);
    expect(connector.servers?.findAppServers).toBeTypeOf("function");
  });

  it("has the texts the contract asks for, and no resize text since a size change is refused", () => {
    const { texts } = definition;
    expect(texts.resizeOffline).toBeUndefined();
    expect(texts.interview.label).toBe("OVHcloud");
    expect(texts.interview.hint).toMatch(/hour.*EUR/);
    expect(texts.design).toEqual({
      summaryNoun: "OVHcloud server",
      titleSuffix: " on OVHcloud",
      livePricesVar: "OVH_CLIENT_ID",
    });
    for (const name of ENV_VARS) expect(texts.init.fix).toContain(name);
    expect(texts.init.fix).toContain(OVHCLOUD_CREDENTIALS_URL);
    expect(texts.init.fix).toContain("ovh-eu");
    // The IAM policy that limits the service account to the one project.
    expect(texts.init.scopeNote).toMatch(/^ /);
    expect(texts.init.scopeNote).toContain("IAM policy");
    expect(texts.init.scopeNote).toContain("Public Cloud project");
    expect(texts.init.scopeNote).toContain("publicCloudProject:apiovh:*");
    expect(texts.rotate.deleteToken).toContain(
      "Identity and Access Management → Identities → Service account",
    );
    expect(texts.runbook.serverLabel("d2-2", "GRA11")).toBe("OVHcloud d2-2 in GRA11");
    expect(texts.runbook.deletes("shop")).toContain("`opscrew-shop`");
    expect(texts.runbook.deletes("shop")).toContain("`shop-deploy`");
    expect(texts.runbook.deleteProtectionNote.join("\n")).toContain("No delete protection");
    expect(texts.runbook.snapshotFirst.join("\n")).toContain("per GB per month");
    const remains = texts.runbook.whatRemains("img", "opscrew", "wf.yml", false).join("\n");
    expect(remains).toContain("per GB per month");
    expect(remains).toContain(PRICING_URL);
    expect(remains).toContain("Instance Snapshot");
    expect(texts.destroy.console).toBe("the OVHcloud control panel");
    expect(texts.destroy.snapshotRef("6f1c")).toBe("OVHcloud snapshot 6f1c");
    // Snapshots keep billing per GB until they are deleted in the control panel.
    for (const text of [texts.destroy.snapshotBilling, texts.destroy.snapshotBilled]) {
      expect(text).toContain("per GB per month");
      expect(text).toContain("until");
      expect(text).toContain("control panel");
      expect(text).not.toMatch(/€|\d+\.\d+/);
    }
    expect(texts.destroy.lookup("shop")).toBe("named shop or shop-… in your Public Cloud project");
    expect(texts.destroy.tokenHint("opscrew destroy")).toContain("`opscrew destroy`");
    // No provider backups and no object storage.
    expect(texts.destroy.deletedBackups).toBeUndefined();
    expect(texts.destroy.keptBackups).toBeUndefined();
    expect(texts.destroy.keptBackupsRemaining).toBeUndefined();
    expect(texts.destroy.storageConsole).toBeUndefined();
    // User-facing text names no task or feature number.
    expect(JSON.stringify(texts)).not.toMatch(/\bT\d{4}\b|\b0\d\d\b|feature \d/);
  });

  it("builds the module arguments of the app's server, an extra server and the previous one", () => {
    const { moduleArguments, extraShared } = definition.terraform;
    expect(moduleArguments({ prefix: "" })).toEqual([
      ["name", "var.app_name"],
      ["project_id", "var.ovhcloud_project_id"],
      ["location", "var.location"],
      ["server_type", "var.server_type"],
      ["image", "var.image"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ["http_allowed_cidrs", "var.http_allowed_cidrs"],
    ]);
    // An app tag passed in is ignored: OVHcloud's servers carry no tags.
    expect(
      moduleArguments({ prefix: "db_", extra: "db", appTag: "module.server.app_tag_name" }),
    ).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      ["name", '"${var.app_name}-db"'],
      ["project_id", "var.ovhcloud_project_id"],
      ["location", "var.db_location"],
      ["server_type", "var.db_server_type"],
      ["image", "var.db_image"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
    ]);
    const previous = moduleArguments({ prefix: "previous_" });
    expect(previous).toContainEqual(["location", "var.previous_location"]);
    expect(previous).toContainEqual(["server_type", "var.previous_server_type"]);
    expect(previous).toContainEqual(["http_allowed_cidrs", "var.http_allowed_cidrs"]);
    expect(extraShared.sshKeyId).toBe("ovh_cloud_ssh_key.deploy.name");
    expect(extraShared.appTag).toBeUndefined();
    expect(extraShared.resources).toContain('resource "ovh_cloud_ssh_key" "deploy" {');
    expect(extraShared.resources).toContain("  service_name = var.ovhcloud_project_id");
  });

  it("reads the project's id from a root variable fed only from OVH_CLOUD_PROJECT_SERVICE", () => {
    const { rootVariables, importId, moduleArguments, extraShared } = definition.terraform;
    expect(rootVariables).toEqual([
      {
        name: "ovhcloud_project_id",
        description: expect.stringContaining("TF_VAR_ovhcloud_project_id"),
        fromEnv: "OVH_CLOUD_PROJECT_SERVICE",
      },
    ]);
    expect(rootVariables?.[0]?.description).toContain("never written to a");
    expect(ENV_VARS).toContain(rootVariables?.[0]?.fromEnv);
    // Every root variable the module calls read that isn't a server's own or a shared one.
    const shared = new Set(["app_name", "deploy_ssh_public_key", "ssh_allowed_cidrs"]);
    const read = [
      ...moduleArguments({ prefix: "" }),
      ...moduleArguments({ prefix: "db_", extra: "db" }),
    ]
      .flatMap(([, value]) => [...value.matchAll(/var\.(\w+)/g)].map((match) => match[1] ?? ""))
      .filter((name) => !shared.has(name) && !/(^|_)(location|server_type|image)$/.test(name))
      .filter((name) => name !== "http_allowed_cidrs");
    expect([...new Set(read)]).toEqual(["ovhcloud_project_id"]);
    expect(extraShared.resources.join("\n")).toContain("var.ovhcloud_project_id");
    // OVHcloud imports an instance as <project>/<id>: the project comes from the root variable.
    expect(importId?.("6f1c2d3e-0000-4000-8000-000000000001")).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '"${var.ovhcloud_project_id}/6f1c2d3e-0000-4000-8000-000000000001"',
    );
  });

  it("manages the security group in Terraform, with no connector part and no login cache", () => {
    expect(definition.terraform).toMatchObject({
      provider: { name: "ovh", source: "ovh/ovh", version: "~> 2.25.0" },
      serverResourceType: "ovh_cloud_instance",
      firewallResourceType: "ovh_cloud_security_group",
      connectorFirewall: false,
      connectorBackups: false,
      connectorRemoval: false,
      homeCacheFiles: [],
      mirroredAttributes: {},
      deleteProtectionVariable: false,
    });
    const { credentialsComment } = definition.terraform;
    for (const name of ["OVH_ENDPOINT", "OVH_CLIENT_ID", "OVH_CLIENT_SECRET"]) {
      expect(credentialsComment).toContain(name);
    }
    expect(credentialsComment).toContain("TF_VAR_ovhcloud_project_id");
  });

  it("resolves the model and the image by name in the region, and keeps the server off the default group", () => {
    const files = definition.terraform.module.files;
    const main = files["main.tf"] ?? "";
    expect(main).toContain('data "ovh_cloud_instance_flavors" "this" {');
    expect(main).toContain('data "ovh_cloud_instance_images" "this" {');
    expect(main).toMatch(/flavor\.id if flavor\.name == var\.server_type/);
    expect(main).toMatch(/image\.id if image\.name == var\.image/);
    // The group is always set on the server, never left to the project's default group.
    expect(main).toMatch(/security_group_ids = \[ovh_cloud_security_group\.this\.id\]/);
    expect(main).toMatch(/name\s+= "opscrew-\$\{var\.name\}"/);
    // The rule's attributes as the provider's schema names them: the engines drop a misspelled
    // attribute of a list of objects silently, and validate can't see one.
    const rules = main.slice(main.indexOf("  rule = [\n"));
    expect(rules.slice(0, rules.indexOf("\n  ]\n") + 4)).toBe(
      [
        "  rule = [",
        "    for rule in local.rules : {",
        '      direction        = "INGRESS"',
        '      ethernet_type    = strcontains(rule.cidr, ":") ? "IPV6" : "IPV4"',
        "      protocol         = rule.protocol",
        "      port_range_min   = rule.port",
        "      port_range_max   = rule.port",
        "      remote_ip_prefix = rule.cidr",
        "      description      = rule.description",
        "    }",
        "  ]",
      ].join("\n"),
    );
    // Ping in both families: OVHcloud's protocol for IPv6 is ICMPV6.
    expect(main).toContain('protocol = "ICMP", port = null, cidr = "0.0.0.0/0"');
    expect(main).toContain('protocol = "ICMPV6", port = null, cidr = "::/0"');
    // SSH only from the allowed networks, the web's only on a server that serves the web.
    expect(main).toContain("for cidr in var.ssh_allowed_cidrs :");
    expect(main).toContain("for rule in var.web ? local.web_ports : [] :");
    expect(main).toContain("for port in var.wireguard_port[*] :");
    expect(main).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      'user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {',
    );
    expect(files["versions.tf"]).toContain('version = "~> 2.25.0"');
    expect(files["versions.tf"]).toContain('source  = "ovh/ovh"');
  });

  it("ignores the instance's attributes whose change would reinstall or recreate it, and says so to drift", () => {
    expect(definition.terraform.lifecycleIgnored).toEqual([
      "user_data",
      "image_id",
      "ssh_key_name",
    ]);
    expect(definition.terraform.module.files["main.tf"]).toContain(
      "ignore_changes = [user_data, image_id, ssh_key_name]",
    );
  });

  it("shares one deploy key named <app>-deploy between the app's servers", () => {
    const main = definition.terraform.module.files["main.tf"] ?? "";
    const block = main.slice(main.indexOf('resource "ovh_cloud_ssh_key" "deploy" {'));
    expect(block.slice(0, block.indexOf("\n}\n"))).toBe(
      [
        'resource "ovh_cloud_ssh_key" "deploy" {',
        "  count        = var.ssh_key_id == null ? 1 : 0",
        "  service_name = var.project_id",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
        '  name         = "${var.name}-deploy"',
        "  public_key   = var.ssh_public_key",
      ].join("\n"),
    );
    // The root's copy has the same address and name, so iac-templates can move it either way.
    expect(definition.terraform.extraShared.resources.join("\n")).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '  name         = "${var.app_name}-deploy"',
    );
  });

  it("outputs what the root module reads from every server module", () => {
    const outputs = definition.terraform.module.files["outputs.tf"] ?? "";
    for (const name of ["ipv4_address", "ipv6_address", "server_id", "server_name", "ssh_key_id"]) {
      expect(outputs).toContain(`output "${name}" {`);
    }
    const main = definition.terraform.module.files["main.tf"] ?? "";
    // The public interface is the observed network without an id.
    expect(main).toContain("network.addresses if network.id == null");
    expect(outputs).toMatch(/address\.version == 4/);
    expect(outputs).toMatch(/address\.version == 6/);
  });

  it("embeds the current module, without the shared cloud-init", () => {
    expect(definition.terraform.module.name).toBe("ovhcloud-instance");
    expect(definition.terraform.module.files).toEqual(collectProviderModule(packageDir));
    expect(Object.keys(definition.terraform.module.files)).not.toContain("cloud-init.yaml.tftpl");
  });
});

describe("OVHcloud's security checks", () => {
  const group = (address: string, rules: Record<string, unknown>[], id?: string) =>
    resource(address, "ovh_cloud_security_group", {
      name: "opscrew-shop",
      rule: rules,
      ...(id === undefined ? {} : { id }),
    });

  it("reads the group's inbound rules in Hetzner's shape, one source each, and no outbound one", () => {
    const firewall = group("module.server.ovh_cloud_security_group.this", [
      plannedRule({
        ethernet_type: "IPV4",
        protocol: "TCP",
        port_range_min: 22,
        port_range_max: 22,
        remote_ip_prefix: "203.0.113.0/24",
      }),
      plannedRule({
        ethernet_type: "IPV6",
        protocol: "UDP",
        port_range_min: 443,
        port_range_max: 443,
        remote_ip_prefix: "::/0",
      }),
      plannedRule({ ethernet_type: "IPV4", protocol: "ICMP", remote_ip_prefix: "0.0.0.0/0" }),
      // OVHcloud's ping over IPv6 is its own protocol; SecOps reads it as ICMP.
      plannedRule({ ethernet_type: "IPV6", protocol: "ICMPV6", remote_ip_prefix: "::/0" }),
      plannedRule({
        ethernet_type: "IPV4",
        protocol: "TCP",
        port_range_min: 8000,
        port_range_max: 8100,
        remote_ip_prefix: "0.0.0.0/0",
      }),
      // No source is any source of the family; no protocol and no port is everything.
      plannedRule({
        ethernet_type: "IPV6",
        protocol: "TCP",
        port_range_min: 5432,
        port_range_max: 5432,
      }),
      plannedRule({ ethernet_type: "IPV4", protocol: null }),
      // Members of another group only: no address on the internet.
      plannedRule({
        ethernet_type: "IPV4",
        protocol: "TCP",
        port_range_min: 6379,
        port_range_max: 6379,
        remote_group_id: "9b2f",
      }),
      plannedRule({
        direction: "EGRESS",
        ethernet_type: "IPV4",
        protocol: "TCP",
        remote_ip_prefix: "0.0.0.0/0",
      }),
    ]);
    expect(definition.texts.secops.rules(firewall)).toEqual([
      { direction: "in", protocol: "tcp", port: "22", source_ips: ["203.0.113.0/24"] },
      { direction: "in", protocol: "udp", port: "443", source_ips: ["::/0"] },
      { direction: "in", protocol: "icmp", port: "", source_ips: ["0.0.0.0/0"] },
      { direction: "in", protocol: "icmp", port: "", source_ips: ["::/0"] },
      { direction: "in", protocol: "tcp", port: "8000-8100", source_ips: ["0.0.0.0/0"] },
      { direction: "in", protocol: "tcp", port: "5432", source_ips: ["::/0"] },
      { direction: "in", protocol: "", port: "", source_ips: ["0.0.0.0/0"] },
      { direction: "in", protocol: "tcp", port: "6379", source_ips: [] },
    ]);
    expect(definition.texts.secops.rules(group("ovh_cloud_security_group.this", []))).toEqual([]);
  });

  it("sees the group attached through the instance's reference to it before apply", () => {
    const { attached } = definition.texts.secops;
    // Before apply the group's id is unknown: the plan lists it as [null] and after_unknown.
    const server = resource(
      "module.server.ovh_cloud_instance.this",
      "ovh_cloud_instance",
      { name: "shop", security_group_ids: [null] },
      { id: true, security_group_ids: [true] },
    );
    const firewall = group("module.server.ovh_cloud_security_group.this", []);
    expect(attached(server, [firewall], planJson({ server: GROUP_REFERENCES }))).toBe(true);
    // Another module's group is that module's server's.
    const other = group("module.server_db.ovh_cloud_security_group.this", []);
    expect(
      attached(
        server,
        [other],
        planJson({ server: GROUP_REFERENCES, server_db: GROUP_REFERENCES }),
      ),
    ).toBe(false);
    // A reference to something else is no group.
    expect(attached(server, [firewall], planJson({ server: ["var.groups"] }))).toBe(false);
  });

  it("sees the group attached by its id once both are known", () => {
    const { attached } = definition.texts.secops;
    const server = resource("module.server.ovh_cloud_instance.this", "ovh_cloud_instance", {
      security_group_ids: ["0b5e1c2a-0000-4000-8000-000000000001"],
    });
    const firewall = (id: string) => group("module.server.ovh_cloud_security_group.this", [], id);
    expect(attached(server, [firewall("0b5e1c2a-0000-4000-8000-000000000001")], {})).toBe(true);
    expect(attached(server, [firewall("0b5e1c2a-0000-4000-8000-000000000002")], {})).toBe(false);
    expect(attached(server, [], {})).toBe(false);
  });

  it("counts a server left on the project's default group as not attached", () => {
    const { attached } = definition.texts.secops;
    // No security_group_ids in the configuration: OVHcloud fills in the default group's id, so
    // the plan shows it unknown before apply, and the default group's id after it.
    const before = resource(
      "module.server.ovh_cloud_instance.this",
      "ovh_cloud_instance",
      { name: "shop" },
      { id: true, security_group_ids: true },
    );
    const firewall = group("module.server.ovh_cloud_security_group.this", [], "0b5e1c2a");
    expect(attached(before, [firewall], planJson({ server: undefined }))).toBe(false);
    const after = resource("module.server.ovh_cloud_instance.this", "ovh_cloud_instance", {
      security_group_ids: ["d3fa017e-default"],
    });
    expect(attached(after, [firewall], planJson({ server: undefined }))).toBe(false);
    expect(definition.texts.secops.unattachedText).toContain("default");
  });
});

describe("OVHcloud definition leaks", () => {
  it("puts none of the four values in its texts, its module or the HCL it writes", () => {
    // Built with the values, but never called: no request leaves the test.
    const connector = definition.connector({
      env: CREDENTIALS_ENV,
      redactor: new Redactor(),
      fetch: () => Promise.reject(new Error("no request in this test")),
    });
    const { terraform, texts } = definition;
    const calls = [
      { prefix: "" },
      { prefix: "db_", extra: "db" },
      { prefix: "previous_" },
    ] as const;
    const written = JSON.stringify({
      terraform: {
        ...terraform,
        moduleArguments: calls.map((call) => terraform.moduleArguments(call)),
        importId: terraform.importId?.("6f1c"),
      },
      texts: {
        ...texts,
        runbook: {
          ...texts.runbook,
          serverLabel: texts.runbook.serverLabel("d2-2", "GRA11"),
          deletes: texts.runbook.deletes("shop"),
          whatRemains: texts.runbook.whatRemains("img", "opscrew", "wf.yml", false),
        },
        destroy: {
          ...texts.destroy,
          snapshotRef: texts.destroy.snapshotRef("6f1c"),
          lookup: texts.destroy.lookup("shop"),
          tokenHint: texts.destroy.tokenHint("opscrew destroy"),
        },
      },
      credentials: definition.credentials,
      regions: definition.regions,
      connector: { configured: connector.configured, credentials: connector.credentials },
    });
    for (const value of Object.values(CREDENTIALS_ENV).filter((v) => v !== "ovh-eu")) {
      expect(written).not.toContain(value);
    }
  });
});

// Downloads the ovh provider from the registry, so it only runs with OPSCREW_IT=1. Binaries come
// from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH.
const runIt = process.env.OPSCREW_IT === "1";
if (!runIt) {
  console.warn(
    "[provider-ovhcloud] skipping HCL validation: set OPSCREW_IT=1 (it downloads the ovh provider).",
  );
}
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;
/** The shared first-boot setup OpsCrew adds to every server module. */
const CLOUD_INIT = join(packageDir, "../../iac-templates/shared/cloud-init.yaml.tftpl");
const MODULE_DIR = "modules/ovhcloud-instance";

/** `module "<name>" { … }` with `args`. */
function moduleBlock(name: string, args: readonly (readonly [string, string])[]): string[] {
  return [
    `module "${name}" {`,
    `  source = "./${MODULE_DIR}"`,
    ...args.map(([key, value]) => `  ${key} = ${value}`),
    "}",
    "",
  ];
}

/**
 * A root module as OpsCrew renders one: the project's root variable, the app's server with the
 * scheduled check's key and a WireGuard port, an extra server with the key the root holds once,
 * and the takeover's `import` block with OVHcloud's import id.
 */
function rootModule(): string {
  const { terraform } = definition;
  const variable = (name: string, type: string) => [
    `variable "${name}" {`,
    `  type = ${type}`,
    "}",
  ];
  const shared = terraform.extraShared;
  return [
    "terraform {",
    "  required_providers {",
    `    ${terraform.provider.name} = {`,
    `      source  = "${terraform.provider.source}"`,
    `      version = "${terraform.provider.version}"`,
    "    }",
    "  }",
    "}",
    "",
    `# ${terraform.credentialsComment}`,
    `provider "${terraform.provider.name}" {}`,
    "",
    ...(terraform.rootVariables ?? []).flatMap(({ name, description }) => [
      `variable "${name}" {`,
      "  type        = string",
      `  description = ${JSON.stringify(description)}`,
      "}",
    ]),
    ...[
      "app_name",
      "deploy_ssh_public_key",
      "check_key_line",
      "location",
      "server_type",
      "image",
      "db_location",
      "db_server_type",
      "db_image",
    ].flatMap((name) => variable(name, "string")),
    ...["ssh_allowed_cidrs", "http_allowed_cidrs"].flatMap((name) =>
      variable(name, "list(string)"),
    ),
    "",
    ...moduleBlock("server", [
      ...terraform.moduleArguments({ prefix: "" }),
      ["wireguard_port", "51820"],
      ["check_key_line", "var.check_key_line"],
    ]),
    ...shared.resources,
    ...moduleBlock("server_db", [
      ...terraform.moduleArguments({ prefix: "db_", extra: "db" }),
      ["web", "false"],
      ["wireguard_port", "51821"],
      ["ssh_key_id", shared.sshKeyId],
      ["check_key_line", "var.check_key_line"],
    ]),
    "import {",
    `  to = module.server_db.${terraform.serverResourceType}.this`,
    `  id = ${terraform.importId?.("6f1c2d3e-0000-4000-8000-000000000001")}`,
    "}",
    "",
    'output "addresses" {',
    "  value = [module.server.ipv4_address, module.server.ipv6_address, module.server_db.ipv4_address]",
    "}",
    'output "ids" {',
    "  value = [module.server.server_id, module.server.server_name, module.server.ssh_key_id]",
    "}",
  ].join("\n");
}

describe.skipIf(!runIt)("OVHcloud's module validates (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const bin = process.env[`OPSCREW_${name.toUpperCase()}_BIN`] || findExecutable(name);
    if (runIt && bin === undefined) {
      console.warn(
        `[provider-ovhcloud] skipping ${name} validation: no ${name} binary (set OPSCREW_${name.toUpperCase()}_BIN or add it to PATH).`,
      );
    }
    it.skipIf(bin === undefined)(
      `validates a root with the app's server, an extra server and a takeover with ${name}`,
      async (test) => {
        const root = await mkdtemp(join(tmpdir(), `opscrew-ovhcloud-${name}-`));
        const files = {
          ...definition.terraform.module.files,
          "cloud-init.yaml.tftpl": await readFile(CLOUD_INIT, "utf8"),
        };
        for (const [path, content] of Object.entries(files)) {
          const target = join(root, MODULE_DIR, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        await writeFile(join(root, "main.tf"), rootModule());
        const runner = new NodeCommandRunner();
        const run = (args: string[]) => runner.run(bin as string, args, { cwd: root });
        const init = await run(["init", "-backend=false", "-input=false", "-no-color"]);
        if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
          test.skip(
            `${name} could not download the ovh provider (network needed): ${init.stderr.trim().split("\n")[0]}`,
          );
        }
        expect(init.exitCode, init.stdout + init.stderr).toBe(0);
        const validate = await run(["validate", "-no-color"]);
        expect(validate.exitCode, validate.stdout + validate.stderr).toBe(0);
        const fmt = await run(["fmt", "-check", "-recursive", "-no-color", MODULE_DIR]);
        expect(fmt.exitCode, `not formatted as ${name} fmt writes it:\n${fmt.stdout}`).toBe(0);
      },
      300_000,
    );
  }
});

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUD_PROVIDER_CONTRACT_VERSION,
  type FetchLike,
  type PlannedResourceJson,
} from "@opscrew/contracts";
import { findExecutable, isRecord, NodeCommandRunner, Redactor } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { collectProviderModule } from "../../../../scripts/gen-provider-modules";
import { CREDENTIALS_ENV } from "./__fixtures__/fixtures";
import {
  definition,
  KAMATERA_CREDENTIALS,
  KAMATERA_CREDENTIALS_HINT,
  KAMATERA_LOCATIONS,
  STATIC_PLANS,
  STATIC_RATES,
} from "./index";
import { HOURS_A_MONTH } from "./static-prices";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
/** OpsCrew's regions (plan-schema's `RegionSchema`, which a provider package does not import). */
const REGIONS = ["eu-central", "eu-north", "us-east", "us-west", "ap-southeast"];
const ENV_VARS = ["KAMATERA_API_CLIENT_ID", "KAMATERA_API_SECRET"];
const CONSOLE_URL = "https://console.kamatera.com/";
const PRICING_URL = "https://www.kamatera.com/pricing/";
/** A deploy key's public half, synthetic. */
const DEPLOY_KEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)} opscrew-deploy`;
/** How the module's `name` validation starts its message: Kamatera's provider's rule. */
const NAME_RULE = "Kamatera needs a server name of 4 to 40 letters, digits, dashes or dots";
/** Nothing in a unit test reaches the network: the catalogue's public file read is refused. */
const offline: FetchLike = () => Promise.reject(new Error("no request in this test"));

/** The module's main.tf. */
function mainTf(): string {
  return definition.terraform.module.files["main.tf"] ?? "";
}

/** The HCL block of main.tf that starts with `head`, up to its closing brace at column 0. */
function block(head: string): string {
  const main = mainTf();
  const start = main.indexOf(head);
  expect(start, head).toBeGreaterThanOrEqual(0);
  const rest = main.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
}

/** Every user-facing text of the definition, its functions called with sample values. */
function allTexts(): string {
  const { texts } = definition;
  return JSON.stringify({
    ...texts,
    runbook: {
      ...texts.runbook,
      serverLabel: texts.runbook.serverLabel("A-2-4", "EU-FR"),
      deletes: texts.runbook.deletes("shop"),
      whatRemains: texts.runbook.whatRemains("img", "opscrew", "wf.yml", false),
    },
    destroy: {
      ...texts.destroy,
      snapshotRef: texts.destroy.snapshotRef("shop:4521"),
      lookup: texts.destroy.lookup("shop"),
      tokenHint: texts.destroy.tokenHint("opscrew destroy"),
    },
    notes: definition.regions.notes,
    descriptions: definition.terraform.descriptions,
  });
}

describe("Kamatera's cloud provider definition", () => {
  it("has the contract's version, its names, its pages and every part", () => {
    expect(definition.contractVersion).toBe(CLOUD_PROVIDER_CONTRACT_VERSION);
    expect(definition).toMatchObject({
      id: "kamatera",
      displayName: "Kamatera",
      name: "Kamatera",
      serverNoun: "server",
      // OpsCrew's own ids for the configurations Kamatera sells (A-2-4).
      sizeNoun: "plan",
      consoleUrl: CONSOLE_URL,
      accountUrl: CONSOLE_URL,
      // Where Kamatera's own "Get started" leads: the 30-day trial's sign-up.
      signupUrl: "https://www.kamatera.com/free-trial/",
      pricingUrl: PRICING_URL,
    });
    // Plain pages: no query string or fragment that could carry a referral.
    expect(definition.signupUrl).toMatch(/^https:\/\/[^?#]+$/);
    expect(definition.pricingUrl).toMatch(/^https:\/\/[^?#]+$/);
    for (const part of ["credentials", "regions", "offering", "terraform", "texts"] as const) {
      expect(definition[part]).toBeDefined();
    }
  });

  it("needs both values of an API key, which have no recognisable format", () => {
    const { credentials } = definition;
    expect(credentials).toMatchObject({
      envVars: ENV_VARS,
      mode: "all",
      createUrl: KAMATERA_CREDENTIALS.createUrl,
      tokenRules: [],
      envPrefixes: ["KAMATERA", "CLOUDCLI"],
    });
    expect(Object.keys(credentials.labels).sort()).toEqual([...ENV_VARS].sort());
    for (const name of ENV_VARS) expect(credentials.labels[name], name).toMatch(/^Kamatera /);
    expect(credentials.labels.KAMATERA_API_CLIENT_ID).toContain("access key");
    expect(credentials.labels.KAMATERA_API_SECRET).toContain("secret key");
    for (const text of [
      "Error: error response from Kamatera API (500): map[message:No servers found]",
      'Error: Post "https://cloudcli.cloudwm.com/service/server": dial tcp: i/o timeout',
      "with module.server.kamatera_server.this",
    ]) {
      expect(credentials.apiPattern.test(text), text).toBe(true);
    }
    for (const text of [
      "api.hetzner.cloud",
      "with ovh_cloud_instance.this",
      "api.cloudflare.com",
    ]) {
      expect(credentials.apiPattern.test(text), text).toBe(false);
    }
  });

  it("maps every region to the datacenters the catalogue offers, noting the codes it inferred", () => {
    const { locations, locationNames, coordinates, notes } = definition.regions;
    expect(locations).toEqual({
      "eu-central": ["EU-FR", "EU"],
      "eu-north": ["EU-ST"],
      "us-east": ["US-NY2"],
      "us-west": ["US-SC"],
      "ap-southeast": ["AS-SG"],
    });
    expect(Object.keys(locations).sort()).toEqual([...REGIONS].sort());
    // The catalogue offers every plan in exactly these datacenters.
    expect([...new Set(Object.values(locations).flat())].sort()).toEqual(
      [...KAMATERA_LOCATIONS].sort(),
    );
    expect(locationNames).toEqual({
      "EU-FR": "Frankfurt",
      EU: "Amsterdam",
      "EU-ST": "Stockholm",
      "US-NY2": "New York",
      "US-SC": "Santa Clara",
      "AS-SG": "Singapore",
    });
    for (const location of KAMATERA_LOCATIONS) {
      const [latitude, longitude] = coordinates[location] ?? [];
      expect(Math.abs(latitude ?? 99), location).toBeLessThanOrEqual(90);
      expect(Math.abs(longitude ?? 999), location).toBeLessThanOrEqual(180);
    }
    expect(coordinates["US-SC"]?.[1]).toBeLessThan(coordinates["US-NY2"]?.[1] ?? 0);
    expect(coordinates["EU-ST"]?.[0]).toBeGreaterThan(coordinates["EU-FR"]?.[0] ?? 90);
    // Stockholm's and Singapore's codes are read from Kamatera's price list, which names no city.
    expect(Object.keys(notes).sort()).toEqual(["ap-southeast", "eu-north"]);
    expect(notes["eu-north"]).toContain("EU-ST");
    expect(notes["eu-north"]).toContain("Stockholm");
    expect(notes["ap-southeast"]).toContain("AS-SG");
    expect(notes["ap-southeast"]).toContain("Singapore");
  });

  it("bills by the hour until the server is terminated, with snapshots per GB that may outlive it", () => {
    expect(definition.offering).toEqual({
      currency: "USD",
      // Kamatera bills by the minute; "second" is the finer of the contract's two counts.
      billing: { model: "hourly", counts: "second", setupFee: false },
      defaultImage: "Ubuntu 24.04",
      backupPercent: 0,
      providerBackups: false,
      backupsPrice: "order-page",
      backupsOutliveServer: true,
      snapshots: {
        kind: "per-gb",
        perGbMonth: STATIC_RATES.snapshotPerGbMonth,
        perGbHour: STATIC_RATES.snapshotPerGbMonth / HOURS_A_MONTH,
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

  it("tells a datacenter without room from an account limit, and neither from an outage", () => {
    const { unavailable, serverLimit } = definition.offering;
    for (const text of [
      "error response from Kamatera API (500): No capacity in datacenter EU-ST",
      "There is not enough capacity for this server",
      "The selected configuration is out of stock",
      "This CPU type is not available in this datacenter",
    ]) {
      expect(unavailable.test(text), text).toBe(true);
      expect(serverLimit.test(text), text).toBe(false);
    }
    for (const text of [
      "Server creation allotment exceeded",
      "The server price exceeds your price limit",
      "You reached the maximum number of servers",
    ]) {
      expect(serverLimit.test(text), text).toBe(true);
      expect(unavailable.test(text), text).toBe(false);
    }
    for (const text of [
      "Service Temporarily Unavailable",
      "error response from Kamatera API (401): Authentication failed",
      "rate limit exceeded",
    ]) {
      expect(unavailable.test(text), text).toBe(false);
      expect(serverLimit.test(text), text).toBe(false);
    }
  });

  it("prices its offers by its billing facts, from the table when the price list can't be read", async () => {
    const { billing, snapshots, currency } = definition.offering;
    const catalog = definition.connector({ env: {}, fetch: offline }).catalog();
    const offers = await catalog.listOffers();
    expect(offers).toHaveLength(STATIC_PLANS.length * KAMATERA_LOCATIONS.length);
    for (const offer of offers) {
      expect(offer.billing).toBe(billing.model);
      expect(offer.source).toBe("static");
      expect(offer.hourly?.currency).toBe(currency);
      expect(offer.hourly?.amount ?? Infinity).toBeLessThan(offer.monthly.amount);
      expect(offer.setupFee).toBeUndefined();
    }
    const extras = await catalog.extras("EU-FR");
    expect(snapshots.kind).toBe("per-gb");
    if (snapshots.kind !== "per-gb") return;
    expect(extras.snapshotPerGbMonth).toEqual({ amount: snapshots.perGbMonth, currency });
    expect(extras.snapshotPerGbHour).toEqual({ amount: snapshots.perGbHour, currency });
  });

  it("has servers only with both values set", () => {
    const without = definition.connector({ env: {}, fetch: offline });
    expect(without.configured).toBe(false);
    expect(without.servers).toBeUndefined();
    const connector = definition.connector({
      env: CREDENTIALS_ENV,
      redactor: new Redactor(),
      fetch: offline,
    });
    expect(connector.configured).toBe(true);
    expect(connector.servers?.findAppServers).toBeTypeOf("function");
  });

  it("has the texts the contract asks for, and no resize text since a size change is refused", () => {
    const { texts } = definition;
    expect(texts.resizeOffline).toBeUndefined();
    expect(texts.interview.label).toBe("Kamatera");
    expect(texts.interview.hint).toMatch(/hour.*USD/);
    // Kamatera's prices are public: no variable turns them on.
    expect(texts.design).toEqual({ summaryNoun: "Kamatera server", titleSuffix: " on Kamatera" });
    for (const name of ENV_VARS) expect(texts.init.fix).toContain(name);
    expect(texts.init.fix).toContain(KAMATERA_CREDENTIALS_HINT);
    expect(texts.init.fix).toContain(KAMATERA_CREDENTIALS.createUrl);
    // A key can't be limited, so the help says so and suggests a separate account.
    expect(texts.init.fix).toContain("everything on your Kamatera account");
    expect(texts.init.fix).toContain("separate Kamatera account");
    expect(texts.init.scopeNote).toBe("");
    expect(texts.rotate.deleteToken).toContain(CONSOLE_URL);
    expect(texts.rotate.deleteToken).toContain("API → Keys");
    expect(texts.runbook.serverLabel("A-2-4", "EU-FR")).toBe("Kamatera A-2-4 in EU-FR");
    expect(texts.runbook.console).toBe("Kamatera's console");
    expect(texts.runbook.deleteProtectionNote.join("\n")).toContain("No delete protection");
    expect(texts.runbook.snapshotFirst.join("\n")).toContain("per GB per month");
    expect(texts.runbook.noSnapshot.join("\n")).toContain("no database");
    expect(texts.runbook.connectNote).toEqual([]);
    expect(texts.destroy.console).toBe("Kamatera's console");
    expect(texts.destroy.snapshotRef("shop:4521")).toBe("Kamatera snapshot shop:4521");
    // Snapshots bill per GB while Kamatera keeps them, which may be after the server is gone.
    for (const text of [texts.destroy.snapshotBilling, texts.destroy.snapshotBilled]) {
      expect(text).toContain("per GB per month");
      expect(text).toContain("as long as");
      expect(text).not.toMatch(/\$|\d+\.\d+/);
    }
    expect(texts.destroy.snapshotBilling).toContain("Kamatera");
    expect(texts.destroy.lookup("shop")).toBe("named shop or shop-… in your Kamatera account");
    expect(texts.destroy.tokenHint("opscrew destroy")).toBe(
      `${KAMATERA_CREDENTIALS_HINT} Then run \`opscrew destroy\` again.`,
    );
    // No provider backups and no object storage.
    expect(texts.destroy.deletedBackups).toBeUndefined();
    expect(texts.destroy.keptBackups).toBeUndefined();
    expect(texts.destroy.keptBackupsRemaining).toBeUndefined();
    expect(texts.destroy.storageConsole).toBeUndefined();
  });

  it("says a stopped server still bills, at the table's rates, and only the terminate ends it", () => {
    const { runbook } = definition.texts;
    const deletes = runbook.deletes("shop");
    expect(deletes).toContain("terminate");
    expect(deletes).toContain("stopped server still bills");
    expect(deletes).toContain(`$${STATIC_RATES.stoppedIpv4Monthly} a month`);
    expect(deletes).toContain(`$${STATIC_RATES.stoppedDiskPerGbMonth} per GB a month`);
    expect(runbook.deleteProtectionNote.join("\n")).toContain("stopped server still bills");
    // What may stay and bill: the server's snapshots, named as OpsCrew names them.
    const remains = runbook.whatRemains("img", "opscrew", "wf.yml", false).join("\n");
    expect(remains).toContain("snapshots");
    expect(remains).toContain("`opscrew-…`");
    expect(remains).toContain("per GB per month");
    expect(remains).toContain("`img`");
    expect(remains).toContain("`opscrew/`");
    expect(remains).toContain("`wf.yml`");
  });

  it("claims no cloud firewall and names no task in any text", () => {
    const text = allTexts();
    expect(definition.texts.runbook.cloudFirewall).toMatch(/^no cloud firewall/);
    // Every mention of a cloud firewall says there is none.
    for (const match of text.matchAll(/.{0,30}cloud firewall/g)) {
      expect(match[0], match[0]).toMatch(/\bno cloud firewall|has no cloud firewall/);
    }
    expect(text).not.toMatch(/\bT\d{4}\b|\b0\d\d\b|feature \d/);
  });

  it("builds the module arguments of the app's server, an extra server and the previous one", () => {
    const { moduleArguments } = definition.terraform;
    expect(moduleArguments({ prefix: "" })).toEqual([
      ["name", "var.app_name"],
      ["location", "var.location"],
      ["server_type", "var.server_type"],
      ["image", "var.image"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
    ]);
    // An app tag passed in is ignored: Kamatera's Terraform has no tags.
    expect(
      moduleArguments({ prefix: "db_", extra: "db", appTag: "module.server.app_tag_name" }),
    ).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      ["name", '"${var.app_name}-db"'],
      ["location", "var.db_location"],
      ["server_type", "var.db_server_type"],
      ["image", "var.db_image"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
    ]);
    const previous = moduleArguments({ prefix: "previous_" });
    expect(previous).toContainEqual(["location", "var.previous_location"]);
    expect(previous).toContainEqual(["server_type", "var.previous_server_type"]);
  });

  it("gives each server the deploy key's text, with no key object to share", () => {
    // Kamatera has no SSH key resource: every server takes the key's text (`ssh_pubkey`).
    expect(definition.terraform.extraShared).toEqual({
      resources: [],
      sshKeyId: "var.deploy_ssh_public_key",
    });
    const main = mainTf();
    expect(main).not.toMatch(/^resource "(?!kamatera_server")/m);
    expect(block('resource "kamatera_server" "this" {')).toContain(
      "  ssh_pubkey = var.ssh_public_key",
    );
  });

  it("uses Kamatera's own Terraform provider, the first boot as a startup script, and nothing of the connector", () => {
    expect(definition.terraform).toMatchObject({
      provider: { name: "kamatera", source: "Kamatera/kamatera", version: "~> 0.9.4" },
      serverResourceType: "kamatera_server",
      firstBoot: "script",
      connectorFirewall: false,
      connectorBackups: false,
      connectorRemoval: false,
      homeCacheFiles: [],
      mirroredAttributes: {},
      deleteProtectionVariable: false,
    });
    // No root variable and no import id of its own: the takeover writes the quoted id.
    expect(definition.terraform.rootVariables).toBeUndefined();
    expect(definition.terraform.importId).toBeUndefined();
    const { credentialsComment } = definition.terraform;
    for (const name of ENV_VARS) expect(credentialsComment).toContain(name);
    expect(credentialsComment).toContain("price list");
    const versions = definition.terraform.module.files["versions.tf"] ?? "";
    expect(versions).toContain('source  = "Kamatera/kamatera"');
    expect(versions).toContain('version = "~> 0.9.4"');
  });

  it("ignores the server's attributes whose change would recreate it, and says so to drift", () => {
    expect(definition.terraform.lifecycleIgnored).toEqual([
      "image_id",
      "ssh_pubkey",
      "startup_script",
    ]);
    expect(block('resource "kamatera_server" "this" {')).toContain(
      "    ignore_changes = [image_id, ssh_pubkey, startup_script]",
    );
  });

  it("maps each plan to Kamatera's CPU type, cores, memory and disk, equal to the offers", async () => {
    const plans = [
      ...mainTf().matchAll(
        /^ {4}"([AB]-\d+-\d+)" = \{ cpu_type = "([AB])", cpu_cores = (\d+), ram_mb = (\d+), disk_sizes_gb = \[(\d+)\] \}$/gm,
      ),
    ].map(([, id, cpuType, cores, ram, disk]) => ({
      id,
      cpuType,
      vcpus: Number(cores),
      memoryGb: Number(ram) / 1024,
      diskGb: Number(disk),
    }));
    expect(plans).toEqual(
      STATIC_PLANS.map(({ id, cpuType, vcpus, memoryGb, diskGb }) => ({
        id,
        cpuType,
        vcpus,
        memoryGb,
        diskGb,
      })),
    );
    const offers = await definition.connector({ env: {}, fetch: offline }).catalog().listOffers();
    for (const offer of offers) {
      expect(plans, offer.id).toContainEqual(
        expect.objectContaining({
          id: offer.id,
          vcpus: offer.vcpus,
          memoryGb: offer.memoryGb,
          diskGb: offer.diskGb,
          cpuType: offer.cpuType === "shared" ? "A" : "B",
        }),
      );
    }
    expect(mainTf()).toContain("  plan = local.plans[var.server_type]");
  });

  it("resolves the definition's image by Kamatera's os and code in the server's datacenter", () => {
    expect(mainTf()).toContain(
      `    ${JSON.stringify(definition.offering.defaultImage)} = { os = "Ubuntu", code = "24.04 64bit" }`,
    );
    expect(block('data "kamatera_image" "this" {')).toBe(
      [
        'data "kamatera_image" "this" {',
        "  datacenter_id = var.location",
        "  os            = local.image.os",
        "  code          = local.image.code",
        "}",
      ].join("\n"),
    );
  });

  it("creates the server billed by the hour, from the shared first boot, with no password", () => {
    const server = block('resource "kamatera_server" "this" {');
    for (const line of [
      "  name          = var.name",
      "  datacenter_id = var.location",
      "  image_id      = data.kamatera_image.this.id",
      "  cpu_type      = local.plan.cpu_type",
      "  cpu_cores     = local.plan.cpu_cores",
      "  ram_mb        = local.plan.ram_mb",
      "  disk_sizes_gb = local.plan.disk_sizes_gb",
      '  billing_cycle = "hourly"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '  startup_script = templatefile("${path.module}/first-boot.sh.tftpl", {',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      '    cloud_config_b64 = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {',
      "  daily_backup   = false",
      "  power_on       = true",
      "  allow_recreate = false",
    ]) {
      expect(server, line).toContain(`${line}\n`);
    }
    // Kamatera generates the root password and keeps it in the state; OpsCrew never sets one.
    expect(server).not.toMatch(/^\s*password\s*=/m);
  });

  it("refuses a server name Kamatera's provider refuses, before the provider sees it, saying what to do", () => {
    const variables = definition.terraform.module.files["variables.tf"] ?? "";
    const rest = variables.slice(variables.indexOf('variable "name" {'));
    const name = rest.slice(0, rest.indexOf("\n}\n") + 2);
    // The provider's rule (resource_server.go): 4 to 40 characters, from a-z, A-Z, 0-9, - and .
    expect(name).toContain('    condition     = can(regex("^[a-zA-Z0-9.-]{4,40}$", var.name))\n');
    expect(name).toContain(
      `    error_message = "${NAME_RULE}, and OpsCrew would name this server \\"\${var.name}\\". Choose a different app name (or extra server's name) so that the server's name fits."\n`,
    );
  });

  it("outputs what the root module reads from every server module, the server's name as its id", () => {
    const outputs = definition.terraform.module.files["outputs.tf"] ?? "";
    for (const name of ["ipv4_address", "ipv6_address", "server_id", "server_name", "ssh_key_id"]) {
      expect(outputs).toContain(`output "${name}" {`);
    }
    const serverId = outputs.slice(outputs.indexOf('output "server_id" {'));
    expect(serverId.slice(0, serverId.indexOf("\n}\n"))).toContain(
      "value       = kamatera_server.this.name",
    );
    expect(outputs).toContain("kamatera_server.this.public_ips");
  });

  it("embeds the current module, without OpsCrew's first-boot files", () => {
    expect(definition.terraform.module.name).toBe("kamatera-instance");
    expect(definition.terraform.module.files).toEqual(collectProviderModule(packageDir));
    expect(Object.keys(definition.terraform.module.files).sort()).toEqual([
      "main.tf",
      "outputs.tf",
      "variables.tf",
      "versions.tf",
    ]);
  });
});

/** A plan's JSON (`show -json`) with the app's Kamatera server, its values `values`. */
function serverPlanJson(values: Record<string, unknown>): unknown {
  const address = "module.server.kamatera_server.this";
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: "module.server",
            resources: [
              { address, mode: "managed", type: "kamatera_server", name: "this", values },
            ],
          },
        ],
      },
    },
    resource_changes: [{ address, change: { actions: ["create"], after_unknown: { id: true } } }],
  };
}

/** The planned resources of `type` in a plan's JSON, every module's. */
function plannedOfType(planJson: unknown, type: string): PlannedResourceJson[] {
  const out: PlannedResourceJson[] = [];
  const walk = (module: unknown) => {
    if (!isRecord(module)) return;
    for (const resource of Array.isArray(module.resources) ? module.resources : []) {
      if (!isRecord(resource) || resource.type !== type || resource.mode !== "managed") continue;
      out.push({
        address: String(resource.address),
        type,
        name: String(resource.name),
        values: isRecord(resource.values) ? resource.values : {},
        unknown: {},
      });
    }
    for (const child of Array.isArray(module.child_modules) ? module.child_modules : []) {
      walk(child);
    }
  };
  if (isRecord(planJson) && isRecord(planJson.planned_values)) {
    walk(planJson.planned_values.root_module);
  }
  return out;
}

/** The value SecOps's "uses SSH keys" check reads from a planned server. */
function plannedKey(server: PlannedResourceJson): unknown {
  return server.values[definition.texts.secops.sshKeyAttribute ?? "ssh_keys"];
}

describe("Kamatera's security checks", () => {
  it("read the deploy key from the server's ssh_pubkey, as the plan has it", () => {
    expect(definition.texts.secops.sshKeyAttribute).toBe("ssh_pubkey");
    const [server] = plannedOfType(
      serverPlanJson({ name: "shop", ssh_pubkey: DEPLOY_KEY, password: null }),
      "kamatera_server",
    );
    expect(server && plannedKey(server)).toBe(DEPLOY_KEY);
    const [keyless] = plannedOfType(serverPlanJson({ name: "shop" }), "kamatera_server");
    expect(keyless && plannedKey(keyless)).toBeUndefined();
    expect(definition.texts.secops.keylessText).toContain("root password");
  });

  it("find no cloud firewall on a Kamatera server", () => {
    const { secops } = definition.texts;
    const [server] = plannedOfType(
      serverPlanJson({ name: "shop", ssh_pubkey: DEPLOY_KEY }),
      "kamatera_server",
    );
    expect(server).toBeDefined();
    if (server === undefined) return;
    // No resource type: SecOps finds no firewall in a plan, and none is attached.
    expect(definition.terraform.firewallResourceType).toBe("");
    expect(secops.attached(server, [], serverPlanJson({}))).toBe(false);
    expect(secops.attached(server, [server], serverPlanJson({}))).toBe(false);
    expect(secops.rules(server)).toEqual([]);
    expect(secops.noun).toBe("server");
    expect(secops.unattachedText).toContain("Kamatera has no cloud firewall");
    expect(secops.backupsText).toContain("snapshots");
  });
});

// Downloads the Kamatera provider from the registry, so it only runs with OPSCREW_IT=1. Binaries
// come from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH. The plan reaches nothing else: a
// local fake answers the provider's one read (the image list), and its price-list check is off.
const runIt = process.env.OPSCREW_IT === "1";
if (!runIt) {
  console.warn(
    "[provider-kamatera] skipping HCL validation: set OPSCREW_IT=1 (it downloads the Kamatera provider).",
  );
}
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;
/** OpsCrew's first-boot files, which iac-templates adds to a startup-script provider's module. */
const SHARED = join(packageDir, "../../iac-templates/shared");
const MODULE_DIR = "modules/kamatera-instance";
/** Ubuntu 24.04's id in Kamatera's public price list (research R4 §9). */
const UBUNTU_IMAGE_ID = "6000C29549da189eaef6ea8a31001a34";

/** One server of the integration root: the app's (`prefix` "") or an extra one, on `plan`. */
interface PlannedServer {
  module: string;
  prefix: "" | `${string}_`;
  extra?: string;
  plan: (typeof STATIC_PLANS)[number];
  location: string;
}

/** The app's server, then one extra server per other plan, each in its own datacenter. */
const SERVERS: PlannedServer[] = STATIC_PLANS.map((plan, index) => {
  const location = KAMATERA_LOCATIONS[index] as string;
  if (index === 0) return { module: "server", prefix: "", plan, location };
  const extra = plan.id.toLowerCase();
  return {
    module: `server_${extra.replace(/-/g, "_")}`,
    prefix: `${extra.replace(/-/g, "_")}_`,
    extra,
    plan,
    location,
  };
});

/**
 * A root module as OpsCrew renders one, with the app's server (the scheduled check's key and a
 * WireGuard port) and an extra server per other plan (no web, the key's text as `ssh_key_id`).
 * The provider block turns off its plan-time check of Kamatera's public price list, which the
 * root OpsCrew writes keeps on, so the plan reaches only the local fake.
 */
function rootModule(): string {
  const { terraform } = definition;
  const variable = (name: string, type: string) => [
    `variable "${name}" {`,
    `  type = ${type}`,
    "}",
  ];
  const moduleBlock = (server: PlannedServer) => [
    `module "${server.module}" {`,
    `  source = "./${MODULE_DIR}"`,
    ...terraform
      .moduleArguments({
        prefix: server.prefix,
        ...(server.extra === undefined ? {} : { extra: server.extra }),
      })
      .map(([key, value]) => `  ${key} = ${value}`),
    ...(server.extra === undefined
      ? ["  wireguard_port = 51820"]
      : [
          "  web = false",
          "  wireguard_port = 51821",
          `  ssh_key_id = ${terraform.extraShared.sshKeyId}`,
        ]),
    "  check_key_line = var.check_key_line",
    "}",
    "",
  ];
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
    `provider "${terraform.provider.name}" {`,
    "  disable_validations = true",
    "}",
    "",
    ...["app_name", "deploy_ssh_public_key", "check_key_line"].flatMap((name) =>
      variable(name, "string"),
    ),
    ...SERVERS.flatMap(({ prefix }) =>
      ["location", "server_type", "image"].flatMap((name) =>
        variable(`${prefix}${name}`, "string"),
      ),
    ),
    "",
    ...terraform.extraShared.resources,
    ...SERVERS.flatMap(moduleBlock),
    'output "servers" {',
    "  value = {",
    ...SERVERS.map(
      ({ module }) =>
        `    ${module} = [module.${module}.ipv4_address, module.${module}.ipv6_address, module.${module}.server_id, module.${module}.server_name, module.${module}.ssh_key_id]`,
    ),
    "  }",
    "}",
  ].join("\n");
}

/** The root's variable values. */
function rootValues(): Record<string, string> {
  return {
    app_name: "shop",
    deploy_ssh_public_key: DEPLOY_KEY,
    check_key_line: `restrict,command="/usr/local/sbin/opscrew-check" ${DEPLOY_KEY}`,
    ...Object.fromEntries(
      SERVERS.flatMap(({ prefix, plan, location }) => [
        [`${prefix}location`, location],
        [`${prefix}server_type`, plan.id],
        [`${prefix}image`, definition.offering.defaultImage],
      ]),
    ),
  };
}

/** A local fake of Kamatera's API: the image list of each datacenter, 404 for anything else. */
async function fakeKamatera() {
  const requests: { method: string; url: string; clientId: unknown; secret: unknown }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      clientId: request.headers.authclientid,
      secret: request.headers.authsecret,
    });
    const url = new URL(request.url ?? "/", "http://fake");
    const images = url.pathname === "/service/server" && url.searchParams.get("images") === "1";
    response.setHeader("content-type", "application/json");
    if (request.method !== "GET" || !images) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: true, message: "Not Found" }));
      return;
    }
    // Two Ubuntu images, so the lookup needs the code as well as the system.
    response.end(
      JSON.stringify([
        {
          id: UBUNTU_IMAGE_ID,
          os: "Ubuntu",
          code: "24.04 64bit",
          name: "ubuntu_server_24.04_64-bit",
        },
        {
          id: "6000C2911c2b3a7f0e9d4c5b6a798001",
          os: "Ubuntu",
          code: "22.04 64bit",
          name: "ubuntu_server_22.04_64-bit",
        },
      ]),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!runIt)("Kamatera's module validates and plans (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const bin = process.env[`OPSCREW_${name.toUpperCase()}_BIN`] || findExecutable(name);
    if (runIt && bin === undefined) {
      console.warn(
        `[provider-kamatera] skipping ${name} validation: no ${name} binary (set OPSCREW_${name.toUpperCase()}_BIN or add it to PATH).`,
      );
    }
    it.skipIf(bin === undefined)(
      `validates, formats and plans the app's server and an extra server per plan with ${name}`,
      async (test) => {
        const root = await mkdtemp(join(tmpdir(), `opscrew-kamatera-${name}-`));
        const files = {
          ...definition.terraform.module.files,
          "cloud-init.yaml.tftpl": await readFile(join(SHARED, "cloud-init.yaml.tftpl"), "utf8"),
          "first-boot.sh.tftpl": await readFile(join(SHARED, "first-boot.sh.tftpl"), "utf8"),
        };
        for (const [path, content] of Object.entries(files)) {
          const target = join(root, MODULE_DIR, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        await writeFile(join(root, "main.tf"), rootModule());
        await writeFile(join(root, "terraform.tfvars.json"), JSON.stringify(rootValues()));
        const fake = await fakeKamatera();
        try {
          const runner = new NodeCommandRunner();
          const env = {
            ...process.env,
            ...CREDENTIALS_ENV,
            KAMATERA_API_URL: fake.url,
            TF_IN_AUTOMATION: "1",
          };
          const output: string[] = [];
          const run = async (args: string[]) => {
            const result = await runner.run(bin as string, args, { cwd: root, env });
            output.push(result.stdout, result.stderr);
            return result;
          };
          const init = await run(["init", "-backend=false", "-input=false", "-no-color"]);
          if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
            test.skip(
              `${name} could not download the Kamatera provider (network needed): ${init.stderr.trim().split("\n")[0]}`,
            );
          }
          expect(init.exitCode, init.stdout + init.stderr).toBe(0);
          const validate = await run(["validate", "-no-color"]);
          expect(validate.exitCode, validate.stdout + validate.stderr).toBe(0);
          const fmt = await run(["fmt", "-check", "-recursive", "-no-color", MODULE_DIR]);
          expect(fmt.exitCode, `not formatted as ${name} fmt writes it:\n${fmt.stdout}`).toBe(0);

          const plan = await run([
            "plan",
            "-input=false",
            "-no-color",
            "-lock=false",
            "-out=tf.plan",
          ]);
          expect(plan.exitCode, plan.stdout + plan.stderr).toBe(0);
          const show = await run(["show", "-json", "-no-color", "tf.plan"]);
          expect(show.exitCode, show.stderr).toBe(0);
          const planJson: unknown = JSON.parse(show.stdout);

          const servers = plannedOfType(planJson, "kamatera_server");
          expect(servers.map((server) => server.address).sort()).toEqual(
            SERVERS.map(({ module }) => `module.${module}.kamatera_server.this`).sort(),
          );
          for (const { module, extra, plan: offer, location } of SERVERS) {
            const server = servers.find((s) => s.address.startsWith(`module.${module}.`));
            expect(server?.values, module).toMatchObject({
              name: extra === undefined ? "shop" : `shop-${extra}`,
              datacenter_id: location,
              image_id: UBUNTU_IMAGE_ID,
              cpu_type: offer.cpuType,
              cpu_cores: offer.vcpus,
              ram_mb: offer.memoryGb * 1024,
              disk_sizes_gb: [offer.diskGb],
              billing_cycle: "hourly",
              daily_backup: false,
              power_on: true,
              allow_recreate: false,
              password: null,
            });
            // SecOps's "uses SSH keys" check reads the key where the server has it.
            expect(server && plannedKey(server), module).toBe(DEPLOY_KEY);
            // The startup script carries the shared cloud-config, base64-encoded, with the key
            // and, on a server that serves no web, no web ports.
            const script = String(server?.values.startup_script);
            expect(script.startsWith("#!/bin/bash\n"), module).toBe(true);
            const encoded = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)?.[1] ?? "";
            const cloudConfig = Buffer.from(encoded, "base64").toString("utf8");
            expect(cloudConfig.startsWith("#cloud-config\n"), module).toBe(true);
            expect(cloudConfig).toContain(`      - ${DEPLOY_KEY}\n`);
            expect(cloudConfig.includes("[ufw, allow, 80/tcp]"), module).toBe(extra === undefined);
          }
          // The provider read each datacenter's images, and nothing else, with the API key.
          expect(fake.requests.length).toBeGreaterThan(0);
          for (const request of fake.requests) {
            expect(request).toMatchObject({
              method: "GET",
              clientId: CREDENTIALS_ENV.KAMATERA_API_CLIENT_ID,
              secret: CREDENTIALS_ENV.KAMATERA_API_SECRET,
            });
            expect(request.url).toMatch(/^\/service\/server\?images=1&datacenter=[A-Z0-9-]+$/);
          }
          // A name Kamatera's provider refuses stops the plan in OpsCrew's words: a 3-letter app.
          const short = await run([
            "plan",
            "-input=false",
            "-no-color",
            "-lock=false",
            "-var=app_name=api",
          ]);
          expect(short.exitCode, short.stdout).not.toBe(0);
          const said = `${short.stdout} ${short.stderr}`
            .replace(/[│╷╵]/g, " ")
            .replace(/\s+/g, " ");
          expect(said).toContain(
            `${NAME_RULE}, and OpsCrew would name this server "api". Choose a different app name (or extra server's name) so that the server's name fits.`,
          );
          // Neither value of the key reaches the plan, its JSON or anything the engine printed.
          const printed = [...output, await readFile(join(root, "main.tf"), "utf8")].join("\n");
          for (const value of Object.values(CREDENTIALS_ENV)) {
            expect(printed).not.toContain(value);
          }
        } finally {
          await fake.close();
        }
      },
      300_000,
    );
  }
});

describe("Kamatera definition leaks", () => {
  it("puts neither value of the key in its texts, its module or the HCL it writes", () => {
    // Built with the values, but never called: no request leaves the test.
    const connector = definition.connector({
      env: CREDENTIALS_ENV,
      redactor: new Redactor(),
      fetch: offline,
    });
    const { terraform } = definition;
    const calls = [
      { prefix: "" },
      { prefix: "db_", extra: "db" },
      { prefix: "previous_" },
    ] as const;
    const written = JSON.stringify({
      terraform: {
        ...terraform,
        moduleArguments: calls.map((call) => terraform.moduleArguments(call)),
      },
      texts: allTexts(),
      credentials: definition.credentials,
      regions: definition.regions,
      connector: { configured: connector.configured, credentials: connector.credentials },
    });
    for (const value of Object.values(CREDENTIALS_ENV)) expect(written).not.toContain(value);
  });
});

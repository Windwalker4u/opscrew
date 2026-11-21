import type {
  CloudProviderDefinition,
  ModuleCall,
  PlannedFirewallRule,
  PlannedResourceJson,
  ProviderSecOps,
} from "@opscrew/contracts";
import { isRecord, listText } from "@opscrew/core";
import {
  OVHCLOUD_CREDENTIALS_HINT,
  OVHCLOUD_CREDENTIALS_URL,
  OVHCLOUD_ENDPOINT,
  OVHCLOUD_ENV,
} from "./client";
import { ovhcloudConnector } from "./connector";
import { MODULE_FILES } from "./generated/module";
import { STATIC_SNAPSHOT_PER_GB_HOUR_EUR, STATIC_SNAPSHOT_PER_GB_MONTH_EUR } from "./static-prices";

const ENV_VARS = Object.values(OVHCLOUD_ENV);
/** OVHcloud Europe's control panel. */
const CONTROL_PANEL_URL = "https://manager.eu.ovhcloud.com/";
const CONTROL_PANEL = "the OVHcloud control panel";
/**
 * OVHcloud's Public Cloud prices for its EUR subsidiaries (Ireland's page; `/en/` shows USD).
 * Snapshot texts link to it instead of quoting a rate, so they never go stale.
 */
const PRICING_URL = "https://www.ovhcloud.com/en-ie/public-cloud/prices/";
/** Where the control panel lists a project's snapshots (OVHcloud's guide "Taking a snapshot"). */
const SNAPSHOTS_PAGE = "Public Cloud → your project → Compute → Instance Snapshot";
/** Where the control panel lists the service accounts (OVHcloud's service-account guide). */
const SERVICE_ACCOUNTS = "Identity and Access Management → Identities → Service account";

/**
 * The project's id, which every OVHcloud resource names (`service_name`). The module calls read it
 * from this root variable, which OpsCrew passes only as `TF_VAR_ovhcloud_project_id` (ADR 0029,
 * D11).
 */
const PROJECT_VARIABLE = "ovhcloud_project_id";

/** The server's name: the app's, or `<app>-<name>` for an extra server. */
function nameArgument({ extra }: ModuleCall): readonly [string, string] {
  return ["name", extra === undefined ? "var.app_name" : `"\${var.app_name}-${extra}"`];
}

/** The web's CIDRs, only on the server that serves the web (not on an extra server). */
function httpArguments({ extra }: ModuleCall): (readonly [string, string])[] {
  return extra === undefined ? [["http_allowed_cidrs", "var.http_allowed_cidrs"]] : [];
}

/** Resource address without `count`/`for_each` keys: `module.a[0].x.y["k"]` becomes `module.a.x.y`. */
function configAddress(address: string): string {
  return address.replace(/\[[^\]]*\]/g, "");
}

/** A list attribute's strings, or none. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The security groups (addresses without instance keys) each instance's `security_group_ids`
 * references, by the instance's address, read from the plan's `configuration` section. The
 * groups' ids are unknown before apply, so these references are the only way to see the
 * attachment on a first plan. An instance without `security_group_ids` references none: OVHcloud
 * puts it on the project's default group.
 */
function groupReferences(planJson: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (module: unknown, prefix: string) => {
    if (!isRecord(module)) return;
    for (const resource of Array.isArray(module.resources) ? module.resources : []) {
      if (!isRecord(resource) || resource.type !== "ovh_cloud_instance") continue;
      if (typeof resource.address !== "string") continue;
      const expressions = isRecord(resource.expressions) ? resource.expressions : {};
      const ids = isRecord(expressions.security_group_ids) ? expressions.security_group_ids : {};
      const groups = new Set<string>();
      for (const reference of strings(ids.references)) {
        const target = configAddress(reference).replace(/\.id$/, "");
        if (/^ovh_cloud_security_group\.[^.]+$/.test(target)) groups.add(`${prefix}${target}`);
      }
      out.set(`${prefix}${resource.address}`, groups);
    }
    const calls = isRecord(module.module_calls) ? module.module_calls : {};
    for (const [name, call] of Object.entries(calls)) {
      if (isRecord(call)) walk(call.module, `${prefix}module.${name}.`);
    }
  };
  if (isRecord(planJson) && isRecord(planJson.configuration)) {
    walk(planJson.configuration.root_module, "");
  }
  return out;
}

/**
 * The security group's inbound rules (`rule`, `direction = "INGRESS"`) in the Hetzner rule shape:
 * its protocol in lower case (OVHcloud's `ICMPV6` read as `icmp`, none as `""`, which is every
 * protocol), its port or range (none is every port), and its one source. OpenStack reads a rule
 * with no source as any source of its family; a rule for another group's members has no address.
 */
function securityGroupRules(resource: PlannedResourceJson): PlannedFirewallRule[] {
  const rules = resource.values.rule;
  return (Array.isArray(rules) ? rules : [])
    .filter(isRecord)
    .filter((rule) => rule.direction === "INGRESS")
    .map((rule) => {
      const protocol = typeof rule.protocol === "string" ? rule.protocol.toLowerCase() : "";
      const min = typeof rule.port_range_min === "number" ? rule.port_range_min : undefined;
      const max = typeof rule.port_range_max === "number" ? rule.port_range_max : min;
      const port = min === undefined ? "" : min === max ? `${min}` : `${min}-${max}`;
      const any = rule.ethernet_type === "IPV6" ? "::/0" : "0.0.0.0/0";
      const source =
        typeof rule.remote_ip_prefix === "string"
          ? [rule.remote_ip_prefix]
          : typeof rule.remote_group_id === "string"
            ? []
            : [any];
      return {
        direction: "in",
        protocol: protocol === "icmpv6" ? "icmp" : protocol,
        port,
        source_ips: source,
      };
    });
}

/** SecOps's checks of a plan's OVHcloud instances and their security groups. */
const SECOPS: ProviderSecOps = {
  noun: "server",
  rules: securityGroupRules,
  attached: (server, firewalls, planJson) => {
    const ids = strings(server.values.security_group_ids);
    if (firewalls.some(({ values }) => typeof values.id === "string" && ids.includes(values.id))) {
      return true;
    }
    const groups = groupReferences(planJson).get(configAddress(server.address));
    return firewalls.some((firewall) => groups?.has(configAddress(firewall.address)) ?? false);
  },
  attachedText: "The server is attached to its OVHcloud security group.",
  unattachedText:
    "The server has none of OpsCrew's security groups, so OVHcloud puts it on your project's default group, which lets every port be reached from the internet. Attach the OpsCrew security group.",
  keylessText:
    "The server has no SSH key; OVHcloud needs one to create a Linux server. Add the deploy key.",
  backupsText:
    "OpsCrew turns on no OVHcloud backups: its own snapshots of the app's data cover them.",
};

/** OVHcloud Public Cloud, as OpsCrew creates servers there (ADR 0029). */
export const definition: CloudProviderDefinition = {
  contractVersion: 1,
  id: "ovhcloud",
  displayName: "OVHcloud",
  name: "OVHcloud",
  serverNoun: "server",
  // The control panel's word for a flavor: "Select a model" when creating an instance.
  sizeNoun: "model",
  consoleUrl: CONTROL_PANEL_URL,
  accountUrl: CONTROL_PANEL_URL,
  // The page the control panel's sign-in page links to as "Create an account".
  signupUrl: "https://manager.eu.ovhcloud.com/account-creation/",
  pricingUrl: PRICING_URL,
  credentials: {
    envVars: ENV_VARS,
    labels: {
      [OVHCLOUD_ENV.endpoint]: `OVHcloud API zone (${OVHCLOUD_ENDPOINT})`,
      [OVHCLOUD_ENV.clientId]: "OVHcloud service account client ID",
      [OVHCLOUD_ENV.clientSecret]: "OVHcloud service account client secret",
      [OVHCLOUD_ENV.projectId]: "OVHcloud Public Cloud project ID",
    },
    mode: "all",
    createUrl: OVHCLOUD_CREDENTIALS_URL,
    // A service account's id and secret and a project's id have no recognisable format.
    tokenRules: [],
    envPrefixes: ["OVH"],
    apiPattern: /api\.eu\.ovhcloud\.com|eu\.api\.ovh\.com|auth\.eu\.ovhcloud\.com|ovh_cloud_/i,
  },
  connector: (deps) => ovhcloudConnector(deps),
  regions: {
    locations: {
      "eu-central": ["DE1", "SBG5", "GRA11", "WAW1"],
      "eu-north": ["WAW1"],
      "us-east": ["BHS5"],
      "us-west": ["BHS5"],
      "ap-southeast": ["SGP1", "SYD1"],
    },
    locationNames: {
      DE1: "Limburg, near Frankfurt",
      SBG5: "Strasbourg",
      GRA11: "Gravelines",
      WAW1: "Warsaw",
      BHS5: "Beauharnois, near Montreal",
      SGP1: "Singapore",
      SYD1: "Sydney",
    },
    notes: {
      "eu-north":
        "OVHcloud's locations in the Nordics are local zones OpsCrew doesn't use, so it uses Warsaw, the nearest of OVHcloud's regions.",
      "us-east":
        "OVHcloud's US regions belong to OVHcloud US, a separate account, so OpsCrew uses Beauharnois, near Montreal, the nearest region.",
      "us-west":
        "OVHcloud's US regions belong to OVHcloud US, a separate account, so OpsCrew uses Beauharnois, near Montreal, which is far from the US west coast.",
    },
    // Approximate, for the delay estimates (research R1 §6).
    coordinates: {
      DE1: [50.4, 8.0],
      SBG5: [48.6, 7.8],
      GRA11: [51.0, 2.1],
      WAW1: [52.2, 21.0],
      BHS5: [45.3, -73.9],
      SGP1: [1.35, 103.8],
      SYD1: [-33.9, 151.2],
    },
  },
  offering: {
    currency: "EUR",
    // Hourly instances are metered per second after one minute, until they are deleted.
    billing: { model: "hourly", counts: "second", setupFee: false },
    defaultImage: "Ubuntu 24.04",
    backupPercent: 0,
    // OVHcloud's automated backups are images that outlive the server; OpsCrew's own data
    // snapshots cover the data instead.
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
    // Unverified until the live pass: OVHcloud documents no wording for a create refused for
    // stock or region. OUT_OF_STOCK is the availability API's word; "No valid host was found" is
    // OpenStack's when no host has room.
    unavailable:
      /out[ _]of[ _]stock|no valid host was found|not available in (this|the) region|region \S+ is not activated|(?<!service (temporarily )?)unavailable/i,
    // Unverified until the live pass: "Quota exceeded" is OpenStack's wording, INSUFFICIENT the
    // availability API's quota status. A refused right ("insufficient rights") is not a limit.
    serverLimit: /quota exceeded|insufficient quota|quota\w*\W+insufficient/i,
  },
  terraform: {
    provider: { name: "ovh", source: "ovh/ovh", version: "~> 2.25.0" },
    serverResourceType: "ovh_cloud_instance",
    firewallResourceType: "ovh_cloud_security_group",
    connectorFirewall: false,
    connectorBackups: false,
    connectorRemoval: false,
    homeCacheFiles: [],
    mirroredAttributes: {},
    lifecycleIgnored: ["user_data", "image_id", "ssh_key_name"],
    module: { name: "ovhcloud-instance", files: MODULE_FILES },
    credentialsComment: `Credentials from the ${listText([OVHCLOUD_ENV.endpoint, OVHCLOUD_ENV.clientId, OVHCLOUD_ENV.clientSecret])} environment variables (never stored in files or state); the Public Cloud project's id from TF_VAR_${PROJECT_VARIABLE}.`,
    deleteProtectionVariable: false,
    descriptions: {
      location: "OVHcloud Public Cloud region.",
      serverType: "OVHcloud model (flavor name).",
      backups:
        "OVHcloud's automated backups, which OpsCrew doesn't turn on: always false, OpsCrew's own snapshots cover the data.",
    },
    moduleArguments: (call) => [
      nameArgument(call),
      ["project_id", `var.${PROJECT_VARIABLE}`],
      ["location", `var.${call.prefix}location`],
      ["server_type", `var.${call.prefix}server_type`],
      ["image", `var.${call.prefix}image`],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ...httpArguments(call),
    ],
    extraShared: {
      resources: [
        "# The deploy key of the app's servers on OVHcloud, kept here so that removing a server never",
        "# deletes it (its name is unique in the project). The servers get it by its name, which OVHcloud",
        "# names a key by.",
        'resource "ovh_cloud_ssh_key" "deploy" {',
        `  service_name = var.${PROJECT_VARIABLE}`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
        '  name         = "${var.app_name}-deploy"',
        "  public_key   = var.deploy_ssh_public_key",
        "}",
        "",
      ],
      sshKeyId: "ovh_cloud_ssh_key.deploy.name",
    },
    rootVariables: [
      {
        name: PROJECT_VARIABLE,
        description: `Id of your OVHcloud Public Cloud project, which holds the app's servers. OpsCrew passes it as TF_VAR_${PROJECT_VARIABLE} from ${OVHCLOUD_ENV.projectId}; it is never written to a committed file.`,
        fromEnv: OVHCLOUD_ENV.projectId,
      },
    ],
    // `ovh_cloud_instance` imports as `<project>/<instance id>`.
    importId: (serverId) => `"\${var.${PROJECT_VARIABLE}}/${serverId}"`,
  },
  texts: {
    rotate: { deleteToken: `${CONTROL_PANEL} (${CONTROL_PANEL_URL}, ${SERVICE_ACCOUNTS})` },
    interview: {
      label: "OVHcloud",
      hint: "servers in Germany, France and Poland, plus Canada, Singapore and Australia; billed by the hour, per second, until deleted; prices in EUR; needs a Public Cloud project",
    },
    design: {
      summaryNoun: "OVHcloud server",
      titleSuffix: " on OVHcloud",
      // Live prices and availability need all four values; design names the service account's id.
      livePricesVar: OVHCLOUD_ENV.clientId,
    },
    init: {
      fix: OVHCLOUD_CREDENTIALS_HINT,
      scopeNote:
        " Limit the service account with an IAM policy (Identity and Access Management → Policies) whose only resource is your Public Cloud project and whose actions are publicCloudProject:apiovh:*, so it reaches nothing else in your account.",
    },
    runbook: {
      serverLabel: (type, location) => `OVHcloud ${type} in ${location}`,
      console: CONTROL_PANEL,
      backupsOnDatabaseCell: "snapshots with `opscrew snapshot`",
      backupsOn:
        "OpsCrew turns on no OVHcloud backups: its own snapshots of the app's data (`opscrew snapshot`) cover them.",
      cloudFirewall: "the OVHcloud security group",
      deletes: (app) =>
        `the server (its hourly billing stops when it is deleted), its security group \`opscrew-${app}\` and its SSH key \`${app}-deploy\``,
      connectNote: [],
      snapshotReason: "the app keeps data on the server",
      snapshotFirst: [
        "OpsCrew takes an OVHcloud snapshot of the server",
        "  before deleting it (skip it with `--no-snapshot`). OVHcloud keeps it in your Public Cloud project after the",
        "  server is gone and bills it per GB per month until you delete it in the control panel.",
      ],
      noSnapshot: [
        "- **Snapshot:** this app keeps no database on the server, so OpsCrew does not take a snapshot before deleting it.",
        "  OVHcloud has no automated backups through OpsCrew, so nothing else keeps a copy of the server.",
      ],
      deleteProtectionNote: [
        "- **No delete protection:** OVHcloud has no delete protection. Deleting the server in the control panel deletes it",
        "  and its disk at once; `opscrew destroy` is the safe way, because it shows the plan, offers a snapshot and asks for",
        "  the typed name first.",
      ],
      whatRemains: (image, folder, workflowPath) => [
        "- **What remains:** the server's snapshots, the one taken first and any other (OVHcloud keeps them in your Public",
        `  Cloud project and bills them per GB per month at the rate listed on ${PRICING_URL} until you delete`,
        `  them in the control panel: ${SNAPSHOTS_PAGE}), the container images in GitHub Container`,
        `  Registry (\`${image}\`), and the files in this repository (\`${folder}/\` and \`${workflowPath}\`).`,
      ],
      hostKey: "the server's host key",
    },
    destroy: {
      console: CONTROL_PANEL,
      snapshotRef: (id) => `OVHcloud snapshot ${id}`,
      snapshotBilling: `OVHcloud keeps snapshots after the server is deleted and bills them per GB per month at the rate listed on ${PRICING_URL} until they are deleted in the control panel (${SNAPSHOTS_PAGE})`,
      snapshotBilled: `billed per GB per month at the rate listed on ${PRICING_URL} until it is deleted in the control panel`,
      lookup: (app) => `named ${app} or ${app}-… in your Public Cloud project`,
      tokenHint: (command) => `${OVHCLOUD_CREDENTIALS_HINT} Then run \`${command}\` again.`,
    },
    secops: SECOPS,
  },
};

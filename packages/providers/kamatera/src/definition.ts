import type { CloudProviderDefinition, ModuleCall, ProviderSecOps } from "@opscrew/contracts";
import { listText } from "@opscrew/core";
import { KamateraCatalog } from "./catalog";
import { KAMATERA_CREDENTIALS_HINT, KAMATERA_ENV } from "./client";
import { KAMATERA_CREDENTIALS, kamateraConnector } from "./connector";
import { MODULE_FILES } from "./generated/module";
import { HOURS_A_MONTH, STATIC_RATES } from "./static-prices";

const ENV_VARS = Object.values(KAMATERA_ENV);
/** Kamatera's console: the servers, their snapshots and the API keys. */
const CONSOLE_URL = "https://console.kamatera.com/";
const CONSOLE = "Kamatera's console";

/** How every text says where a Kamatera server's firewall is (issue #13). */
const FIREWALL_WORDS = "cloud firewall: none; server firewall: on";
/** When the server's own firewall applies. */
const FIREWALL_GAP = "a few seconds after the server starts";

/** The server's name: the app's, or `<app>-<name>` for an extra server. */
function nameArgument({ extra }: ModuleCall): readonly [string, string] {
  return ["name", extra === undefined ? "var.app_name" : `"\${var.app_name}-${extra}"`];
}

/** The web's networks, only on the server that serves the web (not on an extra server). */
function httpArguments({ extra }: ModuleCall): (readonly [string, string])[] {
  return extra === undefined ? [["http_allowed_cidrs", "var.http_allowed_cidrs"]] : [];
}

/**
 * SecOps's checks of a plan's Kamatera servers. Kamatera has no cloud firewall: no Terraform
 * resource and no API route sets one (research R4 §4). The server's own firewall is the first step
 * of its first boot (issue #13), so SecOps reads it from the planned server's startup script and
 * `opscrew secure` from the server (`firewallCheck`); `rules` and `attached` find nothing.
 */
const SECOPS: ProviderSecOps = {
  noun: "server",
  firewallCheck: "server",
  rules: () => [],
  attached: () => false,
  attachedText: `Cloud firewall: none; server firewall: on. Kamatera has no cloud firewall, so the server's own firewall (nftables) is the first step of its first boot: it drops everything the plan doesn't allow from ${FIREWALL_GAP}, when Kamatera runs the startup script.`,
  unattachedText:
    "Cloud firewall: none; server firewall: off. Kamatera has no cloud firewall, and the server's startup script doesn't set up OpsCrew's firewall, so every port would be reachable from the internet. Run `opscrew provision` again: it writes the server's module with the firewall as the first step.",
  keylessText:
    "The server has no SSH key, so the only way in would be the root password Kamatera generates. Add the deploy key.",
  // The server takes the key's text (`kamatera_server.ssh_pubkey`), not `ssh_keys`.
  sshKeyAttribute: "ssh_pubkey",
  backupsText:
    "OpsCrew turns on no Kamatera daily backups: its own snapshots of the app's data cover them.",
};

/** Kamatera, as OpsCrew creates cloud servers there (ADR 0029). */
export const definition: CloudProviderDefinition = {
  contractVersion: 1,
  id: "kamatera",
  displayName: "Kamatera",
  name: "Kamatera",
  serverNoun: "server",
  // OpsCrew's own ids for the configurations Kamatera sells (`A-2-4`).
  sizeNoun: "plan",
  consoleUrl: CONSOLE_URL,
  accountUrl: CONSOLE_URL,
  // Where Kamatera's own "Get started" leads: the sign-up of its 30-day trial.
  signupUrl: "https://www.kamatera.com/free-trial/",
  pricingUrl: "https://www.kamatera.com/pricing/",
  credentials: {
    envVars: ENV_VARS,
    labels: {
      [KAMATERA_ENV.clientId]: "Kamatera API access key (client ID)",
      [KAMATERA_ENV.secret]: "Kamatera API secret key",
    },
    mode: "all",
    createUrl: KAMATERA_CREDENTIALS.createUrl,
    // Kamatera's access key and secret key have no recognisable format.
    tokenRules: [],
    // Kamatera's Terraform provider reads KAMATERA_*, its CLI CLOUDCLI_*.
    envPrefixes: ["KAMATERA", "CLOUDCLI"],
    apiPattern: /cloudcli\.cloudwm\.com|console\.kamatera\.com|kamatera api|kamatera_/i,
  },
  connector: (deps) =>
    kamateraConnector(deps, {
      catalog: ({ fetch, now }) => new KamateraCatalog({ fetch, now }),
    }),
  regions: {
    locations: {
      "eu-central": ["EU-FR", "EU"],
      "eu-north": ["EU-ST"],
      "us-east": ["US-NY2"],
      "us-west": ["US-SC"],
      "ap-southeast": ["AS-SG"],
    },
    locationNames: {
      "EU-FR": "Frankfurt",
      EU: "Amsterdam",
      "EU-ST": "Stockholm",
      "US-NY2": "New York",
      "US-SC": "Santa Clara",
      "AS-SG": "Singapore",
    },
    // Kamatera's own repository names the city of EU-FR, EU, US-NY2 and US-SC; the other two
    // codes are read against its list of cities (research R4 §6), until a live list says them.
    notes: {
      "eu-north":
        "OpsCrew takes Kamatera's EU-ST datacenter to be Stockholm: Kamatera's price list has the code but names no city, and its list of datacenters has Stockholm.",
      "ap-southeast":
        "OpsCrew takes Kamatera's AS-SG datacenter to be Singapore: Kamatera's price list has the code but names no city, and its list of datacenters has Singapore.",
    },
    // Approximate, for the delay estimates (research R4 §6).
    coordinates: {
      "EU-FR": [50.1, 8.7],
      EU: [52.4, 4.9],
      "EU-ST": [59.3, 18.1],
      "US-NY2": [40.7, -74.0],
      "US-SC": [37.4, -121.9],
      "AS-SG": [1.35, 103.8],
    },
  },
  offering: {
    currency: "USD",
    // Kamatera bills an hourly server by the minute (research R4 §3), until it is terminated;
    // "second" is the closer of the contract's two counts, and differs by under a cent.
    billing: { model: "hourly", counts: "second", setupFee: false },
    defaultImage: "Ubuntu 24.04",
    backupPercent: 0,
    // Kamatera's daily backups have a flag but no published price (research R4 §5); OpsCrew's
    // own snapshots of the app's data cover them.
    providerBackups: false,
    backupsPrice: "order-page",
    backupsOutliveServer: true,
    snapshots: {
      kind: "per-gb",
      perGbMonth: STATIC_RATES.snapshotPerGbMonth,
      perGbHour: STATIC_RATES.snapshotPerGbMonth / HOURS_A_MONTH,
    },
    // Unverified until the live pass: Kamatera doesn't say whether a server's snapshots outlive
    // it, so OpsCrew assumes they do and keep billing.
    serverSnapshotsOutliveServer: true,
    deleteProtection: false,
    // A disk-size change fails at Kamatera's API (the provider's issue #32), and a CPU or memory
    // change is unverified: a size change is refused, and a move is the way.
    resize: false,
    offAfterRefusedResize: false,
    removal: { kind: "delete" },
    // Unverified until the live pass: Kamatera documents no wording for a datacenter without
    // room. A user's server price limit or server creation allotment refuses a create too.
    unavailable:
      /no (?:available )?capacity|not enough capacity|out of stock|not available in (?:this|the) datacenter|(?<!service (?:temporarily )?)unavailable/i,
    serverLimit: /allotment|price limit|maximum number of servers|server limit/i,
  },
  terraform: {
    provider: { name: "kamatera", source: "Kamatera/kamatera", version: "~> 0.9.4" },
    serverResourceType: "kamatera_server",
    // No type: Kamatera has no cloud firewall resource. SecOps checks the server's own firewall
    // instead (see SECOPS).
    firewallResourceType: "",
    connectorFirewall: false,
    connectorBackups: false,
    connectorRemoval: false,
    homeCacheFiles: [],
    mirroredAttributes: {},
    lifecycleIgnored: ["image_id", "ssh_pubkey", "startup_script"],
    module: { name: "kamatera-instance", files: MODULE_FILES },
    credentialsComment: `Credentials from the ${listText(ENV_VARS)} environment variables (never stored in files or state). At plan time the provider checks the server's configuration against Kamatera's public price list, so a plan needs the network.`,
    deleteProtectionVariable: false,
    descriptions: {
      location: "Kamatera datacenter code.",
      serverType: "Kamatera plan (OpsCrew's id: CPU type, vCPUs and GB of memory, such as A-2-4).",
      backups:
        "Kamatera's daily backups, which OpsCrew doesn't turn on: always false, OpsCrew's own snapshots cover the data.",
    },
    moduleArguments: (call) => [
      nameArgument(call),
      ["location", `var.${call.prefix}location`],
      ["server_type", `var.${call.prefix}server_type`],
      ["image", `var.${call.prefix}image`],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      // The networks the server's own firewall lets in, as another provider's cloud firewall.
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ...httpArguments(call),
    ],
    // Kamatera keeps no copy of a key: every server takes the deploy key's text, so the app's
    // servers share no resource, and an extra server gets the text itself as `ssh_key_id`.
    extraShared: { resources: [], sshKeyId: "var.deploy_ssh_public_key" },
    // Kamatera takes a startup script and no user data (ADR 0029, D12).
    firstBoot: "script",
    // No importId: Kamatera imports by its internal id, not the name, so a takeover fails at plan.
  },
  texts: {
    rotate: { deleteToken: `${CONSOLE} (${CONSOLE_URL}, API → Keys)` },
    interview: {
      label: "Kamatera",
      hint: `servers in Frankfurt, Amsterdam, Stockholm, New York, Santa Clara and Singapore; billed by the hour, counted by the minute, until terminated (a stopped server still bills); prices in USD; ${FIREWALL_WORDS}, from ${FIREWALL_GAP}`,
    },
    design: { summaryNoun: `Kamatera server (${FIREWALL_WORDS})`, titleSuffix: " on Kamatera" },
    init: {
      fix: `${KAMATERA_CREDENTIALS_HINT} Kamatera's steps: ${KAMATERA_CREDENTIALS.createUrl}. A key can't be limited: it can do everything on your Kamatera account, so a separate Kamatera account for OpsCrew is the safest.`,
      scopeNote: "",
    },
    runbook: {
      serverLabel: (type, location) => `Kamatera ${type} in ${location}`,
      console: CONSOLE,
      backupsOnDatabaseCell: "snapshots with `opscrew snapshot`",
      backupsOn:
        "OpsCrew turns on no Kamatera daily backups: its own snapshots of the app's data (`opscrew snapshot`) cover them.",
      cloudFirewall: `the server's own nftables firewall, the first step of its first boot (${FIREWALL_WORDS}, from ${FIREWALL_GAP}; the firewall in Kamatera's console, which OpsCrew can't set, stays off unless you turn it on)`,
      deletes: () =>
        `the server (Kamatera terminates it, and only that ends its hourly billing: a stopped server still bills its IP address, about $${STATIC_RATES.stoppedIpv4Monthly} a month, and its disk, about $${STATIC_RATES.stoppedDiskPerGbMonth} per GB a month)`,
      connectNote: [],
      snapshotReason: "the app keeps data on the server",
      snapshotFirst: [
        "OpsCrew takes a Kamatera snapshot of the server",
        "  before terminating it (skip it with `--no-snapshot`). Kamatera bills it per GB per month for as long as it keeps",
        "  it, and doesn't say whether it keeps a snapshot once its server is terminated: check in its console.",
      ],
      noSnapshot: [
        "- **Snapshot:** this app keeps no database on the server, so OpsCrew does not take a snapshot before terminating it.",
        "  OpsCrew turns on no Kamatera backups, so nothing else keeps a copy of the server.",
      ],
      deleteProtectionNote: [
        "- **No delete protection:** Kamatera has no delete protection. Terminating the server in its console removes it for",
        "  good, and only that ends its billing: a stopped server still bills its IP address and its disk. `opscrew destroy`",
        "  is the safe way, because it shows the plan, offers a snapshot and asks for the typed name first.",
      ],
      whatRemains: (image, folder, workflowPath) => [
        "- **What remains:** the server's snapshots named `opscrew-…`, the one taken first and any other, if Kamatera keeps",
        "  them once the server is terminated (it doesn't say; each is billed per GB per month while it exists, so check in",
        `  its console and delete them there), the container images in GitHub Container Registry (\`${image}\`), and the`,
        `  files in this repository (\`${folder}/\` and \`${workflowPath}\`).`,
      ],
      hostKey: "the server's host key",
    },
    destroy: {
      console: CONSOLE,
      snapshotRef: (id) => `Kamatera snapshot ${id}`,
      snapshotBilling:
        "Kamatera bills snapshots per GB per month for as long as it keeps them, and doesn't say whether that ends with the server",
      snapshotBilled: "billed per GB per month for as long as Kamatera keeps it",
      lookup: (app) => `named ${app} or ${app}-… in your Kamatera account`,
      tokenHint: (command) => `${KAMATERA_CREDENTIALS_HINT} Then run \`${command}\` again.`,
    },
    secops: SECOPS,
  },
};

import {
  type DeployPlan,
  ghcrImageFor,
  type OwnDeployTarget,
  serviceOf,
} from "@opscrew/plan-schema";
import { providerBucket } from "../infra/storage";
import { usesCloudflare } from "../predicates";
import { siteHosts } from "../runtime";
import { artefactsFolder } from "../runtime-dir";
import {
  homeIpv6Proxied,
  homeMode,
  PORTAINER_PORT,
  portainerHostname,
  sshHostname,
  tunnelMode,
} from "../tunnel";
import type { RenderedFile } from "../types";
import { OUTSIDE_CHECK_WORKFLOW_FILE } from "../workflow/outside-check";
import { runbookFilePath, selfHosted } from "../workflow/shared";
import {
  componentsSection,
  dataCell,
  edgeSection,
  objectStorageSection,
  recoverySection,
} from "./components";
import { networkSection } from "./network";
import { addonSections, checkSection } from "./observability";
import {
  cell,
  DATABASE_DUMP,
  deployAgain,
  deployKeyStored,
  deployRows,
  deploySections,
  driftFiles,
  externalDatabaseCell,
  opscrew,
  type RunbookContext,
  runbookFolders,
  runbookHead,
  securityHead,
  serverCommands,
  settingsSection,
  troubleshooting,
} from "./shared";

/**
 * `opscrew/RUNBOOK.md` for a server the user already owns. The server's address never appears in
 * it, in any mode (FR-902, stricter than ADR 0010's exception for unproxied servers): commands name
 * `<server>`, and `ctx.serverIpv4`/`serverIpv6` are ignored. No server price: the user already
 * pays for the server. Backups are the user's responsibility, and the Portainer password is only
 * named by its file. Another environment's runbook has its own folders and `--env <env>`.
 */
export function renderOwnRunbook(
  plan: DeployPlan,
  target: OwnDeployTarget,
  ctx: RunbookContext,
): RenderedFile {
  const tunnel = tunnelMode(plan);
  const cloudflare = usesCloudflare(plan);
  const proxied = cloudflare && plan.dns.proxied;
  const hosts = siteHosts(plan);
  const url =
    hosts.length > 0 ? `https://${hosts[0]}` : "`http://<server>` (your server's address)";
  const { environments } = ctx;
  const folders = runbookFolders(plan, ctx.projectId);
  const projectDir = folders.home;
  const keyPath = `${projectDir}/deploy_key`;
  const server = "<server>";
  // Both commands connect to the server directly (in tunnel mode over the user's own network), so
  // sshd's port applies whenever it is not 22.
  const port = ctx.sshPort !== undefined && ctx.sshPort !== 22 ? `-p ${ctx.sshPort} ` : "";
  const sshHost = sshHostname(plan);
  const portainer = plan.portainer?.enabled ? plan.portainer : undefined;
  const portainerHost = portainerHostname(plan);
  const repo = `${ctx.github.owner}/${ctx.github.repo}`;
  const name = plan.app.name;
  // The app's bucket at a provider, which destroy keeps unless asked (Garage's is on the server).
  const bucket = providerBucket(plan)?.bucket;
  const status = opscrew(plan, "status", environments);
  const provision = opscrew(plan, "provision", environments);
  const drift = opscrew(plan, "drift", environments);

  const addresses = tunnel
    ? "none needed: the server is reached through a Cloudflare Tunnel"
    : proxied
      ? `kept private behind Cloudflare: \`${status}\` shows them`
      : `kept out of this repository: \`${status}\` shows them`;
  const db = dataCell(
    plan,
    `snapshots with \`${opscrew(plan, "snapshot", environments)}\` (see Backups)`,
    externalDatabaseCell(plan),
  );
  const dns = tunnel
    ? "Cloudflare, through a Cloudflare Tunnel (no DNS record points at the server)"
    : cloudflare
      ? `Cloudflare, ${plan.dns.proxied ? "proxied (the server's address is hidden behind Cloudflare)" : "DNS only"}`
      : "No domain yet: the app is served over plain HTTP on the server's address";

  const lines = [
    ...runbookHead(plan, ctx, url),
    `| Server | ${cell(`your own server (${target.arch}); OpsCrew prepared it over SSH and never creates, rebuilds or deletes it`)} |`,
    `| IPv4 / IPv6 | ${cell(addresses)} |`,
    ...(sshHost === undefined
      ? []
      : [
          `| SSH for deploys | \`${sshHost}\`, through the tunnel and Cloudflare Access (only the deploy workflow's service token gets in) |`,
        ]),
    ...deployRows(plan, repo),
    `| Database | ${cell(db)} |`,
    `| DNS | ${cell(dns)} |`,
    ...(portainer === undefined
      ? []
      : [
          `| Portainer | ${cell(portainerHost ? `https://${portainerHost} (Cloudflare Access) and through an SSH tunnel` : "through an SSH tunnel only")} |`,
        ]),
    "| Cost | no server price: you already pay for this server; OpsCrew adds no server cost |",
    "",
    ...deploySections(plan, ctx, {
      build:
        target.arch === "arm64"
          ? ["   Your server is arm64, so the image is built on GitHub's arm64 runner."]
          : [],
      // The server's own runner deploys without SSH, so without the tunnel's SSH hostname.
      start:
        sshHost === undefined || selfHosted(plan)
          ? []
          : [
              `   Your server has no open port for this: the workflow installs a pinned \`cloudflared\` and connects to \`${sshHost}\``,
              "   through the Cloudflare Tunnel with a Cloudflare Access service token kept in the deploy secrets.",
            ],
    }),
    ...componentsSection(plan, environments),
    ...edgeSection(plan, true, environments),
    ...objectStorageSection(plan, projectDir, environments),
    ...networkSection(plan, environments),
    "## Connect to the server",
    "",
    "Your own login keeps working as before (with your key). To work as the deploy user:",
    "",
    ...serverCommands(plan, [`ssh ${port}-i ${keyPath} deploy@${server}`]),
    "",
    `\`<server>\` is the address you gave OpsCrew; it is not written in this repository. \`${status}\` shows it on the`,
    `machine that ran \`${provision}\`.`,
    ...(tunnel
      ? [
          `The tunnel's SSH hostname (\`${sshHost}\`) only lets the deploy workflow in; connect over your own network`,
          `or VPN as you did when you ran \`${provision}\`.`,
        ]
      : proxied
        ? [
            "Cloudflare's proxy hides the address, and a published address would let anyone go around Cloudflare.",
          ]
        : []),
    "",
    deployKeyStored(plan, environments),
    "secret). OpsCrew turned off password logins on the server.",
    "",
    ...(homeMode(plan) ? homeSection(plan, environments) : []),
    "## Backups",
    "",
    `\`${opscrew(plan, "snapshot", environments)}\` takes a snapshot of the app's data on this server, \`${opscrew(plan, "snapshot schedule on", environments)}\` takes them on a`,
    `schedule, and \`${opscrew(plan, "snapshot offsite on --to <provider>", environments)}\` keeps an encrypted copy of each off the server; \`${opscrew(plan, "restore <id>", environments)}\``,
    `puts one back. \`${opscrew(plan, "destroy", environments)}\` takes no snapshot first. OpsCrew cannot back up the server itself: back it up the`,
    "way your hosting provider or your own setup allows, and keep copies somewhere else.",
    "",
  ];
  if (serviceOf(plan, "postgres")) {
    lines.push("You can also dump the database by hand, for example:", "", ...DATABASE_DUMP);
  }

  if (portainer !== undefined) {
    lines.push(
      "## Portainer",
      "",
      `Portainer CE ${portainer.version} shows your server's containers. It listens only on the server itself`,
      `(127.0.0.1:${PORTAINER_PORT}), because it controls Docker, which is root on the server. To open it, start an SSH tunnel`,
      "(`opscrew portainer status` prints this command for you):",
      "",
      "```bash",
      `ssh ${port}-i ${keyPath} -N -L ${PORTAINER_PORT}:127.0.0.1:${PORTAINER_PORT} deploy@${server}`,
      "```",
      "",
      `Then open https://localhost:${PORTAINER_PORT} (Portainer uses a self-signed certificate) and log in as \`admin\`.`,
      `The password is in \`${projectDir}/portainer_password\``,
      `on the machine that ran \`${provision}\`; it is never written to this repository.`,
      ...(portainerHost === undefined
        ? []
        : [
            "",
            `It is also served on https://${portainerHost}, behind Cloudflare Access: only the email addresses listed in`,
            `\`${folders.artefacts}/plan.yaml\` get in, with a one-time PIN sent to that address, and Portainer's own login still applies.`,
          ]),
      "",
      "`opscrew portainer disable` removes it (deleting its data only after you type the app name).",
      "",
    );
  }

  lines.push(
    ...checkSection(plan, environments),
    ...addonSections(plan, ctx),
    ...settingsSection(plan, environments, [
      `- **Domain or tunnel:** run \`${opscrew(plan, "design", environments)}\` and \`${provision}\`. OpsCrew shows the plans (the Cloudflare changes and`,
      "  the host changes) and applies nothing without your approval.",
      "- **Switching between direct access and the tunnel** runs in two steps: OpsCrew first removes the current way in",
      "  (the DNS records, or the tunnel and its Access applications), then adds the new one, each with its own plan and",
      "  approval. The app is not reachable on its domain between the two steps.",
      "- **Your server itself** (size, operating system, other software) is yours to manage; OpsCrew changes only what its",
      "  host plan lists, and records each change in `/etc/opscrew/host.json` on the server.",
    ]),
    ...recoverySection(plan, environments),
    "## Check for drift",
    "",
    `Run \`${drift}\` on the machine that ran \`${provision}\`. It compares:`,
    "",
    `- **Cloudflare with the state and the code:** DNS records${tunnel || portainerHost ? ", the tunnel and Cloudflare Access" : ""} changed`,
    `  outside OpsCrew, or changes in \`${folders.infra}/\` that have not been applied yet.`,
    "- **The server with what OpsCrew set up:** SSH settings, firewall rules, the deploy user, runtime files and containers,",
    "  against the record in `/etc/opscrew/host.json`.",
    ...driftFiles(plan),
    "",
    `\`${drift}\` never changes anything. To fix drift, run \`${provision}\`, which shows the plans and applies`,
    "nothing without your approval.",
    "",
    ...securityHead(plan, environments),
    "- What OpsCrew set up on the server: Docker Engine from Docker's repository, a `deploy` user with key-only SSH,",
    "  password logins off (root keeps key-only access only if you log in as root), automatic security updates and,",
    `  unless another firewall already manages the server, a host firewall that allows only SSH${tunnel ? "" : ", HTTP and HTTPS"}.`,
    tunnel
      ? "- No inbound web port is open: Cloudflare's edge reaches the app only through the tunnel, which the server dials out to."
      : "- Only Caddy publishes ports (80 and 443); every other container port stays on the server.",
  );
  if (!tunnel && proxied) {
    lines.push(
      "- Web traffic comes through Cloudflare's proxy; keep the server's address private so nobody goes around it.",
    );
  }
  lines.push(
    "",
    ...troubleshooting(plan, environments),
    "## Tear it down",
    "",
    `Run \`${opscrew(plan, "destroy", environments)}\` on the machine that ran \`${provision}\`. It removes what OpsCrew set up for this app: the`,
    `${cloudflare ? `Cloudflare ${tunnel ? "tunnel, Access applications and DNS records" : "DNS records and rules"} OpsCrew created, the ` : ""}app's containers and runtime`,
    "files on the server, and the GitHub deploy secrets. It **never** deletes, rebuilds or reinstalls your server.",
    "",
    `- **App data:** the data in \`/srv/data/${name}\`${bucket === undefined ? " and" : ","} the app's Docker volumes${bucket === undefined ? "" : ` and the bucket \`${bucket}\``} stay unless you add`,
    `  \`--delete-data\`, which needs the destroy approval and the typed app name (\`${name}\`; \`--confirm ${name}\` in scripts).`,
    "  There is no snapshot: back up first if you want to keep it. Other apps on the server keep their data.",
    `- **Undo OpsCrew's host changes:** \`${opscrew(plan, "destroy --undo-host", environments)}\` also plans the reverse of what OpsCrew changed on the`,
    "  server (deploy user, SSH settings, firewall, automatic updates, Docker if OpsCrew installed it), from the record in",
    "  `/etc/opscrew/host.json`. It is a separate plan that you approve on its own.",
    `- **What remains:** your server, the container images in GitHub Container Registry (\`${ghcrImageFor(repo, plan.app.key)}\`), and`,
    `  the files in this repository (\`${artefactsFolder(plan, "prod")}/\` and \`${plan.cicd.workflowPath}\`).`,
    "",
    ...deployAgain(plan, environments),
  );
  return { path: runbookFilePath(plan), content: lines.join("\n"), kind: "doc" };
}

/**
 * The home section (FR-2902, R8, R11): the router's forwards, the address updater and what its
 * token can reach, SSH from the home network only, the outside check, and console recovery after
 * the home network is renumbered. It names commands, files and units, never an address: the LAN
 * and public addresses are shown by `opscrew status`, never written here. The updater's paths and
 * unit names are `@opscrew/connector-ssh-host`'s (`dns-updater.ts`), which this package does not
 * depend on.
 */
function homeSection(plan: DeployPlan, environments: readonly string[] | undefined): string[] {
  const name = plan.app.name;
  const updater = usesCloudflare(plan);
  const proxied = updater && plan.dns.proxied;
  const ipv4 = plan.target.provider === "own" && plan.target.home?.ipv4 !== false;
  const status = opscrew(plan, "status", environments);
  const verify = opscrew(plan, "verify", environments);
  const provision = opscrew(plan, "provision", environments);
  const ipv6Rule = "allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall.";
  const router = ipv4
    ? [
        "- Forward TCP 80 and TCP 443 to the server's address on your home network, and reserve that address for the",
        `  server in the router's DHCP settings so it stays fixed. \`${status}\` shows the address; it is not written here.`,
        "  When the server has its public IPv4 address on its own interface, no forwards are needed.",
        ...(proxied
          ? []
          : updater
            ? [`- While your connection has IPv6, the site also has an AAAA record: ${ipv6Rule}`]
            : [`- If you add an AAAA record for the site, ${ipv6Rule}`]),
      ]
    : [
        `- The site is served over IPv6${homeIpv6Proxied(plan) ? " behind Cloudflare's proxy" : " only"}, so no IPv4 forwards are needed: ${ipv6Rule}`,
      ];
  const zone = plan.dns.zone ?? plan.dns.domain;
  const timer = `opscrew-dns-updater@${name}.timer`;
  const config = `/etc/opscrew/dns-updater/${name}`;
  const lines = [
    "## Hosting at home",
    "",
    "This server is at your home, and visitors reach it through your home connection. OpsCrew never changes your",
    "router: these are the settings it needs from you.",
    "",
    "### Your router",
    "",
    ...router,
    "- Don't forward SSH: OpsCrew reaches the server over your home network.",
    "",
    "### The address updater",
    "",
  ];
  if (updater) {
    lines.push(
      `\`${timer}\` runs every 2 minutes on the server. It reads your connection's public address and updates`,
      `this app's ${ipv4 ? (proxied ? "A" : "A (and AAAA, while your connection has IPv6)") : "AAAA"} record at Cloudflare when the address changes, touching only the records OpsCrew made for it.`,
      `Its settings are in \`${config}.json\` and its token in \`${config}.token\` (root only, mode 0600);`,
      `its state is in \`/var/lib/opscrew-dns-updater/${name}/\`. \`${status}\` shows its last run and its last error`,
      `${proxied ? "(never the address, which stays behind Cloudflare's proxy)" : "and the addresses it sees"}, and \`${verify}\` fails when its last success is`,
      `older than 10 minutes or the records differ. On the server, \`journalctl -u opscrew-dns-updater@${name}.service\` shows its runs`,
      "without any address.",
      "",
      `The updater changes only this app's A/AAAA records, but its token can change any record in ${zone}. Anything with`,
      "root on your server can use it, the deploy runner included: it runs your repository's code in the docker group,",
      "which is as good as root. To replace it, make a new token at https://dash.cloudflare.com/profile/api-tokens",
      `(Zone, DNS, Edit, for ${zone} only), set \`OPSCREW_DNS_UPDATER_TOKEN\`, and run \`${opscrew(plan, "rotate dns-updater", environments)}\`.`,
      "The token lives only on the server, never in this repository or in GitHub.",
      "",
    );
  } else {
    lines.push(
      "Your DNS is not on Cloudflare, so there is no address updater: the records you added keep working only while your",
      "connection's public address stays the same. If your provider changes it, update the records yourself.",
      "",
    );
  }
  lines.push(
    "### SSH from your home network only",
    "",
    "OpsCrew's nftables table `inet opscrew` on the server lets SSH in only from the networks in `server.sshFrom` (your",
    `home network by default; they are kept on the machine that ran \`${provision}\`, never in this repository).`,
    `Away from home, the server does not answer SSH: \`${status}\` says it answers SSH only on your home network, and`,
    `\`${verify}\` skips the checks that need SSH.`,
    "",
    "### The outside check",
    "",
    `\`${verify}\` runs \`.github/workflows/${OUTSIDE_CHECK_WORKFLOW_FILE}\` on GitHub's hosted runners, which request the site`,
    "over HTTP and HTTPS from outside your network. A request from inside your network is not proof: it can pass when",
    "visitors can't get in, or fail when they can. When the check fails, it names the port; the cause is a missing",
    "forward, your provider blocking the port, or a connection without a public IPv4 address, and OpsCrew can't tell",
    "which. A Cloudflare Tunnel works on any of them.",
    ...(proxied
      ? [
          'Behind the proxy, the HTTP result reads "Cloudflare answered on port 80": it proves the forward on port 80 only',
          "when the zone sends plain-HTTP requests to the server.",
        ]
      : []),
    "",
    "### If SSH stops answering after your network changed",
    "",
    "A new router, for example, can give your home network new addresses, and the server then refuses SSH from them.",
    "On the server's console (a screen and keyboard attached to it), remove OpsCrew's SSH table:",
    "",
    "```bash",
    "sudo nft delete table inet opscrew",
    "```",
    "",
    `Then run \`${opscrew(plan, "interview --answers <file>")}\` with the new network in \`server.sshFrom\` (or without it`,
    `for the default) and \`${provision}\`, which puts the table back for the new network after your approval. Check that`,
    "the router's forwards point at the server's new address on your home network.",
    "",
  );
  return lines;
}

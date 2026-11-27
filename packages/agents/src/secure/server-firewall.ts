/**
 * `secure`'s check of the server's own firewall, on a server whose provider has no cloud firewall
 * (`firewallCheck` `server`, issue #13; Kamatera): the nftables table the first boot loads,
 * read live from the server and held to the plan. Read-only.
 */
import { canonicalSshSource } from "@opscrew/connector-ssh-host";
import type { CheckResult, CommandResult } from "@opscrew/contracts";
import { listText } from "@opscrew/core";
import {
  IMAGES,
  SERVER_FIREWALL_TABLE,
  serverFirewallTable,
  webOnlyFromCloudflare,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, isCloudProvider } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import type { HostCheck } from "@opscrew/secops";

/**
 * Lists OpsCrew's table as root, run as `deploy` (who has no sudo but is in the docker group): the
 * host's own `nft`, in the host's network, with only the rights it needs to read the rules.
 */
const READ_TABLE = `docker run --rm --network host --cap-drop ALL --cap-add NET_ADMIN --cap-add SYS_CHROOT --volume /:/host:ro ${IMAGES.caddy.ref} chroot /host nft list table ${SERVER_FIREWALL_TABLE}`;

/** Every address of each family, as the module's networks write it. */
const WORLD = ["0.0.0.0/0", "::/0"];

/** A network as nft lists it (`/32` and `/128` left out); `/0` as it is. */
function listed(network: string): string {
  return canonicalSshSource(network) ?? network.trim();
}

/** The table's lines without their indentation; older nft prints a chain's priority as 0. */
function tableLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim().replace(" priority 0;", " priority filter;"))
    .filter((line) => line !== "");
}

/** The networks the live table lets reach the web ports (`<family> saddr <network>`), in order. */
function webSources(lines: readonly string[]): string[] {
  return lines.flatMap(
    (line) => /^ip6? saddr (\S+) tcp dport \{ 80, 443 \} accept$/.exec(line)?.[1] ?? [],
  );
}

/** The cloud provider of server `server` of `plan`, when OpsCrew creates it. */
function serverProvider(plan: DeployPlan, server: string) {
  const id =
    server === APP_SERVER
      ? plan.target.provider
      : plan.servers?.find((s) => s.name === server)?.target.provider;
  return isCloudProvider(id) ? cloudProvider(id) : undefined;
}

/**
 * The check of the firewall on server `server` (the app's or an extra one) of `plan`, or undefined
 * when its provider has a cloud firewall. It passes only when the live table is the one the first
 * boot writes for the plan: default drop, SSH from `security.sshAllowedCidrs`, the web ports on the
 * app's server as `security.httpAllowedFrom` says (Cloudflare's ranges, as the server was set up
 * with them, when proxied), the network's WireGuard port where the server has one, and Docker's
 * other published ports dropped from outside.
 */
export function serverFirewallCheck(plan: DeployPlan, server: string): HostCheck | undefined {
  const provider = serverProvider(plan, server);
  if (provider?.texts.secops.firewallCheck !== "server") return undefined;
  const web = server === APP_SERVER;
  const cloudflare = web && webOnlyFromCloudflare(plan);
  const sshSources = plan.security.sshAllowedCidrs.map(listed);
  const wireguardPort = plan.network?.members.find((member) => member.name === server)?.port;
  const remediation = `${provider.name} has no cloud firewall, so this is the server's only one. As root on the server (from ${provider.texts.runbook.console}), \`nft -f /etc/nftables.conf\` loads the rules its first boot wrote again; if the plan's networks changed since, change them in that file first. Then run \`opscrew secure\` again.`;
  const base = {
    id: "server-firewall",
    title: "The server's own firewall lets in only what the plan allows",
    severity: "critical",
  } as const;
  const check = (status: CheckResult["status"], message: string): CheckResult => ({
    ...base,
    status,
    message,
    ...(status === "pass" ? {} : { remediation }),
  });
  return {
    ...base,
    command: READ_TABLE,
    evaluate(result: CommandResult): CheckResult {
      if (result.exitCode !== 0) {
        const said = `${result.stderr}\n${result.stdout}`;
        if (/No such file or directory/.test(said)) {
          return check(
            "fail",
            `The server has no firewall of OpsCrew's (no nftables table ${SERVER_FIREWALL_TABLE}), and ${provider.name} has no cloud firewall, so nothing filters its ports.`,
          );
        }
        const reason = said.trim().split("\n")[0]?.slice(0, 200) ?? "";
        return check("fail", `OpsCrew could not read the server's firewall: ${reason}`);
      }
      const live = tableLines(result.stdout);
      const expected = serverFirewallTable({
        sshSources,
        webSources: !web ? [] : cloudflare ? webSources(live) : WORLD,
        wireguardPort,
      });
      if (live.join("\n") === expected.join("\n")) {
        const allowed = [
          sshSources.length === 0 ? "no SSH from outside" : "SSH from the plan's networks",
          ...(web ? [`the web ports from ${cloudflare ? "Cloudflare only" : "everyone"}`] : []),
          ...(wireguardPort === undefined ? [] : [`WireGuard's port ${wireguardPort}`]),
        ];
        return check(
          "pass",
          `The server's own firewall drops by default and lets in only ${listText(allowed)} (cloud firewall: none; server firewall: on).`,
        );
      }
      const problems: string[] = [];
      if (!live.includes("type filter hook input priority filter; policy drop;")) {
        problems.push("it doesn't drop by default");
      }
      if (cloudflare && webSources(live).length === 0) {
        problems.push("it doesn't hold ports 80 and 443 to Cloudflare's ranges, as the plan says");
      }
      const quoted = (lines: string[]) => listText(lines.slice(0, 6).map((line) => `\`${line}\``));
      const extra = live.filter((line) => !expected.includes(line));
      const missing = expected.filter((line) => !live.includes(line));
      if (extra.length > 0) problems.push(`it has rules the plan doesn't: ${quoted(extra)}`);
      if (missing.length > 0) problems.push(`it lacks the plan's rules ${quoted(missing)}`);
      if (problems.length === 0) problems.push("its rules are not in the plan's order");
      return check(
        "fail",
        `The server's own firewall differs from the plan's: ${problems.join("; ")}.`,
      );
    },
  };
}

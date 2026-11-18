/**
 * `opscrew secure` for a server at home (plan 13., research R11): the server-side checks only the
 * admin login can read (OpsCrew's SSH table and its sources, the web filter's families, the address
 * updater's token file and timer, the power supply), and the words for this computer's probes,
 * which run from inside the home network and so prove nothing about the outside. No check names an
 * address, a source or the token: the report is committed.
 */
import {
  canonicalSshSource,
  type DnsUpdaterFact,
  type HostFacts,
} from "@opscrew/connector-ssh-host";
import type { CheckResult } from "@opscrew/contracts";
import { errorText, upperFirst } from "@opscrew/core";
import { homeIpv6Proxied, webFilterMode } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { AWAY_FROM_HOME, type HomeServerRead } from "../home/server";
import { UPDATER_TOKEN_VAR } from "../home/token";
import { checkResult } from "../shared";
import type { OwnHome } from "../shared/server-record";
import { sshTableSources, utcText } from "../status/home";

/** Where this computer's probes of a server at home come from, and what proves more. */
export function insideLabel(home: OwnHome): string {
  const check = home.outsideCheck;
  return check === undefined
    ? "(from inside your network: not proof; `opscrew verify` checks from outside your home)"
    : `(from inside your network: not proof; see the outside check of ${utcText(check.at)})`;
}

/**
 * A probe from this computer of a server at home: labelled with {@link insideLabel}, and never a
 * failure (a failed one is a warning).
 */
export function fromInside(check: CheckResult, label: string): CheckResult {
  return {
    ...check,
    ...(check.status === "fail" ? { status: "warn" as const, severity: "info" as const } : {}),
    message: `${check.message} ${label}`,
  };
}

/** A rule of OpsCrew's SSH table that drops SSH from every other source. */
const DROP_RULE = /^tcp dport \d+ drop$/;

/** OpsCrew's SSH table on the server: there, with the recorded sources, dropping the rest. */
function sshTableCheck(facts: HostFacts, home: OwnHome, flags: string): CheckResult {
  const id = "home-ssh-table";
  const title = "SSH answers only on your home network (OpsCrew's SSH table)";
  const fix = `Run \`opscrew drift${flags}\` to see what changed, then \`opscrew provision${flags}\`: it shows the change that puts OpsCrew's SSH table back.`;
  const { table, enabled } = facts.sshFirewall;
  if (table === null) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      "OpsCrew's SSH table (nftables `inet opscrew`) isn't on your server, so SSH answers any address that reaches it, also when a router forwards SSH by mistake.",
      { remediation: fix },
    );
  }
  const wanted = (home.sshFrom ?? []).map((source) => canonicalSshSource(source) ?? source);
  const found = sshTableSources(table);
  const same = wanted.length === found.length && wanted.every((source) => found.includes(source));
  const drops = table.split("|").some((line) => DROP_RULE.test(line.trim()));
  if (!same || !drops) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      !drops
        ? "OpsCrew's SSH table on your server doesn't drop SSH from other addresses."
        : "OpsCrew's SSH table on your server lets SSH in from other sources than the ones recorded on this computer.",
      { remediation: fix },
    );
  }
  if (!enabled) {
    return checkResult(
      id,
      title,
      "medium",
      "fail",
      "OpsCrew's SSH table is on your server, but its unit (opscrew-ssh-firewall.service) isn't enabled, so the table is gone after a restart.",
      { remediation: fix },
    );
  }
  return checkResult(
    id,
    title,
    "info",
    "pass",
    "OpsCrew's SSH table lets SSH in only from the sources recorded on this computer, and its unit loads it at boot.",
  );
}

/**
 * The web filter, per family the site is served on behind Cloudflare's proxy: OpsCrew's IPv4 chain
 * in Docker's `DOCKER-USER` that drops all but Cloudflare, and over IPv6 its table
 * `inet opscrew-web`. None with DNS only: visitors reach the server directly.
 */
function webFilterChecks(plan: DeployPlan, facts: HostFacts, flags: string): CheckResult[] {
  if (!webFilterMode(plan)) return [];
  const fix = `Run \`opscrew drift${flags}\` to see what changed, then \`opscrew provision${flags}\`: it shows the change that lets only Cloudflare's IP ranges reach ports 80 and 443.`;
  const { rules4, table6 } = facts.webFilter;
  const ipv4 = rules4.chain?.dropsRest === true && rules4.dockerUser.jumps > 0;
  const checks = [
    checkResult(
      "home-web-filter-ipv4",
      "Over IPv4, only Cloudflare reaches the web ports (OpsCrew's web filter)",
      ipv4 ? "info" : "high",
      ipv4 ? "pass" : "fail",
      ipv4
        ? "OpsCrew's web filter in Docker's DOCKER-USER chain lets only Cloudflare's IPv4 ranges reach ports 80 and 443."
        : "OpsCrew's web filter for IPv4 is missing or incomplete on your server, so visitors can reach it around Cloudflare's proxy.",
      ipv4 ? {} : { remediation: fix },
    ),
  ];
  if (homeIpv6Proxied(plan)) {
    const ipv6 = table6 !== undefined;
    checks.push(
      checkResult(
        "home-web-filter-ipv6",
        "Over IPv6, only Cloudflare reaches the web ports (OpsCrew's web filter)",
        ipv6 ? "info" : "high",
        ipv6 ? "pass" : "fail",
        ipv6
          ? "OpsCrew's IPv6 web filter (nftables `inet opscrew-web`) is on your server."
          : "OpsCrew's IPv6 web filter (nftables `inet opscrew-web`) isn't on your server, so visitors can reach it over IPv6 around Cloudflare's proxy.",
        ipv6 ? {} : { remediation: fix },
      ),
    );
  }
  return checks;
}

/** The address updater's token file (root, 0600) and its timer (enabled and running). */
function updaterChecks(
  updater: DnsUpdaterFact | undefined,
  flags: string,
): [CheckResult, CheckResult] {
  const tokenTitle = "The address updater's token file is root's alone (0600)";
  const timerTitle = "The address updater runs every 2 minutes (its timer)";
  const provision = `Run \`opscrew provision${flags}\`: it shows the change that sets the address updater up again.`;
  if (updater === undefined) {
    const missing =
      "The address updater isn't on your server, so the site's DNS records don't follow your home's address.";
    return [
      checkResult("dns-updater-token", tokenTitle, "high", "fail", missing, {
        remediation: provision,
      }),
      checkResult("dns-updater-timer", timerTitle, "high", "fail", missing, {
        remediation: provision,
      }),
    ];
  }
  const { token, timer } = updater;
  const tokenOk = token.present && token.owner === "root" && token.mode === "600";
  const tokenCheck = !token.present
    ? checkResult(
        "dns-updater-token",
        tokenTitle,
        "high",
        "fail",
        "The address updater's token file isn't on your server, so it can't change the site's records.",
        {
          remediation: `Set \`${UPDATER_TOKEN_VAR}\` (the guide's recipe) and run \`opscrew provision${flags}\`.`,
        },
      )
    : checkResult(
        "dns-updater-token",
        tokenTitle,
        tokenOk ? "info" : "high",
        tokenOk ? "pass" : "fail",
        tokenOk
          ? "The token file is owned by root with mode 0600: only root reads it."
          : `The token file is owned by ${token.owner || "an unknown user"} with mode ${token.mode || "unknown"}, so more than root may read the token.`,
        tokenOk
          ? {}
          : {
              remediation: `Run \`opscrew provision${flags}\`: it puts the file back as root's with mode 0600. If someone may have read it, make a new token and run \`opscrew rotate dns-updater${flags}\`.`,
            },
      );
  const running = timer.enabled && timer.active;
  const timerCheck = checkResult(
    "dns-updater-timer",
    timerTitle,
    running ? "info" : "high",
    running ? "pass" : "fail",
    running
      ? "The updater's timer is enabled and running."
      : `The updater's timer is ${timer.enabled ? "enabled but not running" : "not enabled"}, so the site's records don't follow your home's address.`,
    running ? {} : { remediation: provision },
  );
  return [tokenCheck, timerCheck];
}

/** Under-voltage: a failure while it happens, a warning when it happened since boot. */
function powerCheck(facts: HostFacts): CheckResult[] {
  const power = facts.power;
  if (power === null || power === undefined) return [];
  const title = "The power supply keeps up (no under-voltage)";
  const supply =
    "Use a power supply made for your board (for a Raspberry Pi, its official one) and a short, thick cable; under-voltage can corrupt the storage.";
  if (power.underVoltageNow) {
    return [
      checkResult("pi-power", title, "high", "fail", "Your server reports under-voltage now.", {
        remediation: supply,
      }),
    ];
  }
  if (power.underVoltageSinceBoot) {
    return [
      checkResult(
        "pi-power",
        title,
        "medium",
        "warn",
        "Your server reported under-voltage since it started.",
        { remediation: supply },
      ),
    ];
  }
  return [
    checkResult("pi-power", title, "info", "pass", "No under-voltage since your server started."),
  ];
}

/**
 * The server-side checks of a server at home from its inspection (`facts`): OpsCrew's SSH table
 * and its sources against `home.sshFrom`, the web filter's families, with the DNS on Cloudflare the
 * updater's token file and timer, and the power supply.
 */
export function homeServerChecks(
  plan: DeployPlan,
  facts: HostFacts,
  home: OwnHome,
  flags = "",
): CheckResult[] {
  return [
    sshTableCheck(facts, home, flags),
    ...webFilterChecks(plan, facts, flags),
    ...(plan.dns.provider === "cloudflare"
      ? updaterChecks(
          facts.dnsUpdaters?.find((item) => item.app === plan.app.name),
          flags,
        )
      : []),
    ...powerCheck(facts),
  ];
}

/** Why nothing on a server at home was checked over SSH from this computer. */
export const NOT_CHECKED_AWAY = `${upperFirst(AWAY_FROM_HOME)}, so it wasn't checked over SSH from here.`;

/**
 * `check` skipped away from home ({@link NOT_CHECKED_AWAY}), with what to do: run secure at home.
 */
export function awayFromHome(
  check: Pick<CheckResult, "id" | "title" | "severity">,
  flags: string,
): CheckResult {
  return checkResult(check.id, check.title, check.severity, "skip", NOT_CHECKED_AWAY, {
    remediation: `Run \`opscrew secure${flags}\` from your home network.`,
  });
}

/**
 * The server-side checks of a server at home from `read`: {@link homeServerChecks}, or away from
 * home one `skip` saying so, or one failed check with the reason it couldn't be read.
 */
export function homeSecurityChecks(
  plan: DeployPlan,
  home: OwnHome,
  read: HomeServerRead,
  flags: string,
): CheckResult[] {
  const check = {
    id: "home-server-checks",
    title: "OpsCrew can check your server at home",
    severity: "medium" as const,
  };
  if ("away" in read) return [awayFromHome(check, flags)];
  if ("unread" in read) {
    return [checkResult(check.id, check.title, check.severity, "fail", errorText(read.unread))];
  }
  return homeServerChecks(plan, read.facts, home, flags);
}

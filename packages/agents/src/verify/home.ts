/**
 * `opscrew verify` for a server at home (plan 13., research R7, R10, R11): the outside check from
 * GitHub's machines, the address updater's state and the Raspberry Pi's power read over SSH, and,
 * with DNS only, the records against the address the server detects. Away from home SSH doesn't
 * answer: the server-side checks are skipped with that reason, and the outside check still runs.
 * No request from this computer ever counts as the outside check, and a proxied app's address is
 * never in a line.
 */
import type { GitHubClient } from "@opscrew/connector-github";
import {
  agreedIpv4,
  type DnsUpdaterFact,
  type HomeNetwork,
  type HostFacts,
} from "@opscrew/connector-ssh-host";
import type { CheckResult } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import type { HomeForwardsInput } from "../home/forwards";
import { type OutsideCheckResult, outsideCheckLines, runOutsideCheck } from "../home/outside-check";
import type { OwnServerServices } from "../provision/types";
import { checkResult } from "../shared";
import { codeOf } from "../shared/errors";
import { boundHostAdapter } from "../shared/host-plan";
import { connectOwnServer, inspectOwnHost, readOwnServerRecord } from "../shared/own-server";
import { errorText } from "./checks";
import type { DnsResolver } from "./net";

/** Why the server-side checks are skipped away from home (research R11). */
export const AWAY_FROM_HOME = "your server answers SSH only on your home network";

const AWAY_SKIP = `Skipped: ${AWAY_FROM_HOME}, and OpsCrew couldn't reach it from here.`;

/** The updater's last success may be at most this old (two missed runs and then some). */
const UPDATER_FRESH_MS = 10 * 60_000;

const UPDATER_ERROR_CODES = [
  "address-unknown",
  "sources-disagree",
  "token-refused",
  "rate-limited",
  "cloudflare-unreachable",
  "cloudflare-error",
  "foreign-record",
  "cname-at-name",
  "config-invalid",
] as const;
type UpdaterErrorCode = (typeof UPDATER_ERROR_CODES)[number];

const FamiliesSchema = z.object({
  ipv4: z.string().nullable().optional(),
  ipv6: z.string().nullable().optional(),
});

/** The updater's `state.json` (data model 5), as inspection's `dnsUpdaters` carries it. */
const UpdaterStateSchema = z.object({
  schemaVersion: z.literal(1),
  lastRun: z.iso.datetime(),
  lastSuccess: z.iso.datetime().optional(),
  seen: FamiliesSchema,
  records: FamiliesSchema.optional(),
  lastError: z.object({ at: z.iso.datetime(), code: z.enum(UPDATER_ERROR_CODES) }).optional(),
});

/** `2026-11-20 10:04 UTC` from an ISO timestamp. */
function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** What each error code means, and what to do next (data model 5). */
function updaterError(
  code: UpdaterErrorCode,
  plan: DeployPlan,
  flag: string,
): { said: string; next: string } {
  const zone = plan.dns.zone ?? plan.dns.domain ?? "the zone";
  const words: Record<UpdaterErrorCode, { said: string; next: string }> = {
    "address-unknown": {
      said: "no outside source told your server its public address",
      next: "Check that your server can make outgoing HTTPS connections.",
    },
    "sources-disagree": {
      said: "the two address sources gave different addresses",
      next: "Wait for the next run: a router with two internet connections can cause it.",
    },
    "token-refused": {
      said: "Cloudflare refused the updater's token",
      next: `Make a new token with only Zone → DNS → Edit on ${zone} (https://dash.cloudflare.com/profile/api-tokens), set OPSCREW_DNS_UPDATER_TOKEN to it, and run \`opscrew rotate dns-updater${flag}\`.`,
    },
    "rate-limited": {
      said: "Cloudflare limited the requests for a while",
      next: "Nothing to do: the updater retries on its next run.",
    },
    "cloudflare-unreachable": {
      said: "your server couldn't reach Cloudflare's API",
      next: "Check your server's internet connection.",
    },
    "cloudflare-error": {
      said: "Cloudflare's API answered with an error",
      next: `Run \`opscrew verify${flag}\` again in a few minutes; report it if it stays.`,
    },
    "foreign-record": {
      said: `an A or AAAA record OpsCrew's updater didn't create holds ${plan.dns.domain ?? "the name"}`,
      next: "Remove that record in Cloudflare's dashboard: the updater then writes its own.",
    },
    "cname-at-name": {
      said: `a CNAME record holds ${plan.dns.domain ?? "the name"}`,
      next: `Finish the switch with \`opscrew provision${flag}\`.`,
    },
    "config-invalid": {
      said: "its config or its token on your server isn't valid",
      next: `Run \`opscrew provision${flag}\`: it writes them again.`,
    },
  };
  return words[code];
}

/**
 * The address updater of this app (inspection's `dnsUpdaters`, its state validated here): a
 * failure when its last success is older than 10 minutes or its records don't hold what the server
 * sees, a warning when a run failed since its last success. Names no address.
 */
export function dnsUpdaterCheck(
  plan: DeployPlan,
  updaters: readonly DnsUpdaterFact[] | undefined,
  now: Date,
  flag: string,
): CheckResult {
  const id = "dns-updater";
  const title = "The address updater keeps the app's records current";
  const fact = updaters?.find((item) => item.app === plan.app.name);
  const provision = `Run \`opscrew provision${flag}\`: it sets the updater up.`;
  if (fact === undefined) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      "Your server has no address updater for this app.",
      {
        remediation: provision,
      },
    );
  }
  const parsed = UpdaterStateSchema.safeParse(fact.state);
  if (!parsed.success) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      "The address updater on your server hasn't recorded a run yet.",
      {
        remediation: `Check its timer on your server (\`systemctl status opscrew-dns-updater@${plan.app.name}.timer\`). ${provision}`,
      },
    );
  }
  const state = parsed.data;
  const { lastSuccess, lastError } = state;
  const failedSince =
    lastError !== undefined &&
    (lastSuccess === undefined || Date.parse(lastError.at) > Date.parse(lastSuccess))
      ? { at: lastError.at, ...updaterError(lastError.code, plan, flag) }
      : undefined;
  const failure = failedSince
    ? ` Its last error (${utc(failedSince.at)}): ${failedSince.said}.`
    : "";
  if (lastSuccess === undefined || now.getTime() - Date.parse(lastSuccess) > UPDATER_FRESH_MS) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `${
        lastSuccess === undefined
          ? "The address updater hasn't succeeded yet."
          : `The address updater last succeeded at ${utc(lastSuccess)}, more than 10 minutes ago.`
      }${failure}`,
      {
        remediation:
          failedSince?.next ??
          `Check its timer on your server (\`systemctl status opscrew-dns-updater@${plan.app.name}.timer\`). ${provision}`,
      },
    );
  }
  // Only a family it keeps and saw an address for: an address it couldn't read changes nothing.
  const keeps = { ipv4: fact.config?.ipv4 ?? true, ipv6: fact.config?.ipv6 ?? true };
  const differ = (["ipv4", "ipv6"] as const).some((family) => {
    const seen = state.seen[family];
    return keeps[family] && seen != null && state.records?.[family] !== seen;
  });
  if (differ) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `The app's records don't hold the address your server sees.${failure}`,
      {
        remediation:
          failedSince?.next ??
          `The updater writes them on its next run (every 2 minutes): run \`opscrew verify${flag}\` again in a few minutes.`,
      },
    );
  }
  if (failedSince !== undefined) {
    return checkResult(
      id,
      title,
      "high",
      "warn",
      `The address updater's last run failed at ${utc(failedSince.at)}: ${failedSince.said}. It last succeeded at ${utc(lastSuccess)}.`,
      { remediation: failedSince.next },
    );
  }
  return checkResult(
    id,
    title,
    "high",
    "pass",
    `The address updater last succeeded at ${utc(lastSuccess)}, and the records hold the address your server sees.`,
  );
}

/** The supply a Raspberry Pi needs (research §9), by its board's name. */
function piSupply(board: string): string {
  if (/raspberry pi 5/i.test(board)) return "a 5 V / 5 A supply";
  if (/raspberry pi 4/i.test(board)) return "a 5 V / 3 A supply";
  return "the supply Raspberry Pi names for this board";
}

/**
 * A Raspberry Pi's power (inspection's `power`): a failure when it's under-voltage now, a warning
 * when it was since boot, naming the supply it needs. None for another board.
 */
export function piPowerCheck(facts: Pick<HostFacts, "board" | "power">): CheckResult | undefined {
  const board = facts.board ?? "";
  if (!/raspberry pi/i.test(board)) return undefined;
  const id = "pi-power";
  const title = "Your Raspberry Pi gets enough power";
  const fix = `Use ${piSupply(board)} and a short, good USB-C cable: under-voltage slows the Pi down and can corrupt its storage.`;
  if (facts.power == null) {
    return checkResult(
      id,
      title,
      "medium",
      "skip",
      "Skipped: OpsCrew couldn't read the power state on your server (vcgencmd or this boot's kernel log).",
    );
  }
  if (facts.power.underVoltageNow) {
    return checkResult(
      id,
      title,
      "medium",
      "fail",
      "Your Raspberry Pi is short of power now (under-voltage).",
      {
        remediation: fix,
      },
    );
  }
  if (facts.power.underVoltageSinceBoot) {
    return checkResult(
      id,
      title,
      "medium",
      "warn",
      "Your Raspberry Pi was short of power since it started (under-voltage), though not now.",
      { remediation: fix },
    );
  }
  return checkResult(
    id,
    title,
    "medium",
    "pass",
    "No under-voltage since your Raspberry Pi started.",
  );
}

/**
 * A DNS-only home app's records against the address the server detects (`network`; none away from
 * home): every A at the home's public IPv4, every AAAA at its stable IPv6 address, and at least one
 * record of the family the site is served on. A DNS-only app's addresses are public in DNS.
 */
export async function homeDnsCheck(
  host: string,
  plan: DeployPlan,
  resolver: DnsResolver,
  network: HomeNetwork | undefined,
): Promise<CheckResult> {
  const id = host.startsWith("www.") ? "dns-records-www" : "dns-records";
  const title = `DNS for ${host} points to the right place`;
  if (network === undefined) {
    return checkResult(
      id,
      title,
      "high",
      "skip",
      `Skipped: ${AWAY_FROM_HOME}, so OpsCrew couldn't read your home's address from it to compare.`,
      {
        target: host,
      },
    );
  }
  const ipv4 = plan.target.provider === "own" && plan.target.home?.ipv4 === true;
  const expected4 = ipv4 ? agreedIpv4(network.ipv4) : undefined;
  const expected6 = network.ipv6.stable;
  if (ipv4 && expected4 === undefined) {
    return checkResult(
      id,
      title,
      "high",
      "warn",
      `Your server couldn't see its public IPv4 address, so OpsCrew can't tell whether ${host} points to it.`,
      {
        remediation:
          "Check that your server can make outgoing HTTPS connections, then run verify again.",
        target: host,
      },
    );
  }
  const expected = [expected4, expected6].filter((address) => address !== undefined);
  const fix =
    plan.dns.provider === "cloudflare"
      ? "The address updater writes them: see its check."
      : `At your DNS provider, point ${host} at your home's address (${expected.join(", ")}).`;
  let a: string[];
  let aaaa: string[];
  try {
    [a, aaaa] = await Promise.all([resolver.resolve4(host), resolver.resolve6(host)]);
  } catch (error) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      `Could not look up ${host}: ${errorText(error)}.`,
      {
        remediation: fix,
        target: host,
      },
    );
  }
  const wrong = [
    ...a.filter((address) => address !== expected4),
    ...aaaa.filter((address) => address !== expected6),
  ];
  const missing = ipv4 ? a.length === 0 : aaaa.length === 0;
  if (wrong.length > 0 || missing) {
    return checkResult(
      id,
      title,
      "high",
      "fail",
      a.length + aaaa.length === 0
        ? `${host} has no A or AAAA record.`
        : `${host} resolves to ${[...a, ...aaaa].join(", ")}, but your home's address is ${expected.join(", ")}.`,
      { remediation: fix, target: host },
    );
  }
  return checkResult(
    id,
    title,
    "high",
    "pass",
    `${host} resolves to your home's address (${[...a, ...aaaa].join(", ")}).`,
    { target: host },
  );
}

/** The requests to the site from this computer that hairpin NAT can fail. */
const SITE_REQUESTS = new Set([
  "site-reachable",
  "tls-certificate",
  "http-redirect",
  "health-endpoint",
]);

/**
 * A DNS-only home app this computer can't reach while the outside check passed on 443: the site
 * requests' failures become warnings, since from inside the home a request to its own public
 * address can fail (hairpin NAT).
 */
export function hairpinWarnings(checks: readonly CheckResult[]): CheckResult[] {
  return checks.map((check) =>
    SITE_REQUESTS.has(check.id) && check.status === "fail"
      ? {
          ...check,
          status: "warn",
          message: `${check.message} From inside your home network a request to your home's own address can fail (hairpin NAT), and the check from outside your home passed, so this is a warning.`,
        }
      : check,
  );
}

/** What the outside check reports: its result, or a skip without one. */
async function outsideCheck(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: Pick<HomeChecksInput, "github" | "resolver">,
  forwards: HomeForwardsInput,
): Promise<{ check: CheckResult; result?: OutsideCheckResult }> {
  const id = "outside-check";
  const title = "Your app answers from outside your home";
  const host = plan.dns.domain;
  const skip = (message: string, remediation?: string) => ({
    check: checkResult(id, title, "high", "skip", message, {
      ...(remediation !== undefined ? { remediation } : {}),
      ...(host !== undefined ? { target: host } : {}),
    }),
  });
  if (host === undefined) return skip("Skipped: the app has no domain.");
  const found = await Promise.all([
    input.resolver.resolve4(host).catch(() => []),
    input.resolver.resolve6(host).catch(() => []),
  ]);
  if (found.flat().length === 0) {
    return skip(`Skipped: ${host} has no A or AAAA record yet, so there is nothing to reach.`);
  }
  const { client, repo } = input.github;
  if (client === undefined || repo === undefined) {
    return skip(
      "Skipped: the check runs on GitHub's machines, and no GitHub token is available (set GITHUB_TOKEN or run `gh auth login`).",
    );
  }
  let result: OutsideCheckResult;
  try {
    const { defaultBranch } = await client.getRepo(repo.owner, repo.repo);
    result = await runOutsideCheck(
      deps,
      { api: client, owner: repo.owner, repo: repo.repo, defaultBranch },
      {
        host,
        path: plan.app.healthPath,
        mode: plan.dns.provider === "cloudflare" && plan.dns.proxied ? "proxied" : "direct",
      },
    );
  } catch (error) {
    const code = codeOf(error);
    if (
      isUserFacingError(error) &&
      (code === "PHASE_PRECONDITION" || code.startsWith("CREDENTIALS_"))
    ) {
      return skip(`Skipped: ${error.message}`, error.hint);
    }
    throw error;
  }
  const ports = [result.http, result.https];
  const status = ports.includes("failed")
    ? "fail"
    : ports.every((port) => port === "ok")
      ? "pass"
      : "warn";
  return {
    check: checkResult(id, title, "high", status, outsideCheckLines(result, forwards).join(" "), {
      target: host,
    }),
    result,
  };
}

/** What {@link homeChecks} needs beside the phase. */
export interface HomeChecksInput {
  /** The checks `runVerifyChecks` made, which this edits. */
  checks: readonly CheckResult[];
  /** This computer couldn't reach the site at all (`runVerifyChecks`'s `siteUnreachable`). */
  siteUnreachable: boolean;
  resolver: DnsResolver;
  /** The repository the outside check runs in, and a client when a token is available. */
  github: { client?: GitHubClient; repo?: { owner: string; repo: string } };
  /** The admin login's shell and the host adapter (fakes in tests). */
  services?: Pick<OwnServerServices, "remote" | "homeDir" | "host"> | undefined;
  /** ` --env <name>` for the commands the checks name. */
  flag: string;
}

/**
 * The checks of a server at home (plan 13.): with SSH, inspection's updater state (`dns-updater`,
 * with DNS on Cloudflare) and power (`pi-power`, on a Raspberry Pi), and for a DNS-only app its
 * records against the address the server detects; away from home those are skipped with
 * {@link AWAY_FROM_HOME}. Then `outside-check`, from GitHub's machines. A DNS-only app this computer
 * can't reach while port 443 answered from outside gets warnings for its site requests.
 */
export async function homeChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: HomeChecksInput,
): Promise<CheckResult[]> {
  const proxied = plan.dns.provider === "cloudflare" && plan.dns.proxied;
  const target = plan.target.provider === "own" ? plan.target : undefined;
  const record = (await readOwnServerRecord(deps.paths))?.home;
  const server = await readServer(deps, { dnsOnly: !proxied, services: input.services });
  if (server === undefined) {
    deps.reporter.info(
      "Your server answers SSH only on your home network, so the updater's state and the power supply weren't checked (skipped). The outside check runs from GitHub's machines.",
    );
  }
  let checks = [...input.checks];
  if (!proxied) {
    checks = await Promise.all(
      checks.map((check) =>
        check.id === "dns-records" || check.id === "dns-records-www"
          ? homeDnsCheck(check.target ?? "", plan, input.resolver, server?.network)
          : check,
      ),
    );
  }
  if (plan.dns.provider === "cloudflare") {
    checks.push(
      server === undefined
        ? checkResult(
            "dns-updater",
            "The address updater keeps the app's records current",
            "high",
            "skip",
            AWAY_SKIP,
          )
        : dnsUpdaterCheck(plan, server.facts.dnsUpdaters, deps.clock.now(), input.flag),
    );
  }
  // Away from home the board is unknown: only an arm64 server can be a Raspberry Pi.
  const power =
    server === undefined
      ? target?.arch === "arm64"
        ? checkResult(
            "pi-power",
            "Your Raspberry Pi gets enough power",
            "medium",
            "skip",
            AWAY_SKIP,
          )
        : undefined
      : piPowerCheck(server.facts);
  if (power !== undefined) checks.push(power);

  const ipv4 = target?.home?.ipv4 === true;
  const network = record?.network;
  const forwards: HomeForwardsInput = {
    ...(network?.lan !== undefined && !network.noNat ? { lanAddress: network.lan.address } : {}),
    ipv4,
    noNat: network?.noNat ?? false,
    // An AAAA record is published behind the proxy without IPv4, and with DNS only while there is IPv6.
    aaaa: proxied ? !ipv4 : network?.ipv6 === "present",
    ...(record?.sshFrom !== undefined ? { sshFrom: record.sshFrom } : {}),
  };
  const outside = await outsideCheck(deps, plan, input, forwards);
  checks.push(outside.check);
  return !proxied && outside.result?.https === "ok" && input.siteUnreachable
    ? hairpinWarnings(checks)
    : checks;
}

/**
 * Inspects the server at home over SSH, read-only, and with DNS only reads its home network for
 * the detected address; `undefined` when SSH doesn't answer (away from home).
 */
async function readServer(
  deps: PhaseDeps,
  options: {
    dnsOnly: boolean;
    services: Pick<OwnServerServices, "remote" | "homeDir" | "host"> | undefined;
  },
): Promise<{ facts: HostFacts; network?: HomeNetwork } | undefined> {
  deps.reporter.step("Connecting to your server");
  let session: Awaited<ReturnType<typeof connectOwnServer>>;
  try {
    session = await connectOwnServer(deps, { services: options.services });
  } catch (error) {
    // ssh couldn't reach it (testLogin's and the key scan's COMMAND_FAILED): not on its network.
    if (error instanceof OpsCrewError && error.code === "COMMAND_FAILED") return undefined;
    throw error;
  }
  const facts = await inspectOwnHost(deps, session, {
    services: options.services,
    phase: "verify",
    detail: "the address updater and the power supply",
  });
  if (!options.dnsOnly) return { facts };
  deps.reporter.step("Reading your home network from your server (read-only)");
  const network = await boundHostAdapter(options.services?.host).detectHomeNetwork(session.remote);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "detect home network (read-only)",
    phase: "verify",
    target: "own server",
    decision: "allow",
  });
  return { facts, network };
}

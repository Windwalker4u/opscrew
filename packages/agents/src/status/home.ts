/**
 * `opscrew status` for a server at home (plan 13., research R11, SC-2905): SSH's sources, this
 * app's address updater as the server's inspection read it (`dnsUpdaters`), and the last check
 * from outside the home (`own.home.outsideCheck`). Away from home, where SSH doesn't answer, the
 * last outside check from this computer's record. A proxied app's addresses are never shown: the
 * updater's line says "hidden: behind Cloudflare's proxy", and the addresses it read are
 * registered with the redactor as names. Read-only.
 */
import {
  type DnsUpdaterError,
  type DnsUpdaterState,
  DnsUpdaterStateSchema,
  type HostFacts,
} from "@opscrew/connector-ssh-host";
import { isUserFacingError, upperFirst } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { HOME_ADDRESS_LABEL } from "../home/network";
import { AWAY_FROM_HOME, type HomeServerRead, readHomeServer as readHome } from "../home/server";
import { UPDATER_TOKEN_VAR } from "../home/token";
import type { OwnServerServices } from "../provision/types";
import type { OwnHome } from "../shared/server-record";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `iso` in UTC as `20 Nov 10:30 UTC`, or `10:30 UTC` when it is on the same UTC day as `now`.
 */
export function utcText(iso: string, now?: Date): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
  const day = (date: Date) => date.toISOString().slice(0, 10);
  if (now !== undefined && day(at) === day(now)) return time;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${time}`;
}

/** A rule of OpsCrew's SSH table as `nft_table` prints it: SSH from one source. */
const ACCEPT_RULE = /^ip6? saddr (\S+) tcp dport \d+ accept$/;

/** The sources OpsCrew's SSH table (`sshFirewall.table`) lets SSH in from, in its order. */
export function sshTableSources(table: string): string[] {
  const sources = table.split("|").flatMap((line) => {
    const source = ACCEPT_RULE.exec(line.trim())?.[1];
    return source === undefined ? [] : [source];
  });
  return [...new Set(sources)];
}

/** What the server's last outside check found (`own.home.outsideCheck`). */
type OutsideCheck = NonNullable<OwnHome["outsideCheck"]>;

/**
 * The outside check in short, `20 Nov 10:30 UTC: 443 ok; 80: Cloudflare answered`, with the run's
 * link when a port failed or the check didn't finish.
 */
export function outsideCheckText(check: OutsideCheck, now?: Date): string {
  const port = (n: 80 | 443, result: OutsideCheck["https"]) => {
    if (result === "ok") {
      return n === 80 && check.mode === "proxied" ? "80: Cloudflare answered" : `${n} ok`;
    }
    if (result === "failed") return `${n} didn't answer`;
    if (result === "unfinished") return `${n} didn't finish`;
    return `${n} not checked`;
  };
  const link =
    check.http === "failed" ||
    check.https === "failed" ||
    check.http === "unfinished" ||
    check.https === "unfinished"
      ? ` (${check.runUrl})`
      : "";
  return `${utcText(check.at, now)}: ${port(443, check.https)}; ${port(80, check.http)}${link}`;
}

/** What the updater's last error means, with the next step (data model 5's table). */
function errorWords(error: NonNullable<DnsUpdaterState["lastError"]>, name: string, flags: string) {
  const said: Record<DnsUpdaterError, string> = {
    "address-unknown":
      "neither outside source told your server its address: check that the server can reach the internet over HTTPS",
    "sources-disagree":
      "the two outside sources gave different addresses: wait a few minutes (a router with two connections can cause it)",
    "token-refused": `Cloudflare refused the updater's token: make a new token as the guide says, set \`${UPDATER_TOKEN_VAR}\`, and run \`opscrew rotate dns-updater${flags}\``,
    "rate-limited": "Cloudflare limited the requests for a while (retried)",
    "cloudflare-unreachable": "Cloudflare didn't answer: check your server's internet connection",
    "cloudflare-error": `Cloudflare answered with an error${error.http === undefined ? "" : ` (HTTP ${error.http}${error.cloudflare?.length ? `, code ${error.cloudflare.join(", ")}` : ""})`}: run \`opscrew verify${flags}\` again, and report it if it stays`,
    "foreign-record": `an A or AAAA record OpsCrew didn't make holds ${name}: remove that record at Cloudflare`,
    "cname-at-name": `a CNAME record holds ${name}: finish the mode switch with \`opscrew provision${flags}\``,
    "config-invalid": `the updater's config on your server failed its checks: run \`opscrew provision${flags}\``,
  };
  return said[error.code];
}

/** What the last write changed: `A changed`, `AAAA removed`, `created`. */
const CHANGED: Record<NonNullable<DnsUpdaterState["lastWrite"]>["changed"][number], string> = {
  A: "A changed",
  AAAA: "AAAA changed",
  "A-deleted": "A removed",
  "AAAA-deleted": "AAAA removed",
  created: "created",
};

/** A line of the section: its label in a column of 13, then the text. */
const row = (label: string, text: string) => `${label.padEnd(13)}${text}`;

/** What the updater sees: addresses with DNS only, "hidden" behind the proxy. */
function seesText(seen: DnsUpdaterState["seen"], proxied: boolean): string {
  if (!proxied) {
    return [
      seen.ipv4 === null ? "no IPv4" : `IPv4 ${seen.ipv4}`,
      seen.ipv6 === null ? "no IPv6" : `IPv6 ${seen.ipv6}`,
    ].join(", ");
  }
  const present = (["IPv4", "IPv6"] as const).filter(
    (family) => seen[family === "IPv4" ? "ipv4" : "ipv6"] !== null,
  );
  const absent = (["IPv4", "IPv6"] as const).filter((family) => !present.includes(family));
  return [
    ...(present.length > 0 ? [`${present.join(" and ")} (hidden: behind Cloudflare's proxy)`] : []),
    ...absent.map((family) => `no ${family}`),
  ].join(", ");
}

/** The updater's lines: its timer, last run, what it sees, the records, last write and error. */
function updaterLines(
  plan: DeployPlan,
  facts: HostFacts,
  options: { now: Date; flags: string },
): string[] {
  const { now, flags } = options;
  const name = plan.dns.domain ?? "";
  const updater = facts.dnsUpdaters?.find((item) => item.app === plan.app.name);
  if (updater === undefined) {
    return [row("Updater", `not on your server: \`opscrew provision${flags}\` sets it up`)];
  }
  const timer =
    updater.timer.enabled && updater.timer.active
      ? "every 2 minutes"
      : `stopped: its timer isn't running (\`opscrew provision${flags}\` starts it again)`;
  if (updater.state === null) return [row("Updater", `${timer} · no run yet`)];
  const parsed = DnsUpdaterStateSchema.safeParse(updater.state);
  if (!parsed.success) {
    return [
      row(
        "Updater",
        `${timer} · its state on your server can't be read: run \`opscrew provision${flags}\``,
      ),
    ];
  }
  const state = parsed.data;
  const ok = state.lastSuccess === state.lastRun;
  const kept = {
    ipv4: updater.config?.ipv4 ?? true,
    ipv6: updater.config?.ipv6 ?? true,
  };
  const differ = (["ipv4", "ipv6"] as const)
    .filter((family) => kept[family] && state.records[family] !== state.seen[family])
    .map((family) => (family === "ipv4" ? "A" : "AAAA"));
  const proxied = updater.config?.proxied ?? plan.dns.proxied;
  return [
    row("Updater", `${timer} · last run ${utcText(state.lastRun, now)}, ${ok ? "ok" : "failed"}`),
    row("  sees", seesText(state.seen, proxied)),
    row(
      "  records",
      differ.length === 0
        ? "match"
        : `differ from what your server sees (${differ.join(" and ")}): the next run puts them right`,
    ),
    ...(state.lastWrite === undefined
      ? []
      : [
          row(
            "  last write",
            `${utcText(state.lastWrite.at, now)} (${state.lastWrite.changed.map((c) => CHANGED[c]).join(", ")})`,
          ),
        ]),
    ...(state.lastError === undefined
      ? []
      : [
          row(
            "  last error",
            `${utcText(state.lastError.at, now)}: ${errorWords(state.lastError, name, flags)}`,
          ),
        ]),
  ];
}

/** How the server at home was read for `status`: an unread one's reason the components' section says. */
export type HomeRead = HomeServerRead;

/** The section's input: the plan, the local record's `own.home`, the read, the time, the flags. */
export interface HomeStatusInput {
  plan: DeployPlan;
  home: OwnHome | undefined;
  read: HomeRead;
  now: Date;
  /** The app's and environment's command flags (`commandFlags`). */
  flags: string;
}

/**
 * The status lines of a server at home: SSH's sources (from OpsCrew's SSH table on the server
 * when it was read, else from this computer's record), with the DNS on Cloudflare the updater
 * of this app (its timer, last run, what it sees, whether the records match, its last write and
 * last error with the next step), then the last outside check. Away from home, one line: SSH
 * answers only on the home network, and the last outside check.
 */
export function homeStatusLines(input: HomeStatusInput): string[] {
  const { plan, home, read, now, flags } = input;
  const check = home?.outsideCheck;
  const updater = plan.dns.provider === "cloudflare";
  if ("away" in read) {
    const last =
      check === undefined
        ? `No check from outside your home yet: \`opscrew verify${flags}\` runs it.`
        : `Last outside check: ${outsideCheckText(check, now)}.`;
    return [
      `${upperFirst(AWAY_FROM_HOME)}, so ${updater ? "its updater" : "it"} can't be read from here. ${last}`,
    ];
  }
  const facts = "facts" in read ? read.facts : undefined;
  const sources =
    facts === undefined
      ? home?.sshFrom
      : facts.sshFirewall.table === null
        ? undefined
        : sshTableSources(facts.sshFirewall.table);
  const ssh =
    sources !== undefined
      ? [row("SSH", `only from your home network (${sources.join(", ")})`)]
      : facts !== undefined
        ? [
            row(
              "SSH",
              `not limited on your server: OpsCrew's SSH table is missing (\`opscrew drift${flags}\` shows it, \`opscrew provision${flags}\` puts it back)`,
            ),
          ]
        : [];
  return [
    ...ssh,
    ...(updater && facts !== undefined ? updaterLines(plan, facts, { now, flags }) : []),
    row(
      "Outside",
      check === undefined
        ? `not checked yet: \`opscrew verify${flags}\` checks from GitHub's machines`
        : `checked ${outsideCheckText(check, now)}`,
    ),
  ];
}

/**
 * Behind Cloudflare's proxy, the addresses this app's updater read on the server are registered
 * with the redactor as names, so no line, note or reply can show them.
 */
export function hideHomeAddresses(
  deps: Pick<PhaseDeps, "redactor">,
  plan: DeployPlan,
  facts: HostFacts,
) {
  if (!plan.dns.proxied) return;
  const state = DnsUpdaterStateSchema.safeParse(
    facts.dnsUpdaters?.find((item) => item.app === plan.app.name)?.state,
  );
  if (!state.success) return;
  const { seen, records } = state.data;
  for (const address of [seen.ipv4, seen.ipv6, records.ipv4, records.ipv6]) {
    if (address !== null) deps.redactor.addName(address, HOME_ADDRESS_LABEL);
  }
}

/**
 * Reads the server at home once for `status` (read-only): `check` first (the MCP server's host
 * key check, a failure of which is `unread`), then `readHomeServer` with the pinned host key.
 */
export async function readHomeServer(
  deps: PhaseDeps,
  options: {
    hostKey?: string | undefined;
    services?: Pick<OwnServerServices, "remote" | "homeDir" | "host"> | undefined;
    check?: (() => Promise<void>) | undefined;
  },
): Promise<HomeRead> {
  try {
    await options.check?.();
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { unread: error };
  }
  return readHome(deps, {
    hostKey: options.hostKey,
    services: options.services,
    detail: "the app's components and the address updater",
  });
}

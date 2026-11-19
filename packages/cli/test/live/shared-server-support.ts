/**
 * Pure helpers of feature 030's live pass L1 (`shared-server.test.ts`, docs/e2e.md "A second app
 * on a server OpsCrew created"): its variables, the run's own names (never `e2e-`, which 029's
 * passes use), `deploy`'s `authorized_keys` compared by the SHA-256 of each line, the first app's
 * refusals, what "nothing changed" compares, the load's summary and the addresses in the second
 * app's outputs. No network, no processes; unit-tested in `shared-server-support.test.ts`.
 */
import { sha256Hex } from "@opscrew/core";
import { type LoadFailure, leakedLabels, runHostname } from "./support";
import type { ZoneRecord } from "./tls-support";

/** The pass's gate. */
export const SHARED_SERVER_GATE = "OPSCREW_E2E_SHARED_SERVER";

/** Its variables besides the gate: both apps live in the public throwaway repository C. */
export const SHARED_SERVER_VARIABLES = [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO_C",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** The first app's example (seeded as in the previews passes) and its folder in the repository. */
export const FIRST_EXAMPLE = "koa-knex";
/** The second app's example, a further app of the same repository, and its folder. */
export const SECOND_EXAMPLE = "express-api";

/** The start of every name the pass gives: its feature, never `e2e-`. */
export const NAME_PREFIX = "j030";

/** The Hetzner type the first app's server gets (the cheapest x86 one with 4 GB). */
export const SERVER_TYPE = "cx23";

/** The load on the first app's site while the second app comes and goes (SC-3002). */
export const REQUESTS_PER_SECOND = 1;

/** The run's own app names. */
export interface SharedNames {
  /** The run's tag in every name: the random part of its id. */
  tag: string;
  /** The first app's name (its project name, as design names the app after it). */
  firstApp: string;
  /** The second app's key, which is its name too (`opscrew app add <key>`). */
  secondApp: string;
}

/**
 * The run's app names, `j030-<tag>-a` and `j030-<tag>-b` (an app key has at most 16 characters),
 * `tag` being the last 8 letters and digits of `runId` (its random part).
 */
export function sharedNames(runId: string): SharedNames {
  const tag = runId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-8);
  if (tag.length < 8) throw new Error(`The run id "${runId}" is too short for the pass's names.`);
  return { tag, firstApp: `${NAME_PREFIX}-${tag}-a`, secondApp: `${NAME_PREFIX}-${tag}-b` };
}

/**
 * The run's hostnames, `j030-<tag>-first.<zone>` and `j030-<tag>-second.<zone>`: one level below
 * the zone of `domain` as `runHostname` finds it, so Cloudflare's free edge certificate covers
 * them, but never under `runHostname`'s `e2e-`.
 */
export function sharedHosts(
  domain: string,
  tag: string,
): { firstHost: string; secondHost: string } {
  const zone = runHostname(domain, tag).split(".").slice(1).join(".");
  return {
    firstHost: `${NAME_PREFIX}-${tag}-first.${zone}`,
    secondHost: `${NAME_PREFIX}-${tag}-second.${zone}`,
  };
}

/**
 * The SHA-256 of each line of an `authorized_keys` file, in order (SC-3003): never a line itself.
 * The newline that ends the file starts no line of its own.
 */
export function keyLineDigests(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => sha256Hex(line));
}

/**
 * Whether `output` is a first-app command's refusal while the second app `app` is on its server
 * (FR-3012): it names the app in quotes and says nothing was changed. Only these stable parts are
 * matched, not the sentence around them.
 */
export function otherAppRefused(output: string, app: string): boolean {
  return output.includes(`"${app}"`) && output.includes("Nothing was changed.");
}

/** The non-empty lines of `text`, trimmed and sorted, one per line. */
export function sortedLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort()
    .join("\n");
}

/**
 * The DNS records on `hostnames` (each, and its `www.`), by type, name, content and proxy, sorted:
 * what the first app's refused commands must leave as it was.
 */
export function dnsFacts(records: readonly ZoneRecord[], hostnames: readonly string[]): string {
  const names = new Set(hostnames.flatMap((host) => [host, `www.${host}`]));
  return records
    .filter((record) => names.has(record.name))
    .map((record) =>
      JSON.stringify([record.type, record.name, record.content ?? "", record.proxied === true]),
    )
    .sort()
    .join("\n");
}

/**
 * The SHA-256 of each part of what a refused command must leave as it was, by the part's name, so
 * a difference names the part and never shows its text (which may hold an address).
 */
export function factDigests(parts: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, sha256Hex(text)]));
}

/** What a load on the first app's site saw. */
export interface LoadOutcome {
  sent: number;
  seconds: number;
  /** Answers by HTTP status. */
  statuses: Readonly<Record<string, number>>;
  /** Failed requests that count. */
  counted: readonly LoadFailure[];
  /** Failed requests accepted (Cloudflare's brief 52x answers while an origin pull rolls out). */
  accepted: number;
}

/**
 * The load's figures in one line, without a host: `<what>: 600 requests in 600 s to the first
 * app's site, HTTP 200 ×600; none failed`.
 */
export function loadSummary(what: string, outcome: LoadOutcome): string {
  const statuses = Object.entries(outcome.statuses)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `HTTP ${status} ×${count}`)
    .join(", ");
  const failed = outcome.counted.length === 0 ? "none failed" : `${outcome.counted.length} failed`;
  const accepted = outcome.accepted === 0 ? "" : `, ${outcome.accepted} accepted`;
  return `${what}: ${outcome.sent} requests in ${Math.round(outcome.seconds)} s to the first app's site, ${statuses || "no answer"}; ${failed}${accepted}`;
}

/** Whether the load kept at least 90% of its rate over `seconds` (a busy computer tests less). */
export function keptRate(sent: number, seconds: number, rps = REQUESTS_PER_SECOND): boolean {
  return sent >= Math.floor(0.9 * rps * seconds);
}

/**
 * The server addresses among `addresses` (the scrubber's `server-*` entries) in the outputs of the
 * second app's commands (`--app <app>` in their label) (SC-3006): the problems, by label only.
 */
export function addressLeaks(
  outputs: ReadonlyMap<string, string>,
  addresses: readonly { label: string; value: string }[],
  app: string,
): string[] {
  const problems: string[] = [];
  for (const [label, output] of outputs) {
    const words = label.split(" ");
    if (!words.some((word, index) => word === "--app" && words[index + 1] === app)) continue;
    const found = leakedLabels(output, addresses);
    if (found.length > 0) problems.push(`the output of ${label} contains: ${found.join(", ")}`);
  }
  return problems;
}

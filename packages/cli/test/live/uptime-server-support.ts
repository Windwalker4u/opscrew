/**
 * Pure helpers of the uptime Worker's server pass (`uptime-server.test.ts`, docs/e2e.md "The
 * uptime Worker's server reports"): its gate and variables, the disk's percentage as the server's
 * script reads `df`, the size of the file that fills the disk to a percentage, how a command and
 * its secret input reach the server over SSH, a report's signature and a heartbeat built from the
 * report the Worker keeps, the credentials the agents date in the report's config, and the titles
 * of ntfy messages. No network, no processes; unit-tested in `uptime-server-support.test.ts`.
 */
import { createHmac } from "node:crypto";
import { missingVariables } from "./support";

/** The pass's gate. */
export const UPTIME_SERVER_GATE = "OPSCREW_E2E_UPTIME_SERVER";

/**
 * What the pass needs besides its gate: the throwaway server, the app's repository and zone (as
 * for your own server), the Worker's account (`OPSCREW_CLOUDFLARE_TOKEN_B`, as the Worker's own
 * pass has it) and the ntfy topic the Worker posts to.
 */
export const UPTIME_SERVER_VARIABLES = [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
  "OPSCREW_CLOUDFLARE_TOKEN_B",
  "OPSCREW_E2E_NTFY_TOPIC",
] as const;

/** The gate (`…=1`) and each variable of {@link UPTIME_SERVER_VARIABLES} not set. */
export function uptimeServerMissing(env: Record<string, string | undefined>): string[] {
  return missingVariables(env, UPTIME_SERVER_GATE, UPTIME_SERVER_VARIABLES);
}

/** The used and free bytes on `df -P -B1 /`'s last line (the 4th and 3rd fields from the end). */
function dfFigures(df: string): { used: number; free: number } {
  const last = df.trim().split(/\r?\n/).at(-1) ?? "";
  const fields = last.trim().split(/\s+/);
  const used = Number(fields.at(-4));
  const free = Number(fields.at(-3));
  if (fields.length < 6 || !Number.isSafeInteger(used) || !Number.isSafeInteger(free)) {
    throw new Error("df -P -B1 / printed no line of figures.");
  }
  return { used, free };
}

/** The disk's percentage as the server's script computes it: used of used and free, rounded up. */
export function diskPercent(df: string): number {
  const { used, free } = dfFigures(df);
  return Math.ceil((used * 100) / (used + free));
}

/**
 * The bytes a file must take so that the script reads the disk at `percent`, which must be past
 * the warning (85) and under the high mark (95). Throws when the disk is past the warning already.
 */
export function fillBytes(df: string, percent: number): number {
  if (percent < 85 || percent >= 95) {
    throw new Error(`The fill's target must be from 85 to 94 percent, not ${percent}.`);
  }
  const { used, free } = dfFigures(df);
  if (diskPercent(df) >= 85) {
    throw new Error(`The server's disk is already ${diskPercent(df)}% full.`);
  }
  // The smallest file past percent - 1, so the rounding up lands on percent.
  return Math.floor(((percent - 1) * (used + free)) / 100) - used + 1;
}

/** Longest command sent on the ssh command line, as OpsCrew's own SSH login sends it. */
const MAX_INLINE_COMMAND_BYTES = 2_000;

/**
 * What goes on the ssh command line and stdin for `command` with its stdin `input`, as OpsCrew's
 * own SSH login sends it: a short one-line command as it is; another one through a bootstrap
 * that copies exactly its bytes from stdin into a private file and runs it, so `input` (a secret)
 * follows on stdin and never touches the command line or the file.
 */
export function sshInvocation(
  command: string,
  input?: string,
): { command: string; input?: string } {
  const bytes = Buffer.byteLength(command, "utf8");
  if (bytes <= MAX_INLINE_COMMAND_BYTES && !command.includes("\n")) {
    return input === undefined ? { command } : { command, input };
  }
  const bootstrap =
    "umask 077; f=$(mktemp) || exit 125; trap 'rm -f \"$f\"' EXIT HUP INT TERM; " +
    `dd bs=1 count=${bytes} of="$f" 2>/dev/null; ` +
    `[ $(wc -c < "$f") -eq ${bytes} ] || ` +
    '{ echo "opscrew: the command did not arrive in full" >&2; exit 125; }; ' +
    'sh "$f"; exit $?';
  return { command: bootstrap, input: command + (input ?? "") };
}

/** A report's signature: HMAC-SHA256 of `<time>\n<body>` with the report key's 32 bytes, in hex. */
export function reportSignature(keyHex: string, time: number, body: string): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(`${time}\n${body}`).digest("hex");
}

/** A check of a report: a status, its figures, and in the Worker's copy when it started failing. */
type Check = Record<string, unknown>;

/** The report as the Worker keeps it (`report:<id>/<server>`): the server's, its `since`s and `at`. */
export interface StoredReport {
  version: number;
  server: string;
  kind: string;
  disk: Check;
  snapshot: Check;
  drill: Check;
  certificates: Check[];
  credentials?: Check[];
  at: number;
}

const withoutSince = ({ since: _since, ...rest }: Check): Check => rest;

/**
 * A heartbeat with the statuses of the report the Worker keeps, as the server's script would send
 * it (data-model.md's fields only): sent signed, it changes nothing the Worker posts.
 */
export function heartbeatBody(stored: StoredReport): string {
  return JSON.stringify({
    version: stored.version,
    server: stored.server,
    kind: "heartbeat",
    disk: withoutSince(stored.disk),
    snapshot: withoutSince(stored.snapshot),
    drill: withoutSince(stored.drill),
    certificates: stored.certificates.map(withoutSince),
    ...(stored.credentials === undefined
      ? {}
      : { credentials: stored.credentials.map(withoutSince) }),
  });
}

/** One credential of `opscrew rotate --json`, as far as the report's config reads it. */
export interface ListedDate {
  name: string;
  kind: string;
  rotation: { mode: string };
  date?: { at: string; source: string };
}

/** One credential's date in the report's config. */
export interface ReportedDate {
  name: string;
  at: string;
  source: "made" | "rotated" | "first-deploy";
}

const REPORTED_SOURCES = new Set<string>(["made", "rotated", "first-deploy"]);

/**
 * The credentials the scheduled check dates, as the agents put them in the report's config: each
 * listed one but the user's own tokens, those OpsCrew never rotates and the app's own values,
 * with its date when it has one OpsCrew made, rotated or took from the first deploy.
 */
export function reportedCredentials(listed: readonly ListedDate[]): ReportedDate[] {
  return listed.flatMap((credential) => {
    const { date } = credential;
    if (
      credential.kind === "user-token" ||
      credential.rotation.mode === "none" ||
      credential.name === "app" ||
      date === undefined ||
      !REPORTED_SOURCES.has(date.source)
    ) {
      return [];
    }
    return [{ name: credential.name, at: date.at, source: date.source as ReportedDate["source"] }];
  });
}

/** One ntfy message, as its JSON stream gives it. */
export interface NtfyMessage {
  time: number;
  title?: string;
  message: string;
  priority?: number;
}

/** The titles of `messages` that hold every one of `parts`, in their order. */
export function titlesOf(messages: readonly NtfyMessage[], ...parts: string[]): string[] {
  return messages.flatMap((m) =>
    m.title !== undefined && parts.every((part) => m.title?.includes(part)) ? [m.title] : [],
  );
}

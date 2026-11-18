/**
 * The checks of the address updater's own Cloudflare token before any change (research R6): it's
 * set, it isn't OpsCrew's own token, it's an active user token, it reads the app's zone's DNS
 * records, and nothing else OpsCrew can probe read-only.
 */
import {
  type AccountPermissionNeed,
  CLOUDFLARE_TOKEN_PAGE,
  CloudflareClient,
  type ZonePermissionNeed,
} from "@opscrew/connector-cloudflare";
import { type ErrorCode, listText, OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { updaterTokenReach } from "./texts";

/** The variable the updater's token is read from. */
export const UPDATER_TOKEN_VAR = "OPSCREW_DNS_UPDATER_TOKEN";

/** What {@link checkUpdaterToken} checks. */
export interface UpdaterTokenCheck {
  /** The updater's token as given (the variable's value, or one typed in); blank: not set. */
  token: string | undefined;
  /** Where the token came from, named in the refusals (default {@link UPDATER_TOKEN_VAR}). */
  variable?: string;
  /** OpsCrew's own token for the zone's account and its client. */
  own: { token: string; client: CloudflareClient };
  /** The app's zone. */
  zone: { id: string; name: string; accountId: string };
  /** The command that runs again once the token is fixed (`npx opscrew provision`). */
  command: string;
  deps: Pick<PhaseDeps, "fetch" | "redactor" | "version">;
}

/** A token that passed {@link checkUpdaterToken}. */
export interface CheckedUpdaterToken {
  /** The token, trimmed and registered with the redactor. */
  token: string;
  /** Its expiry (ISO 8601), when one is set. */
  expiresOn?: string;
}

/** The zone needs other than DNS, which the updater's token must not have, in plain words. */
const OTHER_ZONE_NEEDS: Record<Exclude<ZonePermissionNeed, "dns">, string> = {
  http_config_settings: "the zone's Config Rules",
  http_request_firewall_custom: "the zone's custom WAF rules",
  http_request_dynamic_redirect: "the zone's redirect rules",
  ssl: "the zone's SSL and certificates",
  settings: "the zone's settings",
};

/** The account needs, which the updater's token must not have, in plain words. */
const ACCOUNT_NEEDS: Record<AccountPermissionNeed, string> = {
  tunnel: "the account's Cloudflare Tunnels",
  "access-apps": "the account's Access applications",
  "access-service-tokens": "the account's Access service tokens",
  "access-organization": "the account's Access login methods",
  r2: "the account's R2 buckets",
  workers: "the account's Workers",
};

/** The Access needs: an account without Access gives no token any of them. */
const ACCESS_NEEDS = new Set<AccountPermissionNeed>([
  "access-apps",
  "access-service-tokens",
  "access-organization",
]);

/**
 * Checks the updater's token before any change, read-only, and registers it with the redactor:
 * it's set; it isn't OpsCrew's own token (its value, or the same token by the verify answer's id);
 * it's an active user token; it reads the zone's DNS records; and every other zone and account
 * permission OpsCrew can probe comes back missing. Each refusal names the token's recipe.
 */
export async function checkUpdaterToken(input: UpdaterTokenCheck): Promise<CheckedUpdaterToken> {
  const { zone, deps } = input;
  const variable = input.variable ?? UPDATER_TOKEN_VAR;
  const howTo = updaterTokenRecipe(zone.name, variable, input.command);
  const refused = (message: string, hint = howTo, code: ErrorCode = "CREDENTIALS_INVALID") =>
    new OpsCrewError(code, `${deps.redactor.redact(message)} Nothing was changed.`, { hint });
  const token = input.token?.trim();
  if (!token) {
    throw refused(
      `Your server's address updater needs a Cloudflare token of its own, limited to ${zone.name}'s DNS.`,
      `${howTo}\n${updaterTokenReach(zone.name)}`,
      "CREDENTIALS_MISSING",
    );
  }
  deps.redactor.addLiteral(token, variable);
  const ownToken = `${variable} is OpsCrew's own Cloudflare token, and the updater needs one of its own, limited to ${zone.name}'s DNS.`;
  if (token === input.own.token.trim()) throw refused(ownToken);

  const client = new CloudflareClient({
    token,
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  });
  const check = await client.verifyToken();
  if (!check.ok) throw refused(`${variable} does not work: ${check.message}`);
  if (check.id === undefined || check.status === undefined) {
    throw refused(
      `${variable} is an account's API token, and the updater needs a user token.`,
      `Make it under My Profile → API Tokens, not under the account's API Tokens.\n${howTo}`,
    );
  }
  if (check.status !== "active") throw refused(`${variable} is ${check.status}.`);
  if (check.id === (await input.own.client.verifyToken()).id) throw refused(ownToken);

  if ((await client.zonePermissions(zone.id, ["dns"])).missing.length > 0) {
    throw refused(`${variable} can't read ${zone.name}'s DNS records.`);
  }
  const wider = await widerReach(client, zone);
  if (wider.length > 0) {
    throw refused(
      `${variable} is wider than ${zone.name}'s DNS: it can also read ${listText(wider)}.`,
    );
  }
  return { token, ...(check.expiresOn ? { expiresOn: check.expiresOn } : {}) };
}

/**
 * What else than the zone's DNS the token reaches, of what OpsCrew can probe (in plain words, in
 * the tables' order); the probes run together.
 */
async function widerReach(
  client: CloudflareClient,
  zone: UpdaterTokenCheck["zone"],
): Promise<string[]> {
  const reached = await Promise.all([
    ...Object.entries(OTHER_ZONE_NEEDS).map(async ([need, words]) => {
      const { missing } = await client.zonePermissions(zone.id, [need as ZonePermissionNeed]);
      return missing.length === 0 ? words : undefined;
    }),
    ...Object.entries(ACCOUNT_NEEDS).map(async ([need, words]) =>
      (await reachesAccount(client, zone.accountId, need as AccountPermissionNeed))
        ? words
        : undefined,
    ),
  ]);
  return reached.filter((words) => words !== undefined);
}

/** Whether the token has the account need; an account without Access gives no token Access. */
async function reachesAccount(
  client: CloudflareClient,
  accountId: string,
  need: AccountPermissionNeed,
): Promise<boolean> {
  try {
    return (await client.accountPermissions(accountId, [need])).missing.length === 0;
  } catch (error) {
    // accountPermissions throws PHASE_PRECONDITION only for an account without Access.
    const noAccess = error instanceof OpsCrewError && error.code === "PHASE_PRECONDITION";
    if (noAccess && ACCESS_NEEDS.has(need)) return false;
    throw error;
  }
}

/**
 * How to make the updater's token for `zone`, and where it goes: lines joined by newlines, ending
 * with setting `variable` and running `command` again (`first`: running it, as design says before
 * the first provision).
 */
export function updaterTokenRecipe(
  zone: string,
  variable: string,
  command: string,
  first = false,
): string {
  return [
    `Make it at ${CLOUDFLARE_TOKEN_PAGE} → Create Token → Create Custom Token, with:`,
    "  permission Zone → DNS → Edit,",
    `  zone resources Include → Specific zone → ${zone}.`,
    `Then set ${variable} to it and run \`${command}\`${first ? "" : " again"}.`,
    "It stays only on your server, readable by root alone; OpsCrew keeps no copy.",
  ].join("\n");
}

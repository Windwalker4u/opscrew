import type { RegisteredDomain, Registrar, RegistrarId } from "@opscrew/contracts";
import { isUserFacingError } from "@opscrew/core";
import type { DeployPlan, Renewal } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { errorText, formatDate, providerText, resolveAccount } from "../domain/common";
import { registrarDashboard } from "../domain/links";
import { REGISTRAR_NAMES, registrarLinks } from "../domain/registrars";
import { renewalDue, renewedLine, renewedPlan, withoutRenewal } from "../domain/renewals";
import { type ResolvedDomainServices, resolveDomainServices } from "../domain/services";
import type { DomainServices } from "../domain/types";
import { writePlanIfChanged } from "../shared";

/**
 * How long after its expiry an unlisted domain counts as lapsed: past the registrars' renewal
 * grace period. Before then "not listed" can mean a pending status (GoDaddy) or another account
 * (Cloudflare, during an account move).
 */
const LAPSED_AFTER_MS = 45 * 86_400_000;

/**
 * The adapter that reads a domain at `id`: at Cloudflare, the registrar of the token's one account
 * (with several, the stop points to `opscrew domain status --account`, which records the renewal).
 */
async function registrarOf(services: ResolvedDomainServices, id: RegistrarId): Promise<Registrar> {
  if (id !== "cloudflare") return services.otherRegistrar(id);
  const accounts = await services.accounts();
  const account = resolveAccount(accounts, undefined, "`opscrew domain status --account <id>`");
  return services.registrar(account.id);
}

/**
 * The registrar's read of a renewal's domain: its details, or none when the registrar no longer
 * lists it; or, when it could not be read, the line that says why, with the adapter once it was
 * built.
 */
type RenewalRead =
  | { registrar: Registrar; info: RegisteredDomain | undefined }
  | { registrar: Registrar | undefined; failed: string };

/**
 * Reads a renewal's domain at its registrar. A failure's line ends with the error's own next step
 * (a missing token, a token with several accounts), or for anything else (the registrar could not
 * be reached) with running `opscrew status` again.
 */
async function readRenewal(
  deps: PhaseDeps,
  services: ResolvedDomainServices,
  renewal: Renewal,
): Promise<RenewalRead> {
  const name = REGISTRAR_NAMES[renewal.provider];
  let registrar: Registrar | undefined;
  try {
    registrar = await registrarOf(services, renewal.provider);
    const info = await registrar.getDomain(renewal.item);
    return {
      registrar,
      info: info === undefined ? undefined : { ...info, registrar: renewal.provider },
    };
  } catch (error) {
    const next =
      isUserFacingError(error) && error.hint !== undefined
        ? providerText(deps, error.hint)
        : `Run \`opscrew status\` again once ${name} can be reached`;
    return {
      registrar,
      failed: `OpsCrew could not check the renewal of ${renewal.item} at ${name}: ${errorText(deps, error)}. ${next}.`,
    };
  }
}

/**
 * The warning for a renewal due with auto-renew off: the date the domain expires (or expired), and
 * where to turn auto-renew on: `opscrew domain auto-renew on` when the registrar's API can change
 * it, else the registrar's dashboard.
 */
function autoRenewWarning(
  deps: PhaseDeps,
  renewal: Renewal,
  registrar: Registrar | undefined,
  now: Date,
): string | undefined {
  if (renewal.autoRenew || !renewalDue(renewal, now)) return undefined;
  const date = formatDate(renewal.next);
  const when =
    Date.parse(renewal.next) <= now.getTime()
      ? `it expired on ${date} unless you renewed it since`
      : `it expires on ${date} unless you renew it`;
  const how =
    registrar?.capabilities.autoRenew === true
      ? "Turn it on with `opscrew domain auto-renew on`."
      : `Turn it on at ${registrarLinks(renewal.provider, deps.env).domains}.`;
  return `Warning: auto-renew is off for ${renewal.item}, so ${when}. ${how}`;
}

/**
 * `opscrew status`'s lines about the renewals of the domains OpsCrew bought (031 FR-3113). Only once
 * a renewal's `next` is 30 days away or less, or past, is its registrar read: a renewal the
 * registrar charged is recorded in `opscrew/plan.yaml` (`renewedPlan`), and with auto-renew off a
 * warning names the date and how to turn it on. A domain the registrar does not list is said, and
 * more than 45 days past `next` leaves the renewals (said once). A registrar that cannot be read is
 * said plainly and the other renewals go on. Before then no registrar is called; without renewals, no lines. `services`: the registrars
 * (tests; default: built from the environment, as the domain commands build them).
 */
export async function renewalStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  services?: DomainServices,
): Promise<string[]> {
  const now = deps.clock.now();
  const due = (plan.cost.renewals ?? []).filter((renewal) => renewalDue(renewal, now));
  if (due.length === 0) return [];
  const resolved = resolveDomainServices(deps, services, { requireCloudflare: false });
  const lines: string[] = [];
  let current = plan;
  for (const renewal of due) {
    const read = await readRenewal(deps, resolved, renewal);
    if ("failed" in read) {
      lines.push(read.failed);
      const warning = autoRenewWarning(deps, renewal, read.registrar, now);
      if (warning !== undefined) lines.push(warning);
      continue;
    }
    if (read.info === undefined) {
      const name = REGISTRAR_NAMES[renewal.provider];
      if (now.getTime() - Date.parse(renewal.next) > LAPSED_AFTER_MS) {
        current = withoutRenewal(current, renewal);
        lines.push(
          `${renewal.item} is no longer in your ${name} account, so OpsCrew stopped tracking its renewal in opscrew/plan.yaml.`,
        );
        continue;
      }
      lines.push(
        `${name} does not list ${renewal.item} in your account, so OpsCrew could not check its renewal. Check ${registrarDashboard(renewal.provider, deps.env)}.`,
      );
      const warning = autoRenewWarning(deps, renewal, read.registrar, now);
      if (warning !== undefined) lines.push(warning);
      continue;
    }
    const after = renewedPlan(current, renewal.item, read.info, now);
    current = after.plan;
    const seen = after.renewal ?? renewal;
    if (after.renewed) lines.push(renewedLine(seen));
    const warning = autoRenewWarning(deps, seen, read.registrar, now);
    if (warning !== undefined) lines.push(warning);
  }
  if (current !== plan) await writePlanIfChanged(deps, current);
  return lines.map((line) => deps.redactor.redact(line));
}

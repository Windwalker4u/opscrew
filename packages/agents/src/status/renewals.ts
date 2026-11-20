import type { RegisteredDomain, Registrar, RegistrarId } from "@opscrew/contracts";
import type { DeployPlan, Renewal } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { errorText, formatDate, resolveAccount } from "../domain/common";
import { registrarDashboard } from "../domain/links";
import { REGISTRAR_NAMES, registrarLinks } from "../domain/registrars";
import { renewalDue, renewedLine, renewedPlan } from "../domain/renewals";
import { type ResolvedDomainServices, resolveDomainServices } from "../domain/services";
import type { DomainServices } from "../domain/types";
import { writePlanIfChanged } from "../shared";

/** Options of {@link renewalStatusReport}. */
export interface RenewalStatusOptions {
  /** The registrars (tests; default: built from the environment, as the domain commands build them). */
  services?: DomainServices;
}

/** The adapter that reads a domain at `id`: at Cloudflare, the registrar of the token's account. */
async function registrarOf(services: ResolvedDomainServices, id: RegistrarId): Promise<Registrar> {
  if (id !== "cloudflare") return services.otherRegistrar(id);
  const account = resolveAccount(await services.accounts(), undefined);
  return services.registrar(account.id);
}

/** The registrar's read of a renewal's domain, or the line that says why there is none. */
async function readRenewal(
  deps: PhaseDeps,
  services: ResolvedDomainServices,
  renewal: Renewal,
): Promise<{ registrar: Registrar; info: RegisteredDomain } | { line: string }> {
  const name = REGISTRAR_NAMES[renewal.provider];
  try {
    const registrar = await registrarOf(services, renewal.provider);
    const info = await registrar.getDomain(renewal.item);
    if (info !== undefined) return { registrar, info: { ...info, registrar: renewal.provider } };
    return {
      line: `${name} does not list ${renewal.item} in your account, so OpsCrew could not check its renewal. Check ${registrarDashboard(renewal.provider, deps.env)}.`,
    };
  } catch (error) {
    return {
      line: `OpsCrew could not check the renewal of ${renewal.item} at ${name}: ${errorText(deps, error)}. Run \`opscrew status\` again once ${name} can be reached.`,
    };
  }
}

/**
 * The warning for a renewal due with auto-renew off: the date the domain expires (or expired), and
 * where to turn auto-renew on: `opscrew domain auto-renew on` when the registrar was read and its
 * API can change it, else the registrar's dashboard.
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
 * warning names the date and how to turn it on. A registrar that cannot be read is said plainly and
 * the other renewals go on. Before then no registrar is called; without renewals, no lines.
 */
export async function renewalStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RenewalStatusOptions = {},
): Promise<{ lines: string[] }> {
  const now = deps.clock.now();
  const due = (plan.cost.renewals ?? []).filter((renewal) => renewalDue(renewal, now));
  if (due.length === 0) return { lines: [] };
  const services = resolveDomainServices(deps, options.services, { requireCloudflare: false });
  const lines: string[] = [];
  let current = plan;
  for (const renewal of due) {
    const read = await readRenewal(deps, services, renewal);
    if ("line" in read) {
      lines.push(read.line);
      const warning = autoRenewWarning(deps, renewal, undefined, now);
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
  return { lines: lines.map((line) => deps.redactor.redact(line)) };
}

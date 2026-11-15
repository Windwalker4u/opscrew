/**
 * Right after B's zone is active (plan 5.8, research R8): every prepared site's Workers custom
 * domains attached to its Worker in B with B's token, from the marks. Cloudflare attaches a custom
 * domain only on an active zone, so a site on Cloudflare's hosting answers from then on. When
 * Cloudflare refuses one while the old account's Worker still holds it (plan 13), that one is
 * detached in A first (with A's token, A's zone being moved by then) and attached again.
 */
import type { ReadMark } from "./marks";
import type { MoveSession, MoveZone } from "./types";

/**
 * Attaches each mark's site domains that B's zone doesn't have on that Worker yet; returns every
 * site domain of the marks (each probed by the gap's measure).
 */
export async function attachSites(
  session: MoveSession,
  marks: readonly ReadMark[],
  zone: MoveZone,
): Promise<string[]> {
  const { deps } = session;
  const { a, b } = session.accounts;
  const wanted = marks.flatMap((read) =>
    read.mark.sites.flatMap((site) => site.domains.map((hostname) => ({ hostname, site }))),
  );
  if (wanted.length === 0) return [];
  const attached = await b.client.listZoneWorkerDomains(b.accountId, zone.id);
  const made: string[] = [];
  for (const { hostname, site } of wanted) {
    if (attached.some((d) => d.hostname === hostname && d.service === site.worker)) continue;
    const domain = { hostname, zoneId: zone.id, service: site.worker };
    deps.reporter.step(`Attaching ${hostname} to the Worker ${site.worker} in the new account`);
    try {
      await b.client.attachWorkerDomain(b.accountId, domain);
    } catch (error) {
      const held = (await a.client.listZoneWorkerDomains(a.accountId, a.zoneId)).find(
        (d) => d.hostname === hostname,
      );
      if (held === undefined) throw error;
      await a.client.detachWorkerDomain(a.accountId, held.id);
      await deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: "custom domain detached (A)",
        phase: "cloudflare-move",
        target: session.zone,
        detail: `${hostname} from the Worker ${held.service} in the account ${a.accountId}, which held it`,
      });
      await b.client.attachWorkerDomain(b.accountId, domain);
    }
    made.push(hostname);
  }
  if (made.length > 0) {
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "custom domains attached",
      phase: "cloudflare-move",
      target: session.zone,
      detail: `${made.join(", ")} in the account ${b.accountId}`,
    });
  }
  return wanted.map((one) => one.hostname);
}

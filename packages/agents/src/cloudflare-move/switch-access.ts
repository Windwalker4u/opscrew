/**
 * Right after B's zone is active (plan 13b): every prepared app's Cloudflare Access applications in
 * B, made with B's token exactly as OpsCrew's `cloudflare-access` module makes them (names and
 * settings from the module, the policies prepare made found in B by name), then the hostnames they
 * protect pointed at the app's tunnel in B (found by name), as the `cloudflare-tunnel` module's
 * records. B refuses Access applications while its zone is pending, and a protected hostname's
 * record is never made before its application, or the hostname would be public. Each app's finish
 * imports both into its state.
 */
import { type CloudflareClient, OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import { OpsCrewError, plural } from "@opscrew/core";
import type { MoveMark, ReadMark } from "./marks";
import { moveAudit } from "./texts";
import type { MoveSession, MoveZone } from "./types";

type AccessInput = Parameters<CloudflareClient["createAccessApplication"]>[1];

/** A protected hostname of a mark, with what the modules make for it. */
interface Protected {
  hostname: string;
  /** The app's mark it comes from. */
  app: string;
  /** The Access application's name, as the module names it. */
  name: string;
  /** The reusable policy in front of it, by name. */
  policy: string;
  /** The tunnel its record points at, by name. */
  tunnel: string;
  /** The service token's application (SSH, Portainer's webhook), else a login by one-time PIN. */
  service: boolean;
}

/** The app's name in `environment`'s resources: prod's, else `<name>-<environment>`. */
function appName(mark: MoveMark, environment: string): string {
  return environment === "prod" ? mark.app : `${mark.app}-${environment}`;
}

/**
 * What the modules make for each hostname the mark protects: the deploy's service hostname (SSH
 * `ssh-<app>.<zone>` on the app's tunnel, or Portainer's webhook `portainer-<app>.<zone>` on its
 * own tunnel), Portainer's and Beszel's subdomains behind a one-time PIN.
 */
function protectedOf(mark: MoveMark, zone: string): Protected[] {
  return mark.access.map(({ hostname, kind, environment }) => {
    const name = appName(mark, environment);
    const own = { hostname, app: mark.app, tunnel: `opscrew-${name}` };
    if (kind !== "service") {
      const label = kind === "portainer" ? "Portainer" : "Beszel";
      const words = `OpsCrew ${label} (${name})`;
      return { ...own, name: words, policy: words, service: false };
    }
    const webhook = hostname === `portainer-${name}.${zone}`;
    return {
      ...own,
      name: `OpsCrew ${webhook ? "Portainer webhook" : "SSH"} (${name})`,
      policy: `OpsCrew deploy (${name})`,
      ...(webhook ? { tunnel: `opscrew-${name}-portainer` } : {}),
      service: true,
    };
  });
}

/** A piece prepare should have made in B is missing: the app's prepare is to run again. */
function missing(session: MoveSession, what: string, app: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The new Cloudflare account has no ${what}, which the move's prepare of ${app} makes, so its hostnames behind Cloudflare Access were not protected there.`,
    {
      hint: `Run \`opscrew cloudflare move\` in the repository of ${app} to make it again, then run \`${session.command}\` again.`,
    },
  );
}

/**
 * Makes, in B, each mark's Access applications that B lacks (by hostname), then the records of
 * their hostnames that B lacks: proxied CNAMEs to the app's tunnel there, with OpsCrew's comment.
 * Nothing when the marks protect no hostname.
 */
export async function protectInB(
  session: MoveSession,
  marks: readonly ReadMark[],
  zone: MoveZone,
): Promise<void> {
  const { deps } = session;
  const { b } = session.accounts;
  const wanted = marks.flatMap((read) => protectedOf(read.mark, session.zone));
  if (wanted.length === 0) return;
  const apps = await b.client.listAccessApplications(b.accountId);
  const toMake = wanted.filter(
    (one) => !apps.some((app) => app.domain?.toLowerCase() === one.hostname),
  );
  if (toMake.length > 0) {
    const policies = await b.client.listAccessPolicies(b.accountId);
    const pin = toMake.some((one) => !one.service)
      ? (await b.client.accessIdentityProviders(b.accountId)).find((p) => p.type === "onetimepin")
      : undefined;
    for (const one of toMake) {
      const policy = policies.find((p) => p.name === one.policy);
      if (policy === undefined) throw missing(session, `Access policy ${one.policy}`, one.app);
      if (!one.service && pin === undefined) {
        throw missing(session, "one-time PIN login for Cloudflare Access", one.app);
      }
      const input: AccessInput = {
        name: one.name,
        domain: one.hostname,
        appLauncherVisible: false,
        sessionDuration: "24h",
        policies: [{ id: policy.id, precedence: 1 }],
        ...(one.service
          ? { serviceAuth401Redirect: true }
          : { allowedIdps: [pin?.id as string], autoRedirectToIdentity: true }),
      };
      deps.reporter.step(`Protecting ${one.hostname} with Cloudflare Access in the new account`);
      await b.client.createAccessApplication(b.accountId, input);
      await moveAudit(deps, {
        kind: "provider-call",
        action: "Access application created",
        target: session.zone,
        detail: `${one.name} for ${one.hostname} in the account ${b.accountId}`,
      });
    }
  }

  const records = await b.client.listZoneRecords(zone.id);
  const tunnels = await b.client.listTunnels(b.accountId);
  const create = [];
  for (const one of wanted) {
    const tunnel = tunnels.find((t) => t.name === one.tunnel);
    if (tunnel === undefined) throw missing(session, `Cloudflare Tunnel ${one.tunnel}`, one.app);
    const content = `${tunnel.id}.cfargotunnel.com`;
    const there = records.some(
      (r) => r.type.toUpperCase() === "CNAME" && r.name === one.hostname && r.content === content,
    );
    if (there) continue;
    create.push({
      type: "CNAME",
      name: one.hostname,
      content,
      ttl: 1,
      proxied: true,
      comment: OPSCREW_MANAGED_COMMENT,
    });
  }
  if (create.length === 0) return;
  await b.client.createZoneRecords(zone.id, create);
  await moveAudit(deps, {
    kind: "provider-call",
    action: "protected records created",
    target: session.zone,
    detail: `${plural(create.length, "record")} in ${session.zone}: ${create.map((r) => r.name).join(", ")}`,
  });
}

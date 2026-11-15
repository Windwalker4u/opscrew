/**
 * The finish's adoption of what the switch made in B for an environment (plan 7.5, 13b): Cloudflare
 * attaches a Workers custom domain and makes an Access application only on an active zone, so the
 * switch made them in B with B's token right after activation (and the records of the hostnames
 * behind Access). The finish imports them into the environment's main shadow state, so its plan
 * with the committed values (`custom_domains`, `access_applications` and `protected_route_records`
 * true) is empty, then gives the deploy its credentials for B under their usual names.
 */
import { OpsCrewError } from "@opscrew/core";
import { portainerWebhookHostname, workerCustomDomainAddresses } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { promoteNewCredentials } from "./deploy-secrets";
import { appMark, type MoveMark } from "./marks";
import { hasContent, importIntoShadow, shadowEngineEnv, shadowRoots } from "./shadow";
import { checkAdoption } from "./shadow-plans";
import type { MoveEnvironment, MoveSession, ShadowRoot, StepStop } from "./types";

/** The Access application's resource in `module.access`, by the kind of hostname it protects. */
const ACCESS_RESOURCES: Readonly<Record<MoveMark["access"][number]["kind"], string>> = {
  service: "ssh",
  portainer: "portainer",
  beszel: "beszel",
};

/** A piece of the main root the switch made in B: its address and, when B has it, its import id. */
interface Adopted {
  address: string;
  id?: string;
}

/** B's zone's id: the finish runs only once B's zone is active. */
function bZoneId(session: MoveSession): string {
  const id = session.accounts.b.zone?.id;
  if (id !== undefined) return id;
  throw new OpsCrewError(
    "INTERNAL",
    `${session.zone} isn't in the new Cloudflare account, so OpsCrew can't adopt what the switch made there.`,
    { hint: "This is a bug in OpsCrew; please report it." },
  );
}

/**
 * The Workers custom domains of a site the switch attached in B (`<account id>/<domain id>`): each
 * of `workerCustomDomainAddresses`, found by its hostname on the site's Worker.
 */
async function customDomains(session: MoveSession, plan: DeployPlan): Promise<Adopted[]> {
  const domains = workerCustomDomainAddresses(plan);
  if (domains.length === 0 || plan.target.provider !== "cloudflare-workers") return [];
  const { worker } = plan.target;
  const { b } = session.accounts;
  const attached = await b.client.listZoneWorkerDomains(b.accountId, bZoneId(session));
  return domains.map(({ address, hostname }) => {
    const found = attached.find((one) => one.hostname === hostname && one.service === worker);
    return { address, ...(found === undefined ? {} : { id: `${b.accountId}/${found.id}` }) };
  });
}

/**
 * The environment's Access applications (`accounts/<account id>/<application id>`) and the records
 * of the hostnames they protect (`<zone id>/<record id>`) the switch made in B, by the hostnames
 * the app's mark protects: the application by its hostname, the record as the CNAME of that name.
 */
async function accessPieces(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<Adopted[]> {
  const access = (await appMark(session)).access.filter(
    (one) => one.environment === environment.environment,
  );
  if (access.length === 0) return [];
  const { b } = session.accounts;
  const zoneId = bZoneId(session);
  const apps = await b.client.listAccessApplications(b.accountId);
  const records = await b.client.listZoneRecords(zoneId);
  const inZone: DeployPlan = {
    ...environment.plan,
    dns: { ...environment.plan.dns, zone: session.zone },
  };
  const webhook = portainerWebhookHostname(inZone);
  return access.flatMap(({ hostname, kind }) => {
    const app = apps.find((one) => one.domain?.toLowerCase() === hostname);
    const record = records.find(
      (one) => one.type.toUpperCase() === "CNAME" && one.name === hostname,
    );
    const tunnel = hostname === webhook ? "portainer_tunnel" : "tunnel";
    return [
      {
        address: `module.access.cloudflare_zero_trust_access_application.${ACCESS_RESOURCES[kind]}[0]`,
        ...(app === undefined ? {} : { id: `accounts/${b.accountId}/${app.id}` }),
      },
      {
        address: `module.${tunnel}.cloudflare_dns_record.route[${JSON.stringify(hostname)}]`,
        ...(record === undefined ? {} : { id: `${zoneId}/${record.id}` }),
      },
    ];
  });
}

/** The addresses in `root`'s shadow state (`state list` outside the root: no `TF_DATA_DIR`). */
async function shadowAddresses(session: MoveSession, root: ShadowRoot): Promise<string[]> {
  const env = await shadowEngineEnv(session, root, "b");
  return session.engine.stateResources(root.statePath, { env });
}

/**
 * Adopts in B what the switch made there for `environment` (plan 7.5, 13b), then promotes its
 * deploy credentials: a Workers site's custom domains, and the Access applications and the records
 * of the hostnames they protect, each imported into the main shadow state (`importIntoShadow`)
 * unless it is there already; then the check plan of the main shadow root with the committed
 * values (`checkAdoption`), which must be empty: any change stops before an approval and before
 * the credentials; then `promoteNewCredentials`. Nothing but the credentials for an environment
 * without them, or without a main shadow state. Resumable: a run imports only what is missing.
 * Nothing in A is read or changed.
 */
export async function adoptSite(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const found = (await shadowRoots(session, environment)).find((root) => root.name === "main");
  // Without its shadow state (the swap took it), an import would make one holding only that piece.
  const main = found !== undefined && (await hasContent(found.statePath)) ? found : undefined;
  const wanted =
    main === undefined
      ? []
      : [
          ...(await customDomains(session, environment.plan)),
          ...(await accessPieces(session, environment)),
        ];
  if (main !== undefined && wanted.length > 0) {
    const held = await shadowAddresses(session, main);
    for (const { address, id } of wanted) {
      if (id !== undefined && !held.includes(address)) {
        await importIntoShadow(session, main, address, id);
      }
    }
    const { custom_domains: _later, ...vars } = main.vars;
    // Empty, or a stop before any approval: an empty plan is never pending.
    await checkAdoption(session, { ...main, vars });
  }
  return promoteNewCredentials(session, environment);
}

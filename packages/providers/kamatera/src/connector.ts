import type {
  ComputeCatalog,
  CredentialCheck,
  CredentialRequirement,
  ProviderConnectorDeps,
  ProviderRedactor,
  VpsConnector,
} from "@opscrew/contracts";
import { errorText, listText, plural, Redactor, realSleep } from "@opscrew/core";
import { z } from "zod";
import { KamateraCatalog } from "./catalog";
import { KAMATERA_ENV, KamateraClient, readKamateraCredentials } from "./client";
import { kamateraServerApi, kamateraServers } from "./servers";

/** Credentials OpsCrew needs for Kamatera: one API key, which can't be limited. */
export const KAMATERA_CREDENTIALS: CredentialRequirement = {
  envVars: Object.values(KAMATERA_ENV),
  description: `A Kamatera API key: its access key as ${KAMATERA_ENV.clientId} and its secret key as ${KAMATERA_ENV.secret}, from API → Keys in Kamatera's console. A key can't be limited: it can do everything on your Kamatera account, so a separate Kamatera account for OpsCrew is the safest.`,
  scopes: [],
  // Kamatera's own steps for creating a key (console, API, Keys, Create New Key).
  createUrl: "https://www.kamatera.com/knowledgebase/how-to-deploy-terraform-on-a-kamatera-vps/",
};

/**
 * One datacenter of `GET /service/server/options/datacenters` (the CLI schema's `datacenters`
 * command; the CLI API answers each as its code and city).
 */
const datacenterSchema = z.looseObject({ id: z.string(), region: z.string() });

/** The Kamatera connector. */
export interface KamateraConnector extends VpsConnector {
  readonly id: "kamatera";
}

/**
 * Creates the Kamatera connector: the credential check, the catalogue and the server API. The API
 * key is read from `KAMATERA_API_CLIENT_ID` and `KAMATERA_API_SECRET` and registered with the
 * redactor as it is read; without both, nothing calls Kamatera. The catalogue is made once, and
 * reads Kamatera's public prices, so it is the same with or without the key. Kamatera has no cloud
 * firewall, and OpsCrew turns on none of its backups, so there are no connector firewalls, backups
 * or object storage.
 */
export function kamateraConnector(deps: ProviderConnectorDeps): KamateraConnector {
  const redactor = deps.redactor ?? new Redactor();
  const read = readKamateraCredentials(deps.env, redactor);
  const now = () => (deps.now ?? (() => new Date()))().getTime();
  const signedIn =
    "problem" in read
      ? read
      : {
          client: new KamateraClient({
            credentials: read.credentials,
            apiUrl: read.apiUrl,
            redactor,
            ...(deps.fetch && { fetch: deps.fetch }),
            ...(deps.version && { version: deps.version }),
            sleep: deps.sleep ?? realSleep,
            now,
          }),
        };
  const client = "client" in signedIn ? signedIn.client : undefined;
  let catalog: ComputeCatalog | undefined;

  return {
    id: "kamatera",
    displayName: "Kamatera",
    credentials: KAMATERA_CREDENTIALS,
    configured: client !== undefined,
    servers: client === undefined ? undefined : kamateraServerApi(client, { redactor, now }),
    catalog: () => {
      catalog ??= new KamateraCatalog({ fetch: deps.fetch, now: deps.now });
      return catalog;
    },
    verifyCredentials: async () =>
      "problem" in signedIn
        ? { ok: false, message: signedIn.problem }
        : verifyAccount(signedIn.client, redactor),
  };
}

/**
 * Reads the account's servers and the datacenters it can use, and says how many servers it has
 * and the datacenters' codes. A failure is Kamatera's answer in plain English, with what to do.
 */
async function verifyAccount(
  client: KamateraClient,
  redactor: ProviderRedactor,
): Promise<CredentialCheck> {
  try {
    const servers = await kamateraServers(client, redactor);
    const datacenters = await client.get(
      "/service/server/options/datacenters",
      z.array(datacenterSchema),
    );
    const codes = datacenters.map((datacenter) => datacenter.id).sort();
    const message = `The Kamatera API key works: your Kamatera account has ${plural(servers.length, "server")}, and its datacenters are ${listText(codes)}.`;
    return { ok: true, message: redactor.redact(message) };
  } catch (error) {
    const message = errorText(error, "Could not check the Kamatera API key.");
    return { ok: false, message: redactor.redact(message) };
  }
}

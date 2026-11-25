import type {
  ComputeCatalog,
  CredentialCheck,
  CredentialRequirement,
  ProviderConnectorDeps,
  ProviderRedactor,
  VpsConnector,
} from "@opscrew/contracts";
import { errorText, listText, Redactor, realSleep } from "@opscrew/core";
import { z } from "zod";
import { OvhcloudCatalog, StaticOvhcloudCatalog } from "./catalog";
import {
  OVHCLOUD_CREDENTIALS_URL,
  OVHCLOUD_ENV,
  OvhcloudClient,
  readOvhcloudCredentials,
} from "./client";
import { ovhcloudServerApi } from "./servers";

/** Credentials OpsCrew needs for OVHcloud: a service account, its project and the zone. */
export const OVHCLOUD_CREDENTIALS: CredentialRequirement = {
  envVars: Object.values(OVHCLOUD_ENV),
  description:
    "An OVHcloud service account (its client id and secret) with an IAM policy that gives it your Public Cloud project and nothing else, the project's id, and OVH_ENDPOINT=ovh-eu (OVHcloud Europe).",
  scopes: [],
  createUrl: OVHCLOUD_CREDENTIALS_URL,
};

/**
 * Where the user activates another region on the project (OVHcloud's guide "How to use the Public
 * Cloud interface": Settings → Quota & Regions, where new regions are activated).
 */
const ACTIVATE_REGION =
  "To activate another, open your project under Public Cloud in the control panel, then Quota & Regions under Settings.";

/**
 * `publicCloud.project.ProjectAsyncWithIAM` (v2): its name, null for a project never named. Its
 * `currentState.name` is not read: for an unnamed project it is the project's id.
 */
const projectSchema = z.looseObject({ name: z.string().nullish() });

/** `publicCloud.reference.Region` (v2): whether it is activated on the project. */
const regionSchema = z.looseObject({ name: z.string(), activated: z.boolean() });

/** The OVHcloud connector. */
export interface OvhcloudConnector extends VpsConnector {
  readonly id: "ovhcloud";
}

/**
 * Creates the OVHcloud connector: the credential check, the catalogue and the server API, in the
 * Public Cloud project the credentials name. The four values are read from `OVH_*` and registered
 * with the redactor as they are read; without all four, or with an endpoint other than `ovh-eu`,
 * nothing calls OVHcloud and the catalogue is the dated static table. Terraform manages the
 * firewall (a security group), so there are no connector firewalls, backups or object storage.
 */
export function ovhcloudConnector(deps: ProviderConnectorDeps): OvhcloudConnector {
  const redactor = deps.redactor ?? new Redactor();
  const read = readOvhcloudCredentials(deps.env, redactor);
  const now = () => (deps.now ?? (() => new Date()))().getTime();
  const sleep = deps.sleep ?? realSleep;
  const signedIn =
    "problem" in read
      ? read
      : {
          client: new OvhcloudClient({
            credentials: read.credentials,
            redactor,
            ...(deps.fetch && { fetch: deps.fetch }),
            ...(deps.version && { version: deps.version }),
            sleep,
            now,
          }),
        };
  const client = "client" in signedIn ? signedIn.client : undefined;
  let catalog: ComputeCatalog | undefined;

  return {
    id: "ovhcloud",
    displayName: "OVHcloud",
    credentials: OVHCLOUD_CREDENTIALS,
    configured: client !== undefined,
    servers: client === undefined ? undefined : ovhcloudServerApi(client, { redactor, sleep, now }),
    catalog: () => {
      catalog ??=
        client === undefined
          ? new StaticOvhcloudCatalog()
          : new OvhcloudCatalog(client, {
              ...(deps.fetch && { fetch: deps.fetch }),
              ...(deps.now && { now: deps.now }),
            });
      return catalog;
    },
    verifyCredentials: async () =>
      "problem" in signedIn
        ? { ok: false, message: signedIn.problem }
        : verifyProject(signedIn.client, redactor),
  };
}

/**
 * Signs in, reads the project and lists the regions activated on it, with where to activate
 * another. A failure is OVHcloud's answer in plain English, with what to do.
 */
async function verifyProject(
  client: OvhcloudClient,
  redactor: ProviderRedactor,
): Promise<CredentialCheck> {
  try {
    const project = await client.get(client.projectPath("v2"), projectSchema);
    const regions = await client.get(
      `${client.projectPath("v2")}/reference/region`,
      z.array(regionSchema),
    );
    const name = project.name || undefined;
    const activated = regions
      .filter((region) => region.activated)
      .map((region) => region.name)
      .sort();
    const where =
      activated.length === 0
        ? "No region is activated on it yet."
        : `Regions activated on it: ${listText(activated)}.`;
    const message = `The OVHcloud service account works with your Public Cloud project${name === undefined ? "" : ` "${name}"`}. ${where} ${ACTIVATE_REGION}`;
    return {
      ok: true,
      ...(name === undefined ? {} : { identity: redactor.redact(name) }),
      message: redactor.redact(message),
    };
  } catch (error) {
    const message = errorText(error, "Could not check the OVHcloud credentials.");
    return { ok: false, message: redactor.redact(message) };
  }
}

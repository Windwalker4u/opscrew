/**
 * Provision and PostgreSQL extensions (feature 045):
 * - refuses PostGIS on any `arm64` server before anything changes (own servers, Portainer hosts,
 *   this computer, and hand-edited ARM cloud server types checked against the provider's catalogue);
 * - records each PostgreSQL service's extensions in `generated_values.json` when provision creates
 *   the database, and refuses adding or removing extensions on any database that already has data
 *   (`neverRan`), before anything is written or 047's switch runs.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import {
  type CloudDeployTarget,
  type DeployPlan,
  isCloudTarget,
  type PlanService,
  postgresExtensions,
  postgresPostgisExtensions,
  targetArch,
} from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import type { PhaseDeps } from "../context";
import { requirePostgisArch } from "../design/postgres-extensions";
import { readStrict } from "../rotate/values-pending";
import { planFile } from "../runners/words";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { hasDeployment } from "../shared/server-address";
import type { LoginsSnapshot } from "./postgres-logins";

/** Checks a cloud server target's `serverType` architecture against its provider's static catalogue. */
async function cloudTargetArch(
  target: Pick<CloudDeployTarget, "provider" | "location" | "serverType">,
): Promise<"amd64" | "arm64" | "unknown"> {
  const catalog = cloudProvider(target.provider).connector({ env: {} }).catalog();
  const inLocation = await catalog.listOffers(target.location);
  const found =
    inLocation.find((offer) => offer.id === target.serverType) ??
    (await catalog.listOffers()).find((offer) => offer.id === target.serverType);
  if (found === undefined) return "unknown";
  return found.architecture === "arm" ? "arm64" : "amd64";
}

/** Architecture and readable host description for the server `service` runs on according to `plan`. */
async function serverArchFor(
  plan: DeployPlan,
  service: PlanService,
): Promise<{ arch: "amd64" | "arm64" | "unknown"; where: string }> {
  if (service.server === undefined) {
    if (isCloudTarget(plan.target)) {
      const arch = await cloudTargetArch(plan.target);
      return { arch, where: `your server (${plan.target.serverType})` };
    }
    const where =
      plan.target.provider === "portainer"
        ? "your Portainer host"
        : plan.target.provider === "localhost"
          ? "this computer"
          : "your server";
    return { arch: targetArch(plan.target), where };
  }
  const extra = plan.servers?.find((server) => server.name === service.server);
  if (extra !== undefined && isCloudTarget(extra.target)) {
    const arch = await cloudTargetArch(extra.target);
    return { arch, where: `server ${service.server} (${extra.target.serverType})` };
  }
  const arch = extra?.target.provider === "own" ? extra.target.arch : "amd64";
  return { arch, where: `server ${service.server}` };
}

/**
 * Refuses any enabled PostgreSQL service requesting PostGIS on an `arm64` host or an unrecognised
 * cloud `serverType` before anything changes (including hand-edited ARM cloud `serverType`s such
 * as `cax11`).
 */
export async function requireExtensionsArch(plan: DeployPlan, command: string): Promise<void> {
  const file = planFile(plan);
  for (const service of plan.services) {
    if (!service.enabled || service.kind !== "postgres") continue;
    if (postgresPostgisExtensions(service).length === 0) continue;
    const { arch, where } = await serverArchFor(plan, service);
    if (arch === "unknown") {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `PostGIS runs from the official postgis/postgis image, which is amd64-only, and OpsCrew can't verify the architecture of ${where} in ${file}. Nothing was changed.`,
        {
          hint: `Pick an amd64 server type listed in your provider's catalogue or remove the PostGIS extensions from ${service.name} in ${file}, then run \`${command}\` again.`,
        },
      );
    }
    requirePostgisArch([service], arch, where, {
      planFile: file,
      command,
      unchanged: "Nothing was changed.",
    });
  }
}

/** Canonical sorted list of extension names for comparison and storage. */
export function normalizedExtensions(list: readonly string[] | undefined): string[] {
  return [...new Set(list ?? [])].sort();
}

function sameExtensions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function formatExtensionSet(list: readonly string[]): string {
  return list.length === 0 ? "none" : list.join(", ");
}

/**
 * Provision's step for PostgreSQL extensions (feature 045), run before 047's logins switch and
 * before anything else changes:
 * 1. Refuses PostGIS on any `arm64` host (including hand-edited ARM cloud `serverType`s).
 * 2. When `generated_values.json` already keeps `dbPassword`, compares each enabled PostgreSQL
 *    service's planned extensions against what was recorded when provision created it (absent
 *    means `[]`).
 * 3. For any service whose extension set changed, checks `snapshot.neverRan`: if the database
 *    already has data, refuses before anything is written. A database that never ran yet is
 *    allowed to receive its extensions at creation.
 */
export async function postgresExtensionsStep(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  o: {
    command: string;
    snapshot: Pick<LoginsSnapshot, "neverRan">;
  },
): Promise<void> {
  if (!plan.services.some((service) => service.enabled && service.kind === "postgres")) return;
  await requireExtensionsArch(plan, o.command);

  const kept = (await readStrict(generatedValuesFile(deps), GeneratedValuesSchema)) ?? {};
  const file = planFile(plan);
  if (kept.dbPassword === undefined) {
    if (!hasDeployment(plan)) return;
    const withExtensions = plan.services.filter(
      (service) =>
        service.enabled && service.kind === "postgres" && postgresExtensions(service).length > 0,
    );
    if (withExtensions.length === 0) return;
    const empty = new Set(await o.snapshot.neverRan(withExtensions.map((service) => service.name)));
    const blocked = withExtensions.filter((service) => !empty.has(service.name));
    if (blocked.length === 0) return;
    if (blocked.length === 1) {
      const [only] = blocked;
      if (only !== undefined) {
        throw new OpsCrewError(
          "INVALID_INPUT",
          `${only.name} already has data, and this machine has no record of which extensions it was created with (local generated values are missing). OpsCrew can't add or remove extensions on an existing database yet. Nothing was changed.`,
          {
            hint: `Run \`${o.command}\` from the machine that provisioned this environment, or remove \`extensions\` from ${only.name} in ${file} if it wasn't created with them, then run \`${o.command}\` again.`,
          },
        );
      }
    }
    const names = listText(blocked.map((service) => service.name));
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${names} already have data, and this machine has no record of which extensions they were created with (local generated values are missing). OpsCrew can't add or remove extensions on an existing database yet. Nothing was changed.`,
      {
        hint: `Run \`${o.command}\` from the machine that provisioned this environment, or remove \`extensions\` in ${file} if they weren't created with them, then run \`${o.command}\` again.`,
      },
    );
  }

  const changed: { name: string; recorded: string[]; planned: string[] }[] = [];
  for (const service of plan.services) {
    if (!service.enabled || service.kind !== "postgres") continue;
    const recorded = normalizedExtensions(kept.postgresExtensions?.[service.name]);
    const planned = normalizedExtensions(postgresExtensions(service));
    if (!sameExtensions(recorded, planned)) {
      changed.push({ name: service.name, recorded, planned });
    }
  }
  if (changed.length === 0) return;

  const empty = new Set(await o.snapshot.neverRan(changed.map((entry) => entry.name)));
  const blocked = changed.filter((entry) => !empty.has(entry.name));
  if (blocked.length === 0) return;

  if (blocked.length === 1) {
    const [only] = blocked;
    if (only !== undefined) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `${only.name} already has data, and OpsCrew can't add or remove extensions on an existing database yet: keep \`extensions\` as it was (${formatExtensionSet(only.recorded)}) in ${file}. A new database gets them at creation. Nothing was changed.`,
        {
          hint: `Put ${only.name}'s \`extensions\` back to ${formatExtensionSet(only.recorded)} in ${file}, then run \`${o.command}\` again.`,
        },
      );
    }
  }
  const names = listText(blocked.map((entry) => entry.name));
  const keep = blocked
    .map((entry) => `${entry.name}: ${formatExtensionSet(entry.recorded)}`)
    .join("; ");
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${names} already have data, and OpsCrew can't add or remove extensions on an existing database yet: keep \`extensions\` as it was (${keep}) in ${file}. A new database gets them at creation. Nothing was changed.`,
    {
      hint: `Restore the original \`extensions\` in ${file}, then run \`${o.command}\` again.`,
    },
  );
}

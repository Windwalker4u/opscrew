/**
 * PostgreSQL extensions checks in design (feature 045): PostGIS's official image (`postgis/postgis`)
 * publishes only `linux/amd64` manifests, so design refuses placing a PostGIS database on an
 * `arm64` server (an own server, an extra server, a Portainer host, this computer, or a hand-edited
 * ARM cloud server type) before writing `opscrew/plan.yaml`.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import { type PlanService, postgresPostgisExtensions } from "@opscrew/plan-schema";

/**
 * Refuses any enabled PostgreSQL service requesting PostGIS on an `arm64` host before anything
 * changes. Cloud servers offered by design are already `amd64` (`usableOffer`), so this catches
 * `arm64` own servers, extra servers, Portainer hosts, this computer, and hand-edited ARM cloud
 * server types.
 * @throws OpsCrewError `INVALID_INPUT` naming the service, extensions, and host.
 */
export function requirePostgisArch(
  services: readonly PlanService[],
  arch: "amd64" | "arm64",
  where: string,
  options: {
    planFile?: string;
    command?: string;
    unchanged?: string;
  } = {},
): void {
  if (arch !== "arm64") return;
  for (const service of services) {
    if (!service.enabled || service.kind !== "postgres") continue;
    const postgis = postgresPostgisExtensions(service);
    if (postgis.length === 0) continue;
    const file = options.planFile ?? "opscrew/plan.yaml";
    const command = options.command ?? "opscrew design";
    const unchanged = options.unchanged ?? "plan.yaml was not changed.";
    throw new OpsCrewError(
      "INVALID_INPUT",
      `PostgreSQL ${service.name} requests PostGIS (${listText(postgis)}), whose official image (postgis/postgis) supports only amd64 (x86_64) servers, and ${where} is arm64. ${unchanged}`,
      {
        hint: `Use an amd64 server for ${service.name}, or remove the PostGIS extensions from ${service.name}'s options in ${file}, then run \`${command}\` again.`,
      },
    );
  }
}

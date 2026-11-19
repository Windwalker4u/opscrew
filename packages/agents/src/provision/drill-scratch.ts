import type { DockerClient } from "@opscrew/connector-docker";
import { portainerStackName, portainerStackVolumes } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";

/** The suffix of a scheduled dump drill's scratch volume (`<service>_drill`, iac-templates'). */
export const DRILL_VOLUME = "_drill";

/**
 * The scheduled dump drills' scratch volumes in the user's Portainer that OpsCrew's record
 * `recorded` lists: `<stack>_<service>_drill` for each of the plan's services, sorted. No other
 * name is ever one.
 */
export function recordedScratchVolumes(plan: DeployPlan, recorded: readonly string[]): string[] {
  const stack = portainerStackName(plan);
  return plan.services
    .map((service) => `${stack}_${service.name}${DRILL_VOLUME}`)
    .filter((name) => recorded.includes(name))
    .sort();
}

/**
 * The recorded scratch volumes ({@link recordedScratchVolumes}) the plan's stack no longer has
 * (their schedule was turned off), by whether a container still mounts one (`inUse`: its loop runs
 * until the deploy removes it) or none does (`free`). Docker's containers are listed only when
 * there is such a volume.
 */
export async function leftScratchVolumes(
  plan: DeployPlan,
  recorded: readonly string[],
  docker: () => Pick<DockerClient, "listContainers">,
): Promise<{ free: string[]; inUse: string[] }> {
  const wanted = new Set(portainerStackVolumes(plan));
  const left = recordedScratchVolumes(plan, recorded).filter((name) => !wanted.has(name));
  if (left.length === 0) return { free: [], inUse: [] };
  const mounted = new Set(
    (await docker().listContainers([])).flatMap((container) =>
      container.mounts.flatMap((mount) =>
        mount.type === "volume" && mount.name !== undefined ? [mount.name] : [],
      ),
    ),
  );
  return {
    free: left.filter((name) => !mounted.has(name)),
    inUse: left.filter((name) => mounted.has(name)),
  };
}

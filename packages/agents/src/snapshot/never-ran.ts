/**
 * Which of an environment's services have never run where its data lives (047): no container and
 * no data volume of theirs (on a server, nor their data folder `/srv/data/<app>/<service>`), so
 * they hold no data a snapshot could copy. A switch to PostgreSQL's own logins made before any
 * deploy reads it, so that it does not stop on a snapshot of a database that never ran.
 */
import { OpsCrewError } from "@opscrew/core";
import { localComposeProject, shellQuote, snapshotParts } from "@opscrew/iac-templates";
import { isCloudTarget } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { hasDeployment, serverWords } from "../shared/server-address";
import { serverShell } from "../status/servers";
import { dataServers, READ_TIMEOUT_MS } from "./hosts";
import { ofService, portainerPlace, stackContainers } from "./portainer";
import { snapshotRun, snapshotTarget } from "./run";
import type { SnapshotServices } from "./types";

/**
 * True when one of `volumes` is a data volume of `service` in the Compose project `project`
 * (`<project>_<service>_<name>`), by its name: a volume made outside Compose has no project label.
 */
function hasVolume(volumes: readonly string[], project: string, service: string): boolean {
  return volumes.some((volume) => volume.startsWith(`${project}_${service}_`));
}

/**
 * The lines Docker on this computer prints for `args`.
 * @throws OpsCrewError `COMMAND_FAILED` when it does not answer: no answer is no proof of no data.
 */
async function localDocker(deps: PhaseDeps, args: string[]): Promise<string[]> {
  const result = await deps.runner.run("docker", args, { timeoutMs: READ_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Docker on this computer did not answer (exit code ${result.exitCode}), so OpsCrew could not read which services ran.`,
      { hint: "Start Docker, then try again." },
    );
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The command that prints `data <service>` for each of `names` with a container, a data volume or
 * a data folder on the server of the app `app` (read-only). A data folder it can't look into counts
 * as data.
 */
function dataCommand(app: string, names: readonly string[]): string {
  const project = `--filter label=com.docker.compose.project=${app}`;
  const folder = `/srv/data/${app}`;
  return [
    'volumes="$(docker volume ls -q)" || exit 1',
    `for s in ${names.map(shellQuote).join(" ")}; do`,
    `  ids="$(docker ps -aq ${project} --filter "label=com.docker.compose.service=$s")" || exit 1`,
    `  if [ -n "$ids" ] || [ -e ${folder}/"$s" ] || { [ -e ${folder} ] && [ ! -x ${folder} ]; } || printf '%s\\n' "$volumes" | grep -q "^${app}_$s"_; then echo "data $s"; fi`,
    "done",
  ].join("\n");
}

/**
 * The services among `names` that have never run where the environment `deps` belong to keeps its
 * data: the app's servers, this computer or the user's Portainer. Every one on a cloud server whose
 * infrastructure the plan records no apply of ({@link hasDeployment}) never ran, with no server
 * reached. A hosting account's, and a service on none of the app's servers, are taken to have run.
 * @throws OpsCrewError when a machine can't be reached or its Docker does not answer.
 */
export async function neverRan(
  deps: PhaseDeps,
  names: readonly string[],
  services: SnapshotServices = {},
): Promise<string[]> {
  const run = await snapshotRun(deps, services);
  const { plan } = run;
  if (plan.target.provider === "hosting" || names.length === 0) return [];
  const target = snapshotTarget(run);
  if (target === "computer") {
    const project = localComposeProject(plan);
    const containers = await localDocker(deps, [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      '{{.Names}}|{{.State}}|{{.Label "com.docker.compose.service"}}',
    ]);
    const volumes = await localDocker(deps, ["volume", "ls", "--format", "{{.Name}}"]);
    return names.filter(
      (name) =>
        !containers.some((line) => line.split("|")[2] === name) &&
        !hasVolume(volumes, project, name),
    );
  }
  if (target === "portainer") {
    const place = await portainerPlace(run);
    const containers = await stackContainers(place);
    const volumes = await place.docker.listVolumes();
    return names.filter(
      (name) =>
        ofService(containers, name).length === 0 &&
        !hasVolume(
          volumes.map((volume) => volume.name),
          place.stack,
          name,
        ),
    );
  }
  // A cloud server OpsCrew never applied (the generated values of a `--plan-only` run) does not
  // exist yet, so nothing ran on it: reaching it would fail on every run, before the apply that
  // makes it. The user's own server exists whatever OpsCrew applied.
  if (isCloudTarget(plan.target) && !hasDeployment(plan)) {
    return names.filter((name) =>
      dataServers(plan).some((server) =>
        snapshotParts(plan, server).some((part) => part.name === name),
      ),
    );
  }
  const ran = new Set<string>();
  const probed: string[] = [];
  for (const server of dataServers(plan)) {
    const here = snapshotParts(plan, server)
      .map((part) => part.name)
      .filter((name) => names.includes(name));
    if (here.length === 0) continue;
    probed.push(...here);
    const { docker, login } = await serverShell(deps, plan, server, services);
    deps.redactor.addName(login.host, "server-address");
    const result = await docker.run(dataCommand(plan.app.name, here), {
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `OpsCrew could not read which of ${here.join(" and ")} ran on ${serverWords(server)} (exit code ${result.exitCode}).`,
        { hint: "Check that it is on and reachable (`opscrew status`), then try again." },
      );
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      const [word, name] = line.trim().split(" ");
      if (word === "data" && name !== undefined) ran.add(name);
    }
  }
  return names.filter((name) => probed.includes(name) && !ran.has(name));
}

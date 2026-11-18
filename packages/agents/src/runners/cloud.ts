/**
 * The server's runner on a server OpsCrew created (Hetzner, DigitalOcean, Contabo; plan.md "8."),
 * with the app's scheduled restore drills: the deploy login's host plan of the `drills` and
 * `github-runner` steps, read and applied over SSH as deploy (the deploy key and the pinned host
 * key), approved by its hash as `host-apply` (with `allowDestroy` and `<app>-drill` typed when the
 * drills step changes). The server's first boot made what needs root (the runner's libraries,
 * `/srv/runners`, deploy's lingering), so deploy has no sudo.
 */
import {
  applyHostPlan,
  type HostPlan,
  inspectRunners,
  planRunner,
  type RunnerFacts,
} from "@opscrew/connector-ssh-host";
import type { PhaseName, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, orText, upperFirst } from "@opscrew/core";
import { DRILLS_LOG, drillName, IMAGES } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { VPS_PROVIDERS } from "../providers";
import { desiredDrills, drillEnv } from "../provision/drills";
import type { ProvisionServices } from "../provision/types";
import { approveAndApplyHostPlan, type HostAdapterApi, type HostPlanOutcome } from "../shared";
import { deployShell } from "../status/certificates";
import { allowRunnerOn, lazyRepository, type RunnerRepository, runnerRepository } from "./github";
import { removeKeptRegistrations, runnerTokens, serverRunner } from "./server";
import { planWhere } from "./words";

/** The host adapter calls for the runner on a server OpsCrew created (the connector, or a fake). */
export interface CloudRunnerHost {
  /** Reads the runners and the server's architecture as deploy (`inspectRunners`). */
  inspect(remote: RemoteExec): Promise<RunnerFacts>;
  apply: HostAdapterApi["apply"];
}

/** The services the cloud runner uses: the deploy user's shell, the host adapter and GitHub. */
export type CloudRunnerServices = Pick<ProvisionServices, "remote" | "runnerHost" | "runnerGitHub">;

/**
 * What deploy reads of the runners on the server OpsCrew created, over SSH (read-only, audited
 * without the address), with the host adapter that read it; `undefined` when this computer cannot
 * reach the server (no address or deploy key here).
 */
async function readCloudRunners(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: CloudRunnerServices,
): Promise<{ facts: RunnerFacts; remote: RemoteExec; host: CloudRunnerHost } | undefined> {
  const remote = await deployShell(deps, plan, services);
  if (remote === undefined) return undefined;
  const host = services.runnerHost ?? { inspect: inspectRunners, apply: applyHostPlan };
  const facts = await host.inspect(remote);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the server's GitHub Actions runner as deploy (read-only)",
    target: "server",
    decision: "allow",
  });
  return { facts, remote, host };
}

/**
 * Before any change on a server OpsCrew creates, with `runner: server`: a server that already
 * exists must have the first boot's parts the runner needs (else the plain stop of
 * {@link unpreparedServer}); then the repository's check and, for a public repository, the fork-PR
 * policy's change after its own approval (FR-1527). Returns the repository, for
 * {@link applyCloudRunner} (none on another runner).
 */
export async function checkCloudRunner(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: CloudRunnerServices,
  run: { phase: PhaseName; command: string; planOnly: boolean },
): Promise<RunnerRepository | undefined> {
  if (plan.environment?.runner !== "server") return undefined;
  const read = await readCloudRunners(deps, plan, services);
  if (read !== undefined && !read.facts.prepared)
    throw await unpreparedServer(deps.paths.root, plan);
  const repository = await runnerRepository(deps, services.runnerGitHub);
  await allowRunnerOn(deps, repository, run);
  return repository;
}

/**
 * The deploy login's host plan on a server OpsCrew created, from what deploy reads there
 * ({@link readCloudRunners}): the runner installed when the plan asks for it, else removed when
 * the server has this app's runner; the scheduled restore drills installed with
 * `snapshots.drills.schedule`, else removed when the server has them (their copy's data in the
 * pinned busybox a drill uses itself). `undefined` when this computer cannot reach the server.
 * `repository` gives the repository the runner registers with, read only when the plan asks for
 * a runner.
 */
export async function cloudRunnerPlan(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: CloudRunnerServices,
  repository: () => Promise<Pick<RunnerRepository, "owner" | "repo">>,
): Promise<
  { plan: HostPlan; facts: RunnerFacts; remote: RemoteExec; host: CloudRunnerHost } | undefined
> {
  const read = await readCloudRunners(deps, plan, services);
  if (read === undefined) return undefined;
  const { facts, remote } = read;
  const runner =
    plan.environment?.runner === "server"
      ? serverRunner(
          plan,
          { arch: facts.arch === "arm64" ? "arm64" : "amd64", host: remote.host },
          await repository(),
        )
      : undefined;
  const drills = await desiredDrills(deps, plan);
  return {
    ...read,
    plan: planRunner(facts, {
      app: plan.app.name,
      drillImage: IMAGES.busybox.ref,
      ...(runner !== undefined ? { runner } : {}),
      ...(drills !== undefined ? { drills } : {}),
    }),
  };
}

/**
 * The stop for the server's runner on a server whose first boot did not prepare it (one created
 * before OpsCrew's first boot did, which later applies never change): deploy has no root to do it.
 */
async function unpreparedServer(root: string, plan: DeployPlan): Promise<OpsCrewError> {
  const { file, flag } = await planWhere(root, plan);
  const moves = VPS_PROVIDERS.filter((provider) => provider !== plan.target.provider).map(
    (provider) => `\`opscrew retarget --to ${provider}${flag}\``,
  );
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "This server was created before OpsCrew prepared its servers for a self-hosted runner: its first boot did not make /srv/runners for deploy or let deploy's services run without a login, and deploy has no root to do that now. Nothing was changed.",
    {
      hint: `Give the environment a new server: run \`opscrew destroy${flag}\` (it deletes the server and its data, after a snapshot when the server holds data), then \`opscrew provision${flag}\`. Or move the app to a new server at another provider with ${orText(moves)}, which moves its Postgres and Valkey with it. To keep this server, set environment.runner to github in ${file}.`,
    },
  );
}

/**
 * On a server OpsCrew created, from what deploy reads there: the server's runner installed
 * (`runner: server`), or removed when the plan says `github` and the server has this app's runner
 * (a switch back to GitHub's machines, made on any computer), and the app's scheduled restore
 * drills installed (`snapshots.drills.schedule`) or removed, through
 * {@link approveAndApplyHostPlan} (shown, approved by its hash as `host-apply`, with
 * `allowDestroy` and `<app>-drill` typed when the drills step changes, applied as deploy with a
 * GitHub token fetched only while the runner's step runs and `.env.preview`'s values sent only to
 * the drills step). A registration GitHub kept after a removal is deleted through its API.
 * `undefined` when there is nothing to install or remove; with `planOnly` the plan is only shown
 * and saved, or skipped with a note while the server does not exist yet.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer cannot reach the server, or before
 * any change when the server's first boot did not prepare the runner.
 */
export async function applyCloudRunner(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    services: CloudRunnerServices;
    phase: PhaseName;
    command: string;
    planOnly?: boolean;
    /** The repository {@link checkCloudRunner} read; otherwise read when a removal needs it. */
    repository?: RunnerRepository | undefined;
  },
): Promise<HostPlanOutcome | undefined> {
  const { plan, services, command } = input;
  const installs = plan.environment?.runner === "server";
  const drills = plan.snapshots?.drills?.schedule !== undefined;
  const repo = lazyRepository(deps, services.runnerGitHub, input.repository);
  const planned = await cloudRunnerPlan(deps, plan, services, repo);
  if (planned === undefined) {
    // Without the server's address there is no runner or drill of this computer's to remove either.
    if (!installs && !drills) return undefined;
    if (input.planOnly === true) {
      deps.reporter.info(
        installs
          ? "The server's runner has a host plan of its own, shown once the server exists (approve it then, or name its hash with --approve)."
          : "The server's restore drills have a host plan of their own, shown once the server exists (approve it then, or name its hash with --approve).",
      );
      return undefined;
    }
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This computer does not know the server's address or has no deploy key, so OpsCrew cannot reach the server's ${installs ? "runner" : "restore drills"}. Nothing on the server was changed.`,
      { hint: `Run \`${command}\` on the computer that created the server.` },
    );
  }
  // Nothing of this app's for deploy on the server, and nothing planned: nothing to show.
  if (planned.plan.steps.length === 0) return undefined;
  if (installs && !planned.facts.prepared) throw await unpreparedServer(deps.paths.root, plan);
  const changes = planned.plan.steps.filter((step) => step.state === "change");
  const drillsStep = changes.find((step) => step.id === "drills");
  const removesDrills = drillsStep?.params.remove === true;
  const parts = [
    ...(changes.some((step) => step.id === "github-runner")
      ? [installs ? "install the GitHub Actions runner" : "remove the GitHub Actions runner"]
      : []),
    ...(drillsStep === undefined
      ? []
      : [removesDrills ? "remove the scheduled restore drills" : "schedule the restore drills"]),
  ].join(" and ");
  const outcome = await approveAndApplyHostPlan(deps, {
    plan: planned.plan,
    remote: planned.remote,
    apply: planned.host.apply,
    // The runner's and the drills' steps change no SSH or firewall setting.
    verifyLogin: async () => true,
    title:
      drillsStep !== undefined
        ? `${upperFirst(parts)} on the server, run as deploy`
        : installs
          ? "Install the GitHub Actions runner on the server, run as deploy"
          : "Remove the GitHub Actions runner from the server",
    server: "the server",
    upToDate: !installs
      ? "The server's restore drills are scheduled as planned; nothing on the server changes."
      : drills
        ? "The server's runner and its restore drills are as planned; nothing on the server changes."
        : "The server's runner is installed and running as planned; nothing on the server changes.",
    command,
    phase: input.phase,
    // The scheduled drills delete their copy's data each run (and their removal a kept copy): the
    // plan is approved as a destroy, with the copy's name typed.
    ...(drillsStep !== undefined
      ? { allowDestroy: true, confirmPhrase: drillName(plan.app.name) }
      : {}),
    ...(input.planOnly === true ? { planOnly: true } : {}),
    // The drill's values, when its step installs them: on stdin only, checked by their SHA-256.
    secrets: async (steps) =>
      steps.some((step) => step.id === "drills" && step.params.remove !== true)
        ? { previewValues: (await drillEnv(deps, plan)).values }
        : {},
    runnerToken: runnerTokens(deps, repo),
    applying:
      drillsStep !== undefined
        ? `Applying the host plan to the server as deploy (${parts})`
        : installs
          ? "Installing the GitHub Actions runner on the server"
          : "Removing the GitHub Actions runner from the server",
  });
  if (!outcome.applied) return outcome;
  if (outcome.stillRegistered !== undefined) {
    await removeKeptRegistrations(deps, repo, plan, {
      phase: input.phase,
      stillRegistered: outcome.stillRegistered,
      host: planned.remote.host,
    });
  }
  if (outcome.steps.includes("github-runner")) {
    deps.reporter.success(
      installs
        ? "The server's runner is installed; the deploy job runs on the server now."
        : "The server's runner is removed; the deploy job no longer runs on the server.",
    );
  }
  if (outcome.steps.includes("drills")) {
    deps.reporter.success(
      removesDrills
        ? "The server's scheduled restore drills are removed."
        : `The server's restore drills are scheduled; each drill writes its line to ${DRILLS_LOG} there, which opscrew status shows.`,
    );
  }
  return outcome;
}

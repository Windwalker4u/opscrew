/**
 * The runner's host adapter on a server OpsCrew created, as the cloud runner tests answer it: the
 * runners deploy reads there, and an apply that refuses another plan than the approved one, asks
 * for the runner's token only when its step runs, and leaves the runner installed or removed.
 */
import {
  type ApplyOptions,
  type ApplyResult,
  type HostPlan,
  hostPlanHash,
  type RunnerFacts,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { sha256Hex } from "@opscrew/core";
import type { CloudRunnerHost } from "../cloud";

/** A fake of {@link CloudRunnerHost} that records every inspection and apply. */
export class FakeCloudRunnerHost implements CloudRunnerHost {
  /** A server OpsCrew created whose first boot prepared the runner's root parts. */
  facts: RunnerFacts = { arch: "amd64", runners: [], drills: [], prepared: true };
  inspections = 0;
  readonly applies: { remote: RemoteExec; plan: HostPlan; options: ApplyOptions }[] = [];
  /** Every runner token the step got, in order. */
  readonly tokens: string[] = [];
  /** A removal leaves GitHub's registration (`config.sh remove` failed). */
  keepsRegistration = false;

  // Arrow functions: the flow passes `inspect` and `apply` on as plain functions, as the
  // connector's are.
  inspect = async (_remote: RemoteExec): Promise<RunnerFacts> => {
    this.inspections++;
    return this.facts;
  };

  apply = async (remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> => {
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    this.applies.push({ remote, plan, options });
    // The drills step: installed or removed as planned (the files' hashes, the values' hash).
    const drills = plan.steps.find((item) => item.id === "drills" && item.state === "change");
    if (drills !== undefined) {
      const app = String(drills.params.app);
      const others = this.facts.drills.filter((item) => item.app !== app);
      const files = Object.fromEntries(
        Object.entries(drills.params).flatMap(([key, text]) =>
          key.startsWith("file:") ? [[key.slice("file:".length), sha256Hex(String(text))]] : [],
        ),
      );
      const installed = {
        app,
        recipe: true,
        files,
        values: { mode: "600", sha256: String(drills.params.valuesSha256) },
        // The deploy user's line, as the connector's drillCronLine writes it.
        cron: [
          `30 * * * * sh /srv/apps/${app}/snapshot.sh drill scheduled > /dev/null 2>&1 # opscrew-drill ${app}`,
        ],
        left: false,
      };
      this.facts = {
        ...this.facts,
        drills: drills.params.remove === true ? others : [...others, installed],
      };
    }
    const step = plan.steps.find((item) => item.id === "github-runner" && item.state === "change");
    if (step === undefined) {
      const applied = drills === undefined ? [] : ["drills" as const];
      return {
        applied,
        skipped: plan.steps.map((item) => item.id).filter((id) => !applied.includes(id as "drills")),
      };
    }
    if (options.runnerToken === undefined) throw new Error("no runner token callback");
    const removes = step.params.remove === true;
    this.tokens.push(await options.runnerToken(removes ? "remove" : "registration"));
    const app = String(step.params.app);
    const others = this.facts.runners.filter((runner) => runner.app !== app);
    const installed = {
      app,
      registered: true,
      active: true,
      unitCurrent: true,
      version: String(step.params.version),
      label: String(step.params.label),
      repositoryUrl: String(step.params.repositoryUrl),
    };
    this.facts = { ...this.facts, runners: removes ? others : [...others, installed] };
    return {
      applied: drills === undefined ? ["github-runner"] : ["drills", "github-runner"],
      skipped: [],
      ...(removes && this.keepsRegistration ? { stillRegistered: [app] } : {}),
    };
  };
}

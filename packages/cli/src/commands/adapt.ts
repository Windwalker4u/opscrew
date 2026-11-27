import { type AdaptResult, runAdapt } from "@opscrew/agents";
import { environmentsOf } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, MODEL_SETUP_HINT, modelOption, servicesOf } from "../deps";
import { resolveCliApp } from "../ui/app";
import { addEnvOption, chooseEnvironment } from "../ui/environment";
import { printCosts, printNextSteps } from "../ui/output";

interface AdaptFlags {
  /** `--app <key>`: the repository's app. */
  app?: string;
  /** `--env <name>`: the app's environment whose plan adapt reads and updates. */
  env?: string;
  ai: boolean;
  push: boolean;
  model?: string;
  yes?: boolean;
}

/** The next steps after `adapt`; `flag` is the app's `--app`. */
function nextSteps(result: AdaptResult, manualCount: number, flag: string): string[] {
  const steps: string[] = [];
  if (manualCount > 0) steps.push("make the changes listed above by hand and commit them.");
  if (result.pullRequest !== undefined) {
    steps.push(
      `review and merge pull request #${result.pullRequest.number} (${result.pullRequest.url}).`,
    );
  } else if (result.pushed) {
    steps.push(`open a pull request for ${result.branch}, review it and merge it.`);
  } else if (result.committed) {
    const push = result.pushCommand ?? `git push -u origin ${result.branch}`;
    steps.push(`push ${result.branch} (\`${push}\`) and open a pull request.`);
  } else if (result.changes.some((change) => change.status !== "pending")) {
    steps.push(`review the changes on ${result.branch} with \`git diff\` and commit them.`);
  }
  steps.push(
    `${steps.length === 0 ? "run" : "then run"} \`opscrew provision${flag}\` to create the server.`,
  );
  return steps;
}

/**
 * `opscrew adapt`: on a new branch, writes the missing deterministic files (Dockerfile,
 * `.dockerignore`, `.env.example`), runs the Code-change agent for the other planned changes when a
 * model is configured, and commits, pushes and opens a pull request, each after approval (FR-108).
 * `--app` picks the repository's app.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("adapt")
    .description("Adapt the app for self-hosting (Dockerfile, config, CI workflow)")
    .option("--no-ai", "Do not run the Code-change agent; list the remaining changes instead")
    .option("--no-push", "Commit locally but do not push or open a pull request")
    .option(
      "--yes",
      "In a non-interactive run, approve writing, committing, pushing and the pull request",
    )
    .option(
      "--model <id>",
      "Model for the Code-change agent (default claude-opus-5-5 or gpt-6.2-sol, or OPSCREW_MODEL)",
    );
  addEnvOption(command).action(async (flags: AdaptFlags) => {
    const model = modelOption(ctx, flags.model);
    const appKey = await resolveCliApp(ctx, flags.app, "adapt");
    const requested = flags.env?.trim() || undefined;
    // Keep bare `opscrew adapt` targeting `prod` whenever `prod` exists (including multi-env apps),
    // and only fall back to another environment when `prod` does not exist yet.
    const env =
      requested === undefined && (await environmentsOf(ctx.cwd, appKey)).includes("prod")
        ? "prod"
        : requested;
    const { app, name, flag } = await chooseEnvironment(ctx, { ...flags, env }, "adapt");
    const deps = createPhaseDeps(ctx, {
      ai: flags.ai,
      app,
      environment: name,
      ...(model === undefined ? {} : { model }),
      ...(flags.yes === true ? { assumeYes: true } : {}),
    });
    const { github } = servicesOf(ctx);
    const result = await runAdapt(deps, {
      ai: flags.ai,
      push: flags.push,
      ...(model === undefined ? {} : { model }),
      ...(github === undefined ? {} : { github }),
    });
    if (result.aiRan) {
      ctx.stdout("\n");
      await printCosts(ctx, deps, result.costUsd);
    }
    if (flags.ai && deps.runtime === undefined && result.manual.length > 0) {
      ctx.stdout(`\n${MODEL_SETUP_HINT}\n`);
    }
    printNextSteps(ctx, nextSteps(result, result.manual.length, flag));
  });
}

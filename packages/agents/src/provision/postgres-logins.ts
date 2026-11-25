/**
 * Provision and PostgreSQL's two logins (047, ADR 0037, research R11): the notice for a deployed
 * database without them, the refusals, and the switch of an existing database, which provision
 * shows in a plan approved by its hash and goes on with only after a snapshot of the database.
 */
import { canonicalJson, errorText, OpsCrewError, sha256Hex, toPosixRelative } from "@opscrew/core";
import { type SnapshotPart, snapshotParts } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type PlanService,
  postgresLogins,
} from "@opscrew/plan-schema";
import { parse } from "yaml";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { loginsUpgradeNotice, loginsVersion } from "../design/postgres-logins";
import { planFile } from "../runners/words";
import { requestApproval } from "../shared/approvals";

/** The PostgreSQLs of a plan file as the switch reads them: their names and whether they have logins. */
const CommittedSchema = z.looseObject({
  services: z
    .array(
      z.looseObject({
        name: z.string(),
        kind: z.string(),
        options: z.looseObject({ logins: z.unknown().optional() }).optional(),
      }),
    )
    .optional(),
});

/**
 * The PostgreSQLs of the plan committed at `HEAD`, by name, each with whether it has
 * `logins: separate`; `undefined` when `HEAD` has no plan file (or none OpsCrew can read).
 */
export async function committedLogins(
  deps: Pick<PhaseDeps, "paths" | "runner">,
): Promise<Map<string, boolean> | undefined> {
  const file = toPosixRelative(deps.paths.root, deps.paths.files.plan);
  const shown = await deps.runner.run("git", ["-C", deps.paths.root, "show", `HEAD:${file}`]);
  if (shown.exitCode !== 0) return undefined;
  let text: unknown;
  try {
    text = parse(shown.stdout);
  } catch {
    return undefined;
  }
  const committed = CommittedSchema.safeParse(text);
  if (!committed.success) return undefined;
  return new Map(
    (committed.data.services ?? [])
      .filter((service) => service.kind === "postgres")
      .map((service) => [service.name, service.options?.logins === "separate"]),
  );
}

/** The enabled PostgreSQLs of `plan`. */
function postgresOf(plan: DeployPlan): PlanService[] {
  return plan.services.filter((service) => service.enabled && service.kind === "postgres");
}

/** True when the environment has been deployed (`deployment.firstDeployAt`). */
function deployed(plan: DeployPlan): boolean {
  return plan.deployment.firstDeployAt !== undefined;
}

/**
 * Stops (`INVALID_INPUT`, before any change) when a PostgreSQL below 15 has `logins: separate`, or
 * a deployed one whose committed plan (`committed`, {@link committedLogins}) has it lost it, with
 * data-model.md's messages. A PostgreSQL below 15 without the field is never refused.
 */
export function requireLogins(
  plan: DeployPlan,
  committed: ReadonlyMap<string, boolean> | undefined,
  command: string,
): void {
  const again = { hint: `Then run \`${command}\` again.` };
  for (const service of plan.services.filter((s) => s.kind === "postgres")) {
    if (postgresLogins(service) && !loginsVersion(service.version)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `PostgreSQL ${service.version} can't use separate logins (OpsCrew's setup needs psql 15 or later). Upgrade ${service.name} to 17 first, then add \`logins: separate\`. Nothing was changed.`,
        again,
      );
    }
    if (deployed(plan) && committed?.get(service.name) === true && !postgresLogins(service)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The database ${service.name} already has separate logins for the app and its migrations, and OpsCrew can't give the app the superuser again. Put \`logins: separate\` back under its options in ${planFile(plan)}. Nothing was changed.`,
        again,
      );
    }
  }
}

/**
 * Provision's notice for each deployed PostgreSQL without its own logins (data-model.md): how to
 * switch it, or below 15 that separate logins come with an upgrade. None before the first deploy.
 */
export function loginsNotices(plan: DeployPlan, command: string): string[] {
  if (!deployed(plan)) return [];
  return postgresOf(plan)
    .filter((service) => !postgresLogins(service))
    .map((service) =>
      loginsVersion(service.version)
        ? `Your app logs in to PostgreSQL (${service.name}) as its superuser. To give it a login that can only read and write data, add \`logins: separate\` under ${service.name}'s options in ${planFile(plan)} and run \`npx ${command}\`: it shows the switch before anything changes.`
        : loginsUpgradeNotice(service),
    );
}

/** The switch of existing databases to their own logins: which, its plan's lines and its hash. */
export interface LoginsSwitch {
  /** The PostgreSQLs that switch, by name. */
  services: string[];
  lines: string[];
  hash: string;
}

/**
 * The switch provision shows for a deployed environment (research R11): the PostgreSQLs that have
 * `logins: separate` while the plan committed at `HEAD` has them without it, each with
 * data-model.md's four lines, and the hash that binds them; none when nothing switches.
 */
export function loginsSwitch(
  plan: DeployPlan,
  committed: ReadonlyMap<string, boolean> | undefined,
  environment: string,
): LoginsSwitch | undefined {
  if (!deployed(plan) || committed === undefined) return undefined;
  const services = postgresOf(plan)
    .filter((service) => postgresLogins(service) && committed.get(service.name) === false)
    .map((service) => service.name);
  if (services.length === 0) return undefined;
  const lines = services.flatMap((name) => [
    `Take a snapshot of ${name} now.`,
    `${name} restarts once (a few seconds) with two new passwords.`,
    "The next deploy creates app_owner and app_runtime and gives app_owner the app's tables, in one transaction. If it fails, nothing changes and the app keeps its current login.",
    "From that deploy, the release command logs in as app_owner, and the app, workers and cron as app_runtime.",
  ]);
  const hash = sha256Hex(
    canonicalJson({ switch: "postgres-logins", app: plan.app.name, environment, services, lines }),
  );
  return { services, lines, hash };
}

/** Takes a snapshot of the environment's data with the parts `skip` names left out. */
export type LoginsSnapshot = (skip: readonly string[]) => Promise<unknown>;

/**
 * Provision's step for PostgreSQL's two logins, before anything else changes: the refusals
 * ({@link requireLogins}), the notices ({@link loginsNotices}), then a switch's plan
 * ({@link loginsSwitch}). With `planOnly` that plan is shown with its hash and nothing more;
 * otherwise it is approved by its hash (`iac-apply`; `--approve <hash>` in a script), then the
 * switching databases' snapshot is taken (`snapshot`, their parts alone). Returns the switch's
 * hash, which no other plan of the run is.
 * @throws OpsCrewError `INVALID_INPUT` for a refusal, `APPROVAL_REFUSED` when the switch is not
 * approved, `COMMAND_FAILED` when the snapshot fails, each with nothing changed.
 */
export async function postgresLoginsStep(
  deps: Pick<PhaseDeps, "paths" | "runner" | "reporter" | "approvals">,
  plan: DeployPlan,
  o: { command: string; planOnly?: boolean | undefined; snapshot: LoginsSnapshot },
): Promise<string | undefined> {
  if (!plan.services.some((service) => service.kind === "postgres")) return undefined;
  const committed = await committedLogins(deps);
  requireLogins(plan, committed, o.command);
  for (const notice of loginsNotices(plan, o.command)) deps.reporter.info(notice);
  const change = loginsSwitch(plan, committed, deps.paths.environment);
  if (change === undefined) return undefined;
  const title = `Switch ${change.services.join(" and ")} to separate logins for the app and its migrations`;
  const details = [...change.lines, `Switch hash: ${change.hash}`].join("\n");
  if (o.planOnly === true) {
    deps.reporter.info(
      `${title}:\n${details}\nIn a script, approve it with --approve ${change.hash}.`,
    );
    return change.hash;
  }
  await requestApproval(deps, {
    kind: "iac-apply",
    title,
    details,
    hash: change.hash,
    refused: {
      plan: "switch to separate logins",
      unchanged: "Nothing was changed.",
      again: o.command,
    },
  });
  await deps.approvals.assertApprovedPlan(change.hash);
  const switching = new Set(change.services);
  const skip = dataParts(plan)
    .map((part) => part.name)
    .filter((name) => !switching.has(name));
  deps.reporter.step(`Taking a snapshot of ${change.services.join(" and ")} before the switch`);
  try {
    await o.snapshot(skip);
  } catch (error) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The snapshot of ${change.services.join(" and ")} before the switch to separate logins failed: ${errorText(error)} Nothing was changed.`,
      {
        hint: `Fix what it names (\`opscrew snapshot\` takes one on its own), then run \`${o.command}\` again; it asks for the switch again.`,
        cause: error,
      },
    );
  }
  return change.hash;
}

/** Every part a snapshot of `plan`'s data has, on each of its servers. */
function dataParts(plan: DeployPlan): SnapshotPart[] {
  const servers = [APP_SERVER, ...(plan.servers ?? []).map((server) => server.name)];
  return servers.flatMap((server) => snapshotParts(plan, server));
}

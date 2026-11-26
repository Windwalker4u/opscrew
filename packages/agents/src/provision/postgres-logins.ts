/**
 * Provision and PostgreSQL's two logins (047, ADR 0037, research R11): the notice for an existing
 * database without them, the refusals, and the switch of an existing database, which provision
 * shows in a plan approved by its hash and goes on with only after a snapshot of the database (or
 * once it finds the database never ran, so has no data to copy). An existing database is one whose
 * superuser's password this environment's generated values keep: whether `opscrew verify` saw a
 * deploy does not count, as the localhost target and a deploy by CI never run it.
 */
import {
  canonicalJson,
  errorText,
  OpsCrewError,
  readTextIfExists,
  sha256Hex,
  writeFileAtomic,
} from "@opscrew/core";
import {
  POSTGRES_LOGINS,
  POSTGRES_OWNER_SECRET,
  type SnapshotPart,
  snapshotParts,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type PlanService,
  postgresLogins,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { loginsUpgradeNotice, loginsVersion } from "../design/postgres-logins";
import { readStrict } from "../rotate/values-pending";
import { planFile } from "../runners/words";
import type { GeneratedValues } from "../shared/app-env";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { requestApproval } from "../shared/approvals";

/** This environment's generated values as the switch reads them (only provision writes them). */
export type KeptLogins = Pick<GeneratedValues, "dbPassword" | "services">;

/**
 * This environment's generated values (none without the file), which tell a switch and a removal
 * apart from a database made with its logins whatever the plan's history in git says.
 * @throws OpsCrewError `ARTIFACT_INVALID` when they are damaged.
 */
async function keptLogins(deps: Pick<PhaseDeps, "paths">): Promise<KeptLogins> {
  return (await readStrict(generatedValuesFile(deps), GeneratedValuesSchema)) ?? {};
}

/** True when this environment keeps `service`'s owner password: its database has the two logins. */
function ownerKept(kept: KeptLogins, service: PlanService): boolean {
  return kept.services?.[service.name]?.[POSTGRES_OWNER_SECRET] !== undefined;
}

/**
 * Forgets the two logins' passwords of the databases `services` from this environment's generated
 * values. A `--plan-only` run that shows their switch renders the rest of the plan with new ones,
 * and keeping them would make the run that approves the switch take the database for switched
 * ({@link ownerKept}), with no snapshot first. That run makes them again, after the snapshot.
 */
export async function forgetSwitchPasswords(
  deps: Pick<PhaseDeps, "paths">,
  services: readonly string[],
): Promise<void> {
  const file = generatedValuesFile(deps);
  const text = await readTextIfExists(file);
  if (text === undefined) return;
  const values = JSON.parse(text) as { services?: Record<string, Record<string, unknown>> };
  for (const name of services) {
    const secrets = values.services?.[name];
    if (secrets === undefined) continue;
    for (const secret of POSTGRES_LOGINS.secrets) delete secrets[secret.name];
    if (Object.keys(secrets).length === 0) delete values.services?.[name];
  }
  await writeFileAtomic(file, `${JSON.stringify(values)}\n`);
}

/** The enabled PostgreSQLs of `plan`. */
function postgresOf(plan: DeployPlan): PlanService[] {
  return plan.services.filter((service) => service.enabled && service.kind === "postgres");
}

/**
 * Stops (`INVALID_INPUT`, before any change) when a PostgreSQL below 15 has `logins: separate`, or
 * one whose owner password this environment keeps (`kept`, {@link keptLogins}) lost it, with
 * data-model.md's messages. A PostgreSQL below 15 without the field is never refused.
 */
export function requireLogins(plan: DeployPlan, kept: KeptLogins, command: string): void {
  const again = { hint: `Then run \`${command}\` again.` };
  for (const service of plan.services.filter((s) => s.kind === "postgres")) {
    if (postgresLogins(service) && !loginsVersion(service.version)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `PostgreSQL ${service.version} can't use separate logins (OpsCrew's setup needs psql 15 or later). Upgrade ${service.name} to 17 first, then add \`logins: separate\`. Nothing was changed.`,
        again,
      );
    }
    if (ownerKept(kept, service) && !postgresLogins(service)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The database ${service.name} already has separate logins for the app and its migrations, and OpsCrew can't give the app the superuser again. Put \`logins: separate\` back under its options in ${planFile(plan)}. Nothing was changed.`,
        again,
      );
    }
  }
}

/**
 * Provision's notice for each existing PostgreSQL without its own logins (data-model.md), one whose
 * superuser's password this environment keeps (`kept`, {@link keptLogins}): how to switch it, or
 * below 15 that separate logins come with an upgrade. None for a new database.
 */
export function loginsNotices(plan: DeployPlan, kept: KeptLogins, command: string): string[] {
  if (kept.dbPassword === undefined) return [];
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
 * The switch provision shows (research R11): the PostgreSQLs that have `logins: separate` while this
 * environment keeps (`kept`, {@link keptLogins}) their superuser's password but not their owner's,
 * each with data-model.md's five lines, and the hash that binds them; none when nothing switches.
 */
export function loginsSwitch(
  plan: DeployPlan,
  kept: KeptLogins,
  environment: string,
): LoginsSwitch | undefined {
  if (kept.dbPassword === undefined) return undefined;
  const services = postgresOf(plan)
    .filter((service) => postgresLogins(service) && !ownerKept(kept, service))
    .map((service) => service.name);
  if (services.length === 0) return undefined;
  const lines = services.flatMap((name) => [
    `Take a snapshot of ${name} now.`,
    `${name} restarts once (a few seconds) with two new passwords.`,
    "The next deploy creates app_owner and app_runtime and gives app_owner the app's tables, in one transaction. If it fails, nothing changes and the app keeps its current login.",
    "A database with event triggers is refused: remove them with DROP EVENT TRIGGER first.",
    "From that deploy, the release command logs in as app_owner, and the app, workers and cron as app_runtime.",
  ]);
  const hash = sha256Hex(
    canonicalJson({ switch: "postgres-logins", app: plan.app.name, environment, services, lines }),
  );
  return { services, lines, hash };
}

/** The snapshot a switch takes first. */
export interface LoginsSnapshot {
  /**
   * The services among `names` that never ran where the environment keeps its data (no container
   * and no volume of theirs), so have no data to copy.
   */
  neverRan(names: readonly string[]): Promise<readonly string[]>;
  /** Takes a snapshot of the environment's data with the parts `skip` names left out. */
  take(skip: readonly string[]): Promise<unknown>;
}

/**
 * Provision's step for PostgreSQL's two logins, before anything else changes: the refusals
 * ({@link requireLogins}), the notices ({@link loginsNotices}), then a switch's plan
 * ({@link loginsSwitch}). With `planOnly` that plan is shown with its hash and nothing more;
 * otherwise it is approved by its hash (`iac-apply`; `--approve <hash>` in a script), then the
 * switching databases' snapshot is taken (`snapshot`, their parts alone), each that never ran left
 * out with a line that it has no data yet. Returns the switch, whose hash no other plan of the run
 * is.
 * @throws OpsCrewError `INVALID_INPUT` for a refusal, `APPROVAL_REFUSED` when the switch is not
 * approved, `COMMAND_FAILED` when the snapshot fails, each with nothing changed.
 */
export async function postgresLoginsStep(
  deps: Pick<PhaseDeps, "paths" | "reporter" | "approvals">,
  plan: DeployPlan,
  o: { command: string; planOnly?: boolean | undefined; snapshot: LoginsSnapshot },
): Promise<LoginsSwitch | undefined> {
  if (!plan.services.some((service) => service.kind === "postgres")) return undefined;
  const kept = await keptLogins(deps);
  requireLogins(plan, kept, o.command);
  for (const notice of loginsNotices(plan, kept, o.command)) deps.reporter.info(notice);
  const change = loginsSwitch(plan, kept, deps.paths.environment);
  if (change === undefined) return undefined;
  const title = `Switch ${change.services.join(" and ")} to separate logins for the app and its migrations`;
  const details = [...change.lines, `Switch hash: ${change.hash}`].join("\n");
  if (o.planOnly === true) {
    deps.reporter.info(
      `${title}:\n${details}\nIn a script, approve it with --approve ${change.hash}.`,
    );
    return change;
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
  try {
    const empty = new Set(await o.snapshot.neverRan(change.services));
    for (const name of empty) {
      deps.reporter.info(`${name} has no data yet, so there's nothing to snapshot.`);
    }
    const copied = new Set(change.services.filter((name) => !empty.has(name)));
    if (copied.size > 0) {
      const skip = dataParts(plan)
        .map((part) => part.name)
        .filter((name) => !copied.has(name));
      deps.reporter.step(`Taking a snapshot of ${[...copied].join(" and ")} before the switch`);
      await o.snapshot.take(skip);
    }
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
  return change;
}

/** Every part a snapshot of `plan`'s data has, on each of its servers. */
function dataParts(plan: DeployPlan): SnapshotPart[] {
  const servers = [APP_SERVER, ...(plan.servers ?? []).map((server) => server.name)];
  return servers.flatMap((server) => snapshotParts(plan, server));
}

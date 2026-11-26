/**
 * Provision and PostgreSQL extensions (feature 045):
 * - refuses PostGIS on `arm64` servers before anything changes;
 * - detects when an existing provisioned PostgreSQL service's image repository changes (for example
 *   from `postgres:17-alpine` to `pgvector/pgvector:0.8.7-pg17-trixie` or `postgis/postgis:17-3.7-alpine`),
 *   shows the image switch plan bound to its SHA-256 hash (noting the snapshot, container restart,
 *   and on Alpine <-> Debian switches that `REINDEX DATABASE` + collation refresh can take a while
 *   on a large database), takes a snapshot of the switching database first (skipping databases that
 *   never ran), and aborts cleanly with nothing changed if the snapshot fails.
 */
import { join } from "node:path";
import { canonicalJson, errorText, OpsCrewError, readTextIfExists, sha256Hex } from "@opscrew/core";
import {
  runtimeDir,
  type SnapshotPart,
  serviceImageRef,
  snapshotParts,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type PlanService,
  postgresExtensions,
  targetArch,
} from "@opscrew/plan-schema";
import { parse } from "yaml";
import type { PhaseDeps } from "../context";
import { requirePostgisArch } from "../design/postgres-extensions";
import { readStrict } from "../rotate/values-pending";
import { planFile } from "../runners/words";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { requestApproval } from "../shared/approvals";
import type { KeptLogins, LoginsSnapshot } from "./postgres-logins";

/** Image repository and tag (without `@sha256:...`) extracted from an image reference. */
interface ImageIdentity {
  repo: string;
  label: string;
  /** True for Debian/glibc images (`pgvector/pgvector`); false for Alpine/musl (`postgres`, `postgis/postgis`). */
  glibc: boolean;
}

/** Parses `repo:tag[@sha256:...]` into its repository, readable `repo:tag` label, and libc family. */
function parseImageIdentity(ref: string): ImageIdentity | undefined {
  const trimmed = ref.trim();
  if (trimmed === "") return undefined;
  const withoutDigest = trimmed.includes("@") ? trimmed.slice(0, trimmed.indexOf("@")) : trimmed;
  const colon = withoutDigest.lastIndexOf(":");
  const slash = withoutDigest.lastIndexOf("/");
  const repo = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  const tag = colon > slash ? withoutDigest.slice(colon + 1) : "";
  const glibc = repo === "pgvector/pgvector" || (!tag.includes("alpine") && repo === "postgres");
  return { repo, label: withoutDigest, glibc };
}

/** The Compose file in the repository that currently holds `service`'s committed image pin. */
function committedComposePath(root: string, plan: DeployPlan, service: PlanService): string {
  const dir = runtimeDir(plan);
  return service.server === undefined
    ? join(root, dir, "compose.yaml")
    : join(root, dir, "servers", service.server, "compose.yaml");
}

/** Reads the committed image reference for each enabled PostgreSQL service from the repo's Compose files. */
export async function readCommittedPostgresImages(
  root: string,
  plan: DeployPlan,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const cache = new Map<string, Record<string, { image?: unknown }> | undefined>();
  for (const service of plan.services) {
    if (!service.enabled || service.kind !== "postgres") continue;
    const file = committedComposePath(root, plan, service);
    if (!cache.has(file)) {
      const text = await readTextIfExists(file);
      if (text === undefined) {
        cache.set(file, undefined);
      } else {
        try {
          const parsed = parse(text) as { services?: Record<string, { image?: unknown }> } | null;
          cache.set(file, parsed?.services);
        } catch {
          cache.set(file, undefined);
        }
      }
    }
    const image = cache.get(file)?.[service.name]?.image;
    if (typeof image === "string" && image.trim() !== "") {
      result[service.name] = image.trim();
    }
  }
  return result;
}

/** Architecture of the server `service` runs on according to `plan`. */
function serverArchFor(
  plan: DeployPlan,
  service: PlanService,
): {
  arch: "amd64" | "arm64";
  where: string;
} {
  if (service.server === undefined) {
    return {
      arch: targetArch(plan.target),
      where: plan.target.provider === "portainer" ? "your Portainer host" : "your server",
    };
  }
  const extra = plan.servers?.find((server) => server.name === service.server);
  const arch = extra?.target.provider === "own" ? extra.target.arch : "amd64";
  return { arch, where: `server ${service.server}` };
}

/**
 * Refuses any enabled PostgreSQL service requesting PostGIS on an `arm64` server before anything
 * changes.
 */
export function requireExtensionsArch(plan: DeployPlan, command: string): void {
  const file = planFile(plan);
  for (const service of plan.services) {
    if (!service.enabled || service.kind !== "postgres") continue;
    const { arch, where } = serverArchFor(plan, service);
    requirePostgisArch([service], arch, where, {
      planFile: file,
      command,
      unchanged: "Nothing was changed.",
    });
  }
}

/** One PostgreSQL service whose image repository changes on an existing database. */
export interface PostgresImageSwitchItem {
  service: string;
  from: string;
  to: string;
  reindexes: boolean;
}

/** The switch of existing PostgreSQL services to a different extension image, with its plan and hash. */
export interface ExtensionsSwitch {
  /** The PostgreSQL services whose image repository changes, by name. */
  services: string[];
  changes: PostgresImageSwitchItem[];
  lines: string[];
  hash: string;
}

/**
 * Computes the image-switch plan for existing provisioned PostgreSQL services whose resolved image
 * repository (`postgres`, `pgvector/pgvector`, `postgis/postgis`) differs from their committed
 * Compose image. Returns `undefined` for a brand-new database (`kept.dbPassword === undefined`),
 * when no committed image exists yet, or when only built-in `contrib` extensions are added on the
 * same image.
 */
export function extensionsSwitch(
  plan: DeployPlan,
  kept: KeptLogins,
  committedImages: Readonly<Record<string, string>>,
  environment: string,
): ExtensionsSwitch | undefined {
  if (kept.dbPassword === undefined) return undefined;
  const changes: PostgresImageSwitchItem[] = [];
  const lines: string[] = [];
  for (const service of plan.services) {
    if (!service.enabled || service.kind !== "postgres") continue;
    const committedRef = committedImages[service.name];
    if (committedRef === undefined) continue;
    const from = parseImageIdentity(committedRef);
    const to = parseImageIdentity(serviceImageRef(service));
    if (from === undefined || to === undefined || from.repo === to.repo) continue;
    const reindexes = from.glibc !== to.glibc;
    changes.push({ service: service.name, from: from.label, to: to.label, reindexes });

    const exts = postgresExtensions(service);
    const extList = exts.join(", ");
    lines.push(`Take a snapshot of ${service.name} now.`);
    lines.push(
      `${service.name}'s image switches from ${from.label} to ${to.label}, so ${service.name} restarts once.`,
    );
    if (reindexes) {
      lines.push(
        `The next deploy reindexes ${service.name} and refreshes its collation version (moving between Alpine and Debian; reindexing can take a while on a large database)${exts.length > 0 ? `, then creates the extensions (${extList})` : ""}.`,
      );
    } else if (exts.length > 0) {
      lines.push(
        `The next deploy creates the extensions (${extList}) in ${service.name} before migrations.`,
      );
    }
    if (from.repo === "pgvector/pgvector" || from.repo === "postgis/postgis") {
      lines.push(
        `OpsCrew never runs DROP EXTENSION automatically: if tables or columns in ${service.name} still depend on an extension ${to.label} does not carry, drop or migrate them first.`,
      );
    }
  }
  if (changes.length === 0) return undefined;
  const services = changes.map((item) => item.service);
  const hash = sha256Hex(
    canonicalJson({
      switch: "postgres-extensions",
      app: plan.app.name,
      environment,
      changes,
      lines,
    }),
  );
  return { services, changes, lines, hash };
}

/**
 * Provision's step for PostgreSQL extensions (feature 045), before anything else changes:
 * 1. Refuses PostGIS on an `arm64` server.
 * 2. Detects an image switch on an existing database (`extensionsSwitch`).
 * 3. With `planOnly`, prints the switch plan and hash without changing anything.
 * 4. Otherwise approves the switch by its SHA-256 hash (`iac-apply`), skips databases that never
 *    ran, and takes a snapshot of the switching databases first (unless already snapshotted in this
 *    exact run by `postgresLoginsStep`). If the snapshot fails, aborts with nothing changed.
 */
export async function postgresExtensionsStep(
  deps: Pick<PhaseDeps, "paths" | "reporter" | "approvals">,
  plan: DeployPlan,
  o: {
    command: string;
    planOnly?: boolean | undefined;
    snapshot: LoginsSnapshot;
    alreadySnapshotted?: ReadonlySet<string>;
  },
): Promise<ExtensionsSwitch | undefined> {
  if (!plan.services.some((service) => service.kind === "postgres")) return undefined;
  requireExtensionsArch(plan, o.command);
  const kept = (await readStrict(generatedValuesFile(deps), GeneratedValuesSchema)) ?? {};
  const committed = await readCommittedPostgresImages(deps.paths.root, plan);
  const change = extensionsSwitch(plan, kept, committed, deps.paths.environment);
  if (change === undefined) return undefined;

  const title = `Switch ${change.services.join(" and ")}'s PostgreSQL image`;
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
      plan: "switch the PostgreSQL image",
      unchanged: "Nothing was changed.",
      again: o.command,
    },
  });
  await deps.approvals.assertApprovedPlan(change.hash);

  const toCheck = change.services.filter((name) => !o.alreadySnapshotted?.has(name));
  if (toCheck.length === 0) return change;
  try {
    const empty = new Set(await o.snapshot.neverRan(toCheck));
    for (const name of empty) {
      deps.reporter.info(`${name} has no data yet, so there's nothing to snapshot.`);
    }
    const copied = new Set(toCheck.filter((name) => !empty.has(name)));
    if (copied.size > 0) {
      const skip = dataParts(plan)
        .map((part) => part.name)
        .filter((name) => !copied.has(name));
      deps.reporter.step(
        `Taking a snapshot of ${[...copied].join(" and ")} before the image switch`,
      );
      await o.snapshot.take(skip);
    }
  } catch (error) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The snapshot of ${toCheck.join(" and ")} before switching the PostgreSQL image failed: ${errorText(error)} Nothing was changed.`,
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

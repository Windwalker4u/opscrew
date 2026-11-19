/**
 * The first app's look at its server before a command that would harm the apps from other
 * repositories that share it (spec US2, FR-3012–FR-3016): their records, read as root through
 * Docker with the first app's deploy login. On a server OpsCrew created every record is such an
 * app's: the first app has none.
 */
import {
  type AppRecord,
  type HostFacts,
  inspectHost,
  readableRecords,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { listText, upperFirst } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, isCloudTarget } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { ServerApp } from "../design/sizing";
import { refusedBeforeChange } from "../previews/host";
import { deployLogin } from "../provision/origin-tls";
import { appServerShell, hasDeployment } from "../shared/server-address";

/** What {@link otherAppsOnServer} needs from the phase. */
export type OtherAppsDeps = Pick<PhaseDeps, "paths" | "runner" | "audit" | "reporter">;

/** Stand-ins for the server in tests: the deploy login's shell, and inspection. */
export interface OtherAppsServices {
  /** The deploy login's shell at `host` (default: ssh with the deploy key, the pinned host key). */
  remote?: (host: string) => RemoteExec;
  /** Inspects the server read-only (default: ssh-host's `inspectHost`). */
  inspect?: (remote: RemoteExec, options: { rootImage?: string }) => Promise<HostFacts>;
}

/** What the first app's look at its server found ({@link otherAppsOnServer}). */
export type OtherApps =
  | {
      reached: true;
      /** The other apps' readable records, active or with their data kept. */
      apps: AppRecord[];
    }
  | {
      reached: false;
      /** Why the server could not be looked at, in words that name no address. */
      reason: string;
    };

/**
 * The other apps on the server of `plan` (the first app's, `deps.paths` its paths), a target
 * OpsCrew created: it connects through the first app's deploy login, inspects the server read-only
 * as root through Docker (in the pinned Caddy image) and returns the records it read, active or
 * with their data kept. Without a deployment, or for another kind of target, there are none.
 * `reached: false` when this computer has no deploy login there, SSH fails, or the login could
 * not read the records.
 */
export async function otherAppsOnServer(
  deps: OtherAppsDeps,
  plan: DeployPlan,
  options: { services?: OtherAppsServices } = {},
): Promise<OtherApps> {
  if (!isCloudTarget(plan.target) || !hasDeployment(plan)) return { reached: true, apps: [] };
  const login = await deployLogin(deps, plan);
  if (login === undefined) {
    return { reached: false, reason: "this computer has no deploy login to it" };
  }
  const { remote, inspect = inspectHost } = options.services ?? {};
  deps.reporter.step("Looking for other apps on the server (read-only)");
  let facts: HostFacts | undefined;
  try {
    const shell = await appServerShell(deps, plan, login, remote !== undefined ? { remote } : {});
    facts = await inspect(shell, { rootImage: IMAGES.caddy.ref });
  } catch {
    facts = undefined;
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "inspect host (read-only)",
    target: "server",
    decision: "allow",
    detail: `other apps: ${facts === undefined ? "not read" : "read"}`,
  });
  if (facts === undefined) return { reached: false, reason: "it could not be reached over SSH" };
  // Only root through Docker reads the records on a server OpsCrew created.
  if (facts.privilege !== "docker") {
    return { reached: false, reason: "its deploy login could not read the apps' records there" };
  }
  return { reached: true, apps: readableRecords(facts.apps) };
}

/**
 * Refuses `what` (a phrase such as "destroying the server") in the first app's command while
 * other apps share its server ({@link otherAppsOnServer}), naming each with its repository and
 * the command that removes or moves it, then `again`. When the server can't be looked at, it
 * refuses too, unless `skip` (`--skip-other-apps-check`): then it warns and does not look. It
 * never approves anything.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any change.
 */
export async function requireNoOtherApps(
  deps: OtherAppsDeps,
  plan: DeployPlan,
  what: string,
  again: string,
  options: { skip?: boolean; services?: OtherAppsServices } = {},
): Promise<void> {
  if (!isCloudTarget(plan.target) || !hasDeployment(plan)) return;
  if (options.skip === true) {
    deps.reporter.warn(
      `Not looking for other apps on the server (--skip-other-apps-check): ${what} goes on, and breaks any app from another repository that runs there.`,
    );
    return;
  }
  const found = await otherAppsOnServer(deps, plan, options);
  if (!found.reached) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `OpsCrew couldn't look at the server for other apps (${found.reason}), and ${what} would break any that run there.`,
      `Check that the server is on and that this computer reaches it over SSH, then run \`${again}\` again; or run \`${again} --skip-other-apps-check\` to go on without looking.`,
    );
  }
  if (found.apps.length === 0) return;
  const active = found.apps.filter((record) => record.state === "active");
  const kept = found.apps.filter((record) => record.state !== "active");
  const holds = [
    ...(active.length > 0 ? [`runs ${listText(active.map(appWords))}`] : []),
    ...(kept.length > 0 ? [`keeps the data of ${listText(kept.map(appWords))}`] : []),
  ];
  const steps = [
    ...(active.length > 0
      ? [
          `run \`opscrew destroy\` in ${active.length === 1 ? "its repository" : "each one's repository"} first, or \`opscrew retarget\` there to move ${active.length === 1 ? "it" : "each one"} to a server of its own`,
        ]
      : []),
    ...(kept.length > 0
      ? [
          `run \`opscrew destroy --delete-data\` in the repository of ${listText(kept.map((record) => `"${record.app}"`))} to delete the data kept`,
        ]
      : []),
  ];
  // Only data kept is left to lose: never offered while another app runs there.
  const lose =
    active.length === 0
      ? ` To lose that data instead, run \`${again} --skip-other-apps-check\`.`
      : "";
  throw refusedBeforeChange(
    "PHASE_PRECONDITION",
    `The server also ${holds.join(" and ")}, and ${what} would break ${found.apps.length === 1 ? "it" : "them"}.`,
    `${upperFirst(steps.join("; "))}; then run \`${again}\` again.${lose}`,
  );
}

/**
 * The memory limits of the other apps whose records `facts` holds, active ones only (an app with
 * its data kept runs nothing), for the memory check beside the first app's limits.
 */
export function otherAppsMemory(facts: Pick<HostFacts, "apps">): ServerApp[] {
  return readableRecords(facts.apps)
    .filter((record) => record.state === "active")
    .map((record) => ({ name: record.app, memoryMb: record.memoryMb, tunnel: false }));
}

/** `"inventory" (from github.com/example/inventory)`: an app by its name and repository. */
function appWords(record: AppRecord): string {
  const from = record.repository?.replace(/^https:\/\//, "");
  return from === undefined ? `"${record.app}"` : `"${record.app}" (from ${from})`;
}

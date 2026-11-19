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
import { listText, OpsCrewError, upperFirst } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, isCloudTarget } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { ServerApp } from "../design/sizing";
import { refusedBeforeChange } from "../previews/host";
import { deployLogin } from "../provision/origin-tls";
import { appServerShell, hasDeployment, withoutServerAddress } from "../shared/server-address";

/** What {@link otherAppsOnServer} needs from the phase. */
export type OtherAppsDeps = Pick<PhaseDeps, "paths" | "runner" | "audit" | "reporter" | "redactor">;

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
      /**
       * The apps whose record OpsCrew can't read (a newer OpsCrew's, or damaged), by name: each
       * counts as an app that runs there.
       */
      unreadable: string[];
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
  if (!isCloudTarget(plan.target) || !hasDeployment(plan)) {
    return { reached: true, apps: [], unreadable: [] };
  }
  const login = await deployLogin(deps, plan);
  if (login === undefined) {
    return { reached: false, reason: NO_LOGIN };
  }
  const { remote, inspect = inspectHost } = options.services ?? {};
  deps.reporter.step("Looking for other apps on the server (read-only)");
  let facts: HostFacts | undefined;
  let reason = "it could not be reached over SSH";
  try {
    const shell = await appServerShell(deps, plan, login, remote !== undefined ? { remote } : {});
    facts = await inspect(shell, { rootImage: IMAGES.caddy.ref });
  } catch (error) {
    // An inspection that failed on the server it reached says why in its own words.
    if (error instanceof OpsCrewError) {
      const words = deps.redactor.redact(error.message);
      reason = withoutServerAddress(words, [{ ipv4: login.host }]).replace(/\.$/, "");
    }
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "inspect host (read-only)",
    target: "server",
    decision: "allow",
    detail: `other apps: ${facts === undefined ? "not read" : "read"}`,
  });
  if (facts === undefined) return { reached: false, reason };
  // Only root through Docker reads the records on a server OpsCrew created.
  if (facts.privilege !== "docker") {
    return { reached: false, reason: "its deploy login could not read the apps' records there" };
  }
  return {
    reached: true,
    apps: readableRecords(facts.apps),
    unreadable: facts.apps.filter((app) => app.record === null).map((app) => app.name),
  };
}

/** Why the server couldn't be looked at when this computer has no deploy login to it. */
const NO_LOGIN = "this computer has no deploy login to it";

/**
 * What to do when the server couldn't be looked at for `reason` ({@link otherAppsOnServer}), before
 * running `again` again: run it where the deploy login is, or from a machine that reaches the server
 * over SSH; or go on with `--skip-other-apps-check`.
 */
export function unreachableHint(reason: string, again: string): string {
  const skip = `or run \`${again} --skip-other-apps-check\` to go on anyway.`;
  return reason === NO_LOGIN
    ? `Run \`${again}\` on the computer that provisioned the app, which holds its deploy key and the server's address; ${skip}`
    : `Check that the server is on and that the machine running this command reaches it over SSH. With public SSH closed or limited to your own addresses, GitHub's machines can't, so run it from a computer that can. Then run \`${again}\` again; ${skip}`;
}

/**
 * Refuses `what` (a phrase such as "destroying the server") in the first app's command while
 * other apps share its server ({@link otherAppsOnServer}), naming each with its repository and
 * the command that removes or moves it, then `again`; a record it can't read counts as an app
 * that runs there. When the server can't be looked at, it
 * refuses too. With `skip` (`--skip-other-apps-check`) it still looks: an app that runs there is
 * refused all the same, while only data kept there, or a server it couldn't look at, gets a
 * warning and the command goes on. It never approves anything.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any change.
 */
export async function requireNoOtherApps(
  deps: OtherAppsDeps,
  plan: DeployPlan,
  what: string,
  again: string,
  options: { skip?: boolean; services?: OtherAppsServices } = {},
): Promise<void> {
  const skip = options.skip === true;
  const found = await otherAppsOnServer(deps, plan, options);
  if (!found.reached) {
    if (skip) {
      deps.reporter.warn(
        `OpsCrew couldn't look at the server for other apps (${found.reason}), and is going on as you asked (--skip-other-apps-check): ${what} breaks any that run there.`,
      );
      return;
    }
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `OpsCrew couldn't look at the server for other apps (${found.reason}), and ${what} would break any that run there.`,
      unreachableHint(found.reason, again),
    );
  }
  const flag = skip ? " --skip-other-apps-check doesn't cover an app that runs there." : "";
  const { unreadable } = found;
  if (unreadable.length > 0) {
    const one = unreadable.length === 1;
    const them = one ? "it" : "each one";
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `The server also runs ${listText(unreadable.map((app) => `"${app}"`))}, whose record on the server OpsCrew can't read (written by a newer OpsCrew, or damaged), and ${what} would break ${one ? "it" : "them"}.${flag}`,
      `Provision ${them} again with a current OpsCrew in its repository, or remove ${them} with \`opscrew destroy\` there first; then run \`${again}\` again.`,
    );
  }
  if (found.apps.length === 0) return;
  const active = found.apps.filter((record) => record.state === "active");
  const kept = found.apps.filter((record) => record.state !== "active");
  if (skip && active.length === 0) {
    deps.reporter.warn(
      `The data ${listText(kept.map(appWords))} kept on the server will be lost: ${what} goes on as you asked (--skip-other-apps-check).`,
    );
    return;
  }
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
    `The server also ${holds.join(" and ")}, and ${what} would break ${found.apps.length === 1 ? "it" : "them"}.${flag}`,
    `${upperFirst(steps.join("; "))}; then run \`${again}\` again.${lose}`,
  );
}

/**
 * The memory limits of the other apps whose records `facts` holds, active ones only (an app with
 * its data kept runs nothing), for the memory check beside the first app's limits. Records
 * OpsCrew can't read are left out, since their memory is unknown: callers must refuse while
 * {@link otherAppsOnServer} lists any as `unreadable`.
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

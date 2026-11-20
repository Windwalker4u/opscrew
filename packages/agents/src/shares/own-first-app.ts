/**
 * A first app on a server the user owns, reached at its public address (spec US7, FR-3025):
 * another app shares that server as one more app there (several apps on one server of the user's),
 * so it takes the server's own-server answers and pinned host key from this computer, and keeps no
 * reference to the first app. The first app's deploy key is never read.
 */
import { type ProjectPaths, readTextIfExists, upperFirst } from "@opscrew/core";
import { type DeployPlan, readOptionalArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { type OwnServerAnswers, recordOwnServerAnswers } from "../interview/own-server";
import { refusedBeforeChange } from "../previews/host";
import { hasDeployment } from "../shared/server-address";
import {
  type OwnServerConnection,
  readOwnServer,
  type SharesReference,
} from "../shared/server-record";
import {
  hostKeyFingerprint,
  keysFor,
  knownHostsName,
  type ScannedHostKey,
  writeKnownHost,
} from "../shared/wait";
import { firstAppPaths } from "./reference";

/** The first app on a server the user owns, as this computer knows it ({@link ownFirstApp}). */
export interface OwnFirstApp {
  /** Its plan, provisioned on a server the user owns. */
  plan: DeployPlan;
  /**
   * The server's own-server answers as the app sharing it takes them: the address, SSH port, login
   * and key path (or the SSH agent) of the first app's record, reached directly, served as the
   * first app is (behind Cloudflare's proxy, or DNS only). Local only.
   */
  answers: OwnServerAnswers;
  /**
   * The first app's own-server record: its pinned host key and public addresses go with the
   * answers ({@link recordOwnFirstApp}).
   */
  record: OwnServerConnection;
  /** The server's host key pinned on this computer for the first app's login. */
  hostKey: ScannedHostKey;
}

/**
 * The app named by `ref` when it runs on a server the user owns (spec FR-3025): its plan, the
 * server's own-server answers (from its `.opscrew/server.json`) and the server's pinned host key
 * (from its `known_hosts`). `undefined` when it has no plan, runs on a server OpsCrew created, or
 * is itself a second app on one: `firstApp` checks and words those. Every refusal comes before any
 * change and ends "Nothing was changed.":
 * - served through a Cloudflare Tunnel, or on a server at home: the server questions are answered
 *   with the server's own login instead;
 * - a preview environment;
 * - not provisioned on this computer, or this computer lacks its record or pinned host key.
 * @throws OpsCrewError `PHASE_PRECONDITION`; `ARTIFACT_INVALID` for a damaged record.
 */
export async function ownFirstApp(
  deps: Pick<PhaseDeps, "paths">,
  ref: SharesReference,
): Promise<OwnFirstApp | undefined> {
  const paths = firstAppPaths(deps.paths, ref);
  const plan = await readOptionalArtifact("plan", paths.files.plan);
  if (plan === undefined || plan.target.provider !== "own" || plan.target.shares !== undefined) {
    return undefined;
  }
  const record = await readOwnServer(paths);
  if (record?.shares !== undefined) return undefined;
  const name = `"${plan.app.name}"`;
  const ownLogin = (where: string) =>
    `Answer the interview's server questions with your server's own login instead (\`opscrew interview\`, a server of yours): several apps on one server of yours work ${where}.`;
  if (plan.target.access === "tunnel" || record?.reachable === false) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `${name} is served through a Cloudflare Tunnel, and this app can take a server's login only from an app served at the server's public address.`,
      ownLogin("through the tunnel too, each with a tunnel of its own"),
    );
  }
  if (plan.target.home !== undefined || record?.home !== undefined) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `${name} runs on a server at your home, and this app can take a server's login only from an app on a server reached at its public address.`,
      ownLogin("at home too"),
    );
  }
  // During a move the plan's target is the new side and the record may still be the old server's.
  if (plan.retarget !== undefined) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `${name} is in the middle of a move to another server (\`opscrew retarget\`), so its server can't take another app now.`,
      `Finish or abort the move in ${ref.root} first (\`opscrew retarget --finish\` or \`opscrew retarget --abort\`), then run this command again.`,
    );
  }
  if (plan.environment?.previews !== undefined) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `${name} is a preview environment, whose server runs pull requests' code.`,
      "Name the folder of another app, or answer the interview's server questions with your server's own login, with `opscrew interview`.",
    );
  }
  if (!hasDeployment(plan)) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `${name} is not provisioned on this computer, so it has no server to share yet.`,
      `Run \`opscrew provision${await commandFlags(paths.root, paths.environment, paths.app)}\` in ${ref.root} first, or ${elsewhere(ref)}`,
    );
  }
  const missing = (what: string) =>
    refusedBeforeChange(
      "PHASE_PRECONDITION",
      `This computer does not have ${what}.`,
      upperFirst(elsewhere(ref)),
    );
  if (record === undefined) throw missing(`the login of ${name}'s server`);
  const hostKey = keysFor(
    (await readTextIfExists(paths.files.knownHosts)) ?? "",
    knownHostsName(record.host, record.port),
  )
    .map((line): ScannedHostKey => {
      const [type = "", key = ""] = line.split(" ");
      return { type, key, fingerprint: hostKeyFingerprint(key) };
    })
    .find((key) => key.fingerprint === record.hostKey);
  if (hostKey === undefined) throw missing(`the pinned SSH host key of ${name}'s server`);
  const login = record.agent
    ? { agent: true }
    : { agent: false, ...(record.keyPath === undefined ? {} : { keyPath: record.keyPath }) };
  return {
    plan,
    answers: {
      host: record.host,
      port: record.port,
      user: record.user,
      ...login,
      reachable: true,
      serve: plan.dns.proxied ? "proxy" : "dns-only",
    },
    record,
    hostKey,
  };
}

/**
 * Records the server of `first` as this app's own server, in this app's local state: its answers
 * in `.opscrew/server.json` with the first app's pinned host key and public addresses (no reference
 * to the first app), and its host key in this app's `known_hosts` under the same address and port.
 */
export async function recordOwnFirstApp(paths: ProjectPaths, first: OwnFirstApp): Promise<void> {
  await recordOwnServerAnswers(paths, first.answers, first.record);
  const { host, port } = first.answers;
  await writeKnownHost(paths.files.knownHosts, knownHostsName(host, port), [first.hostKey]);
}

/** Where to run the command instead: on the computer that provisioned the first app. */
function elsewhere(ref: SharesReference): string {
  return `run the command on the computer that provisioned the app in ${ref.root}, or run \`opscrew interview\` again and name the folder where it is on this computer.`;
}

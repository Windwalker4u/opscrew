/**
 * How a second app's commands log in to the server it shares with the first app: as `deploy`,
 * with the first app's deploy key until this app's own key is installed (`own.joined`), then with
 * its own. The host key checked is the first app's pinned one, copied into this app's
 * `known_hosts` and `own.hostKey`: nothing else of the first app's is copied.
 */
import type { PhaseDeps } from "../context";
import type { OwnServerServices } from "../provision/types";
import {
  connectPinnedLogin,
  type LoginWords,
  type OwnServerDeps,
  type OwnServerSession,
} from "../shared/own-server";
import {
  type OwnServerConnection,
  recordOwnServer,
  type SharesReference,
} from "../shared/server-record";
import { type FirstApp, firstApp } from "./first-app";

/** What {@link secondAppLogin} needs from the phase. */
export type SecondAppLoginDeps = OwnServerDeps & Pick<PhaseDeps, "clock">;

/** A second app's login to the shared server ({@link secondAppLogin}). */
export interface SecondAppSession {
  /**
   * The connection: `session.connection` is this app's own login as recorded (its address, port,
   * pinned host key and its own deploy key's path); before `joined`, the first app's deploy key
   * is used inside `session.remote` only.
   */
  session: OwnServerSession;
  /** The first app, read from its folder: before `joined` only. */
  first?: FirstApp;
}

/**
 * The deploy login of the second app recorded in `own` (`.opscrew/server.json` → `own`, with
 * `shares`), connected and tested (`connectPinnedLogin`): before `own.joined`, the first app's
 * deploy login of `ref` ({@link firstApp}: its address, its deploy key read by path, the server's
 * host key pinned there), whose pinned key is copied into this app's `known_hosts` under the same
 * address and port and recorded with `own` (with that address and port); once joined, this app's
 * own key and pinned key, and the first app's folder is not read. A server presenting another host
 * key than the first app's pin stops, changing nothing, and points to the first app's repository.
 * @throws OpsCrewError `PHASE_PRECONDITION` from {@link firstApp}, or when the host key changed;
 * the login's own stops (refused, unreachable) as `connectPinnedLogin` words them.
 */
export async function secondAppLogin(
  deps: SecondAppLoginDeps,
  ref: SharesReference,
  own: OwnServerConnection,
  options: { services?: Pick<OwnServerServices, "remote" | "homeDir"> } = {},
): Promise<SecondAppSession> {
  const knownHostsFile = deps.paths.files.knownHosts;
  const services = { services: options.services };
  if (own.joined === true) {
    const session = await connectPinnedLogin(
      deps,
      {
        connection: own,
        knownHostsFile,
        pin: async (hostKey) => recordOwnServer(deps.paths, { ...own, hostKey }),
        words: joinedWords(ref),
      },
      services,
    );
    return { session };
  }
  const first = await firstApp(deps, ref);
  const { host, port } = first.login;
  const hostKey = first.hostKey.fingerprint;
  const session = await connectPinnedLogin(
    deps,
    {
      connection: { ...own, host, port, agent: false, keyPath: first.keyFile, hostKey },
      knownHostsFile,
      // The key is the pinned one, so nothing is pinned here: it is recorded below with the login.
      pin: async () => undefined,
      words: firstAppWords(first.plan.app.name, ref),
    },
    services,
  );
  const recorded = { ...own, host, port, hostKey };
  if (own.host !== host || own.port !== port || own.hostKey !== hostKey) {
    await recordOwnServer(deps.paths, recorded);
  }
  return { session: { ...session, connection: recorded }, first };
}

/**
 * A changed host key, said as the first app's: its pin is the one checked, and its repository
 * (`ref.root`) is where the server's keys are dealt with. This login takes no `--host-key`.
 */
function changedKey(ref: SharesReference): NonNullable<LoginWords["changedKey"]> {
  return {
    message:
      "The server's SSH host key differs from the one the app it belongs to pinned on this computer. OpsCrew stopped and changed nothing.",
    hint: `Check the server in its provider's console: if nobody rebuilt it or changed its SSH keys, someone may be intercepting the connection. The server is that app's, so deal with its keys in the repository of that app (${ref.root}), then run this command again.`,
  };
}

/** The words for the shared server once this app logs in with its own key. */
function joinedWords(ref: SharesReference): LoginWords {
  return {
    noun: "the server this app shares",
    fix: "`opscrew interview`",
    missingKey:
      "This app's deploy key is not on this computer: run the command on the computer that provisioned the app.",
    changedKey: changedKey(ref),
  };
}

/** The words for the first app's server, reached with the first app's deploy login. */
function firstAppWords(app: string, ref: SharesReference): LoginWords {
  return {
    changedKey: changedKey(ref),
    noun: `the server of "${app}"`,
    fix: `\`opscrew interview\` (the folder of "${app}")`,
    missingKey: `The deploy key of "${app}" is not on this computer: run the command on the computer that provisioned "${app}".`,
  };
}

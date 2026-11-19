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
import { firstApp } from "./first-app";

/** What {@link secondAppLogin} needs from the phase. */
export type SecondAppLoginDeps = OwnServerDeps & Pick<PhaseDeps, "clock">;

/**
 * The deploy login of the second app recorded in `own` (`.opscrew/server.json` → `own`, with
 * `shares`), connected and tested (`connectPinnedLogin`): before `own.joined`, the first app's
 * deploy login of `ref` ({@link firstApp}: its address, its deploy key read by path, the server's
 * host key pinned there), whose pinned key is copied into this app's `known_hosts` under the same
 * address and port and recorded with `own` (with that address); once joined, this app's own key
 * and pinned key, and the first app's folder is not read. A server presenting another host key
 * stops as a changed host key does, changing nothing.
 * @throws OpsCrewError `PHASE_PRECONDITION` from {@link firstApp}, or when the host key changed;
 * the login's own stops (refused, unreachable) as `connectPinnedLogin` words them.
 */
export async function secondAppLogin(
  deps: SecondAppLoginDeps,
  ref: SharesReference,
  own: OwnServerConnection,
  options: { services?: Pick<OwnServerServices, "remote" | "homeDir"> } = {},
): Promise<OwnServerSession> {
  const knownHostsFile = deps.paths.files.knownHosts;
  const pin = async (hostKey: string) => {
    await recordOwnServer(deps.paths, { ...own, hostKey });
  };
  if (own.joined === true) {
    return connectPinnedLogin(
      deps,
      { connection: own, knownHostsFile, pin, words: JOINED_WORDS },
      { services: options.services },
    );
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
      words: firstAppWords(first.plan.app.name),
    },
    { services: options.services },
  );
  if (own.host !== host || own.port !== port || own.hostKey !== hostKey) {
    await recordOwnServer(deps.paths, { ...own, host, port, hostKey });
  }
  return session;
}

/** The words for the shared server once this app logs in with its own key. */
const JOINED_WORDS: LoginWords = {
  noun: "the server this app shares",
  fix: "`opscrew interview`",
  missingKey:
    "This app's deploy key is not on this computer: run the command on the computer that provisioned the app.",
};

/** The words for the first app's server, reached with the first app's deploy login. */
function firstAppWords(app: string): LoginWords {
  return {
    noun: `the server of "${app}"`,
    fix: `\`opscrew interview\` (the folder of "${app}")`,
    missingKey: `The deploy key of "${app}" is not on this computer: run the command on the computer that provisioned "${app}".`,
  };
}

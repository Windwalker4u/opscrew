/**
 * Reading a server at home once through its admin login (research R11), for `status`, `verify`
 * and `secure`: away from home SSH doesn't answer, and each command words that with
 * {@link AWAY_FROM_HOME}. Read-only.
 */
import type { HomeNetwork, HostFacts } from "@opscrew/connector-ssh-host";
import type { PhaseName, UserFacingError } from "@opscrew/contracts";
import { isUserFacingError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import type { OwnServerServices } from "../provision/types";
import { connectOwnServer, inspectOwnHost } from "../shared/own-server";
import { readHomeNetwork } from "./network";

/** Why a server at home wasn't read from this computer. */
export const AWAY_FROM_HOME = "your server answers SSH only on your home network";

/** How a server at home was read. */
export type HomeServerRead =
  /** Inspection's facts, and the home's network when it was asked for. */
  | { facts: HostFacts; network?: HomeNetwork }
  /** The login couldn't reach SSH: this computer is away from the home network. */
  | { away: UserFacingError }
  /** Another reason in plain words: the login refused, or the inspection failed. */
  | { unread: UserFacingError };

/**
 * Reads the server at home once (read-only): `step`, then the admin login with the pinned host key
 * (`hostKey` on the first connection), the host adapter's inspection audited under `phase` with
 * `detail`, and with `network` the home's network in the same session (`readHomeNetwork`). Only a
 * login that can't reach SSH (`COMMAND_FAILED`) is `away`; any other plain-words failure is
 * `unread`, and any other error is thrown.
 */
export async function readHomeServer(
  deps: PhaseDeps,
  options: {
    services: Pick<OwnServerServices, "remote" | "homeDir" | "host"> | undefined;
    phase?: PhaseName;
    detail: string;
    hostKey?: string | undefined;
    /** The step said first (default "Connecting to your server"). */
    step?: string;
    /** Also read the home's network, registering a proxied app's addresses with the redactor. */
    network?: { proxied: boolean };
  },
): Promise<HomeServerRead> {
  const plainly = (error: unknown): UserFacingError => {
    if (!isUserFacingError(error)) throw error;
    return error;
  };
  const { services, phase } = options;
  let session: Awaited<ReturnType<typeof connectOwnServer>>;
  try {
    deps.reporter.step(options.step ?? "Connecting to your server");
    session = await connectOwnServer(deps, { hostKey: options.hostKey, services });
  } catch (error) {
    const failed = plainly(error);
    return failed.code === "COMMAND_FAILED" ? { away: failed } : { unread: failed };
  }
  try {
    const facts = await inspectOwnHost(deps, session, {
      services,
      ...(phase !== undefined ? { phase } : {}),
      detail: options.detail,
    });
    if (options.network === undefined) return { facts };
    deps.reporter.step("Reading your home network from your server (read-only)");
    const network = await readHomeNetwork(deps, session, {
      host: services?.host,
      proxied: options.network.proxied,
      ...(phase !== undefined ? { phase } : {}),
    });
    return { facts, network };
  } catch (error) {
    return { unread: plainly(error) };
  }
}

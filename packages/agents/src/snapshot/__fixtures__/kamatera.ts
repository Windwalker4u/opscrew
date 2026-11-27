/**
 * A Kamatera account for the real Kamatera connector (`vpsConnector("kamatera", …)`), reached
 * through a fake fetch: Kamatera's servers carry no tags, so their names are all that marks an
 * app's. Each server has one snapshot OpsCrew took, `opscrew-shop-<name>-20261120T080000Z`.
 */
import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import type { PhaseDeps } from "../../context";

/** Kamatera's CLI API, where the connector sends its requests. */
const KAMATERA_API = "https://cloudcli.cloudwm.com";

/**
 * `deps` with a synthetic Kamatera API key and a fetch that answers as an account holding
 * servers named `names` (ids synthetic), each with its one snapshot, whose id is its position.
 */
export function kamateraAccount<D extends Pick<PhaseDeps, "env" | "fetch">>(
  deps: D,
  names: readonly string[],
): D {
  const { fetch } = fakeFetch(
    {
      "GET /service/servers": {
        body: names.map((name, i) => ({
          id: `fa4e0000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
          datacenter: "EU-FR",
          name,
          power: "on",
        })),
      },
      // Every server's snapshots; the connector keeps those named after the server asked for.
      "POST /server/snapshot": {
        body: names.map((name, i) => ({ id: i + 1, name: `opscrew-shop-${name}-20261120T080000Z` })),
      },
    },
    { base: KAMATERA_API },
  );
  return {
    ...deps,
    env: {
      ...deps.env,
      KAMATERA_API_CLIENT_ID: fakeSecret("generic-password", "kamatera-client-id"),
      KAMATERA_API_SECRET: fakeSecret("generic-password", "kamatera-secret"),
    },
    fetch,
  };
}

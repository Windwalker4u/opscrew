/**
 * The variables a root module gets only from OpsCrew's local records, never from a file: shared by
 * the rotations and a move to another Cloudflare account, which plan the committed roots again.
 */
import { join } from "node:path";
import { OpsCrewError, toPosixRelative } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { ownEngineEnv, ownTarget } from "../provision/own";
import { setPortainerOrigin } from "../provision/portainer";
import { infrastructureOutputs, type ProjectEngine } from "./engine";
import { setPortainerRecordsAddress } from "./server-address";
import { readPortainerConnection } from "./server-record";

/**
 * The variables the root module of `plan` gets only from OpsCrew's local records, set in `env`,
 * never a file: an own server's address (`TF_VAR_server_ipv4`/`_ipv6`), and Portainer's address
 * (`TF_VAR_portainer_origin`, never from this computer's environment) with the records' address.
 * `env` already holds the state's `TF_ENCRYPTION`.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no record of the Portainer.
 */
export async function rootVariables(
  deps: PhaseDeps,
  plan: DeployPlan,
  setup: ProjectEngine,
  again: string,
): Promise<void> {
  const { env } = setup;
  if (plan.target.provider === "own") {
    await ownEngineEnv(deps, { target: ownTarget(plan) }, env, () =>
      infrastructureOutputs(deps, plan, { engine: async () => setup.engine, engineEnv: env }),
    );
    return;
  }
  if (plan.target.provider !== "portainer") return;
  delete env.TF_VAR_portainer_origin;
  const connection = await readPortainerConnection(deps.paths);
  if (connection === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This computer has no record of how OpsCrew reaches your Portainer (${toPosixRelative(deps.paths.root, join(deps.paths.stateDir, "server.json"))}), so OpsCrew can't plan its Cloudflare resources. Nothing was changed.`,
      {
        hint: `Bring OpsCrew's files from your recovery copy (\`opscrew secrets restore\`) or run the command on the computer that set up the app, then run \`${again}\` again.`,
      },
    );
  }
  setPortainerOrigin(deps.redactor, env, connection.url);
  await setPortainerRecordsAddress(deps.paths, plan, env);
}

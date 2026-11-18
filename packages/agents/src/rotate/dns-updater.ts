/**
 * `opscrew rotate dns-updater` on a server at home (plan 6.): the address updater's token lives
 * only on the server, so its copy there is replaced through the server's host plan.
 */
import { OpsCrewError } from "@opscrew/core";
import { usesTunnel } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { setupCloudflare } from "../provision/credentials";
import { applyOwnHostPlan, prepareOwnServer } from "../provision/own";
import type { ProvisionServices } from "../provision/types";
import { infrastructureOutputs } from "../shared/engine";
import { ensureDeployKey } from "../shared/ssh-keys";

const COMMAND = "opscrew rotate dns-updater";

/**
 * Puts the new address updater's token from `OPSCREW_DNS_UPDATER_TOKEN` on the server at home of
 * `plan`: with the app's Cloudflare zone, the server is connected and inspected as provision does
 * it, and the token checked (`checkUpdaterToken`: OpsCrew's own token refused, and one wider than
 * the zone's DNS) before any change; then the server's host plan, whose `dns-updater` step names
 * the new token's SHA-256, is shown, approved by its hash and applied, the token reaching the
 * server on standard input only, and kept once the updater's first run with it succeeded.
 * @throws OpsCrewError from the token's checks and the host plan, `APPROVAL_REFUSED` when it is
 * not approved (nothing changed).
 */
export async function replaceUpdaterToken(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ProvisionServices,
): Promise<void> {
  const cloudflare = await setupCloudflare(deps, plan, services, { foreignRecords: "report" });
  if (cloudflare === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The address updater needs the app's domain on Cloudflare. Nothing was changed.",
    );
  }
  const deployKey = await ensureDeployKey(deps.paths, deps.redactor);
  const base = { plan, phase: "provision" as const, command: COMMAND };
  const run = await prepareOwnServer(deps, {
    ...base,
    options: {},
    services,
    deployPublicKey: deployKey.publicKeyOpenSsh,
    deployKeyFile: deployKey.privateKeyFile,
    cloudflare,
  });
  const outputs = usesTunnel(plan)
    ? ((await infrastructureOutputs(
        deps,
        plan,
        services.engine === undefined ? {} : { engine: services.engine },
      )) ?? {})
    : {};
  await applyOwnHostPlan(deps, run, {
    ...base,
    outputs,
    deployPublicKey: deployKey.publicKeyOpenSsh,
  });
}

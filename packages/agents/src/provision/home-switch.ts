/**
 * Switching a server the user owns between its access modes (plan 14., H4; research R12): public
 * mode, the Cloudflare Tunnel and home. Leaving home, the address updater leaves the server first,
 * in a host plan of its own approved by its hash (the new setup's: its desired host has no updater,
 * so `planHost` removes the app's instance), then the records it kept are deleted at Cloudflare
 * through their own plan, approved by its hash with the app's name typed (`home/records.ts`), then
 * for a tunnel the home root's records go in the removal (`removeOldAccessMode`), then the new
 * mode's setup. Every other switch is the removal's alone.
 */
import { cloudflareConnector } from "@opscrew/connector-cloudflare";
import { ownAccessMode } from "@opscrew/iac-templates";
import type { PhaseDeps } from "../context";
import { deleteUpdaterRecords, planRecordDeletion } from "../home/records";
import { type HostPlanOutcome, infrastructureOutputs, readServerAddresses } from "../shared";
import type { HostChangeResult } from "../shared/tunnel-connections";
import { type CloudflareSetup, cloudflareTokenMissing } from "./credentials";
import {
  appliedAccessMode,
  applyOwnHostPlan,
  inspectAgain,
  MODE_TEXT,
  removeOldAccessMode,
} from "./own";
import type { PlanAndApplyResult } from "./plan-apply";

/** What a switch needs: the removal's input, and the zone the address updater kept records in. */
export type SwitchInput = Omit<Parameters<typeof removeOldAccessMode>[1], "outputs"> & {
  /** The app's Cloudflare zone (`setupCloudflare`). */
  cloudflare?: Pick<CloudflareSetup, "zoneId">;
};

/**
 * A switch's steps before the new mode's setup: the infrastructure state's outputs read once
 * (they say which mode was applied), leaving home when the last setup was there
 * ({@link leaveHome}), then the removal (`removeOldAccessMode`). Answers the removal's result with
 * the host plan that went first as `host`; leaving home for public mode removes nothing, so it
 * answers that host plan alone (`applied: false`). With `planOnly` the host plan of leaving home is
 * shown and saved only, and not answered. `undefined` when nothing went before the new setup.
 */
export async function switchAccessMode(
  deps: PhaseDeps,
  input: SwitchInput,
): Promise<(PlanAndApplyResult & { host?: HostChangeResult }) | undefined> {
  const { cloudflare, ...removalInput } = input;
  const outputs = await infrastructureOutputs(deps, input.plan, {
    engine: async () => input.engine,
    engineEnv: input.env,
  });
  // At home with the DNS on Cloudflare and nothing else in the home root, no apply was ever
  // needed, so there is no state: `.opscrew/server.json` → `own.home`, which design records for
  // a server at home, says it is there.
  const home =
    outputs === undefined
      ? (await readServerAddresses(deps.paths)).own?.home !== undefined
      : appliedAccessMode(outputs) === "home";
  if (outputs === undefined && !home) return undefined;
  const leaving = home && ownAccessMode(input.plan) !== "home";
  const left = leaving ? await leaveHome(deps, input) : undefined;
  // Without a state, the home root left nothing to remove.
  const removal =
    outputs === undefined
      ? undefined
      : await removeOldAccessMode(deps, { ...removalInput, outputs });
  if (left === undefined || input.planOnly === true) return removal;
  return { ...(removal ?? { applied: false, outputs: {} }), host: left };
}

/**
 * Leaving home: the host plan of the new setup without the tunnel connector, still served directly
 * as at home (a tunnel's apply creates the tunnel later, and its host plan switches the server
 * then), approved by its hash: its desired host has no address updater, SSH sources or `home`, so
 * it removes the updater. Then the server is inspected again, and the updater's records at the
 * app's name are deleted at Cloudflare (`deleteUpdaterRecords`). With `planOnly` both are only
 * shown, each with its hash.
 */
async function leaveHome(deps: PhaseDeps, input: SwitchInput): Promise<HostPlanOutcome> {
  const { plan, phase } = input;
  const { run } = input.host;
  const app = plan.app.name;
  const command = `opscrew ${phase}`;
  const next = ownAccessMode(plan);
  deps.reporter.warn(
    `Your server switches from ${MODE_TEXT.home} to ${MODE_TEXT[next]}. OpsCrew first removes the address updater from your server (the host plan below), then deletes the records it kept at Cloudflare${next === "tunnel" ? " and the rest of the setup at home" : ""}, then sets up the new one. The app is unreachable until the switch finishes.`,
  );
  const host = await applyOwnHostPlan(deps, run, {
    plan,
    outputs: {},
    deployPublicKey: input.host.deployPublicKey,
    ...(input.host.passwordLogins !== undefined
      ? { passwordLogins: input.host.passwordLogins }
      : {}),
    planOnly: input.planOnly === true,
    phase,
    command,
    withoutTunnel: true,
    adjust: (desired) => ({ ...desired, access: "public" }),
    upToDate: "Your server's address updater is removed already; nothing on it changes.",
  });
  if (host.applied) await inspectAgain(deps, run, phase, "after removing the address updater");
  const name = plan.dns.domain;
  if (input.cloudflare === undefined || name === undefined) return host;
  const client = cloudflareConnector(deps).client;
  if (client === undefined) throw cloudflareTokenMissing(deps);
  const records = { app, zoneId: input.cloudflare.zoneId, name };
  if (input.planOnly !== true) {
    await deleteUpdaterRecords(deps, client, { ...records, command, phase });
    return host;
  }
  const deletion = await planRecordDeletion(client, records);
  if (deletion !== undefined) {
    const pending = host.plan.steps.some((step) => step.state === "change");
    const hashes = [...(pending ? [host.hash] : []), deletion.planHash];
    deps.reporter.info(
      `Then OpsCrew deletes the address updater's records of ${app} at Cloudflare (${deletion.records.map((record) => `${record.type} ${record.name}`).join(", ")}; plan hash ${deletion.planHash}). In a script, approve them with the plans below: ${hashes.map((hash) => `--approve ${hash}`).join(" ")} --confirm ${app}.`,
    );
  }
  return host;
}

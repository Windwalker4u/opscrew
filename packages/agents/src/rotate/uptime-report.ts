/**
 * `opscrew rotate` and the server's uptime report (feature 046, User Story 4): with
 * `observability.check.credentials` on, the report's config on the server dates each credential,
 * so a rotation writes the new date there through the server's host plan, approved by its hash, as
 * `rotate/dns-updater.ts` replaces the address updater's token there.
 */
import { errorText, isUserFacingError, listText } from "@opscrew/core";
import { readOptionalArtifact } from "@opscrew/plan-schema";
import { readReportKey } from "../check/key";
import {
  type ReportServices,
  reportCredentials,
  reportHostPlan,
  reportServers,
  reportSettings,
} from "../check/reports";
import { readUptimeRecord } from "../check/uptime";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";

/**
 * After the rotation of `names` was recorded: when the environment's server reports its checks to
 * the Cloudflare uptime Worker and its config dates one of them, the server's host plan with the
 * step `uptime-report` and its new config (the new dates; never a value) is shown, approved by its
 * hash and applied, reached with `services` (SSH by default). A declined plan, or a server OpsCrew
 * can't reach, leaves the old date there, which a warning says with how to put the new one there.
 * Nothing happens otherwise, and nothing is read from a server.
 */
export async function updateReportDates(
  deps: PhaseDeps,
  names: readonly string[],
  services: ReportServices = {},
): Promise<void> {
  const plan = await readOptionalArtifact("plan", deps.paths.files.plan);
  if (plan === undefined) return;
  const [server] = await reportServers(deps, plan);
  if (server === undefined) return;
  const dated = (await reportCredentials(deps, plan))?.dates.filter((date) =>
    names.includes(date.name),
  );
  if (dated === undefined || dated.length === 0) return;
  const which = listText(dated.map((date) => date.name));
  const provision = `opscrew provision${await commandFlags(deps.paths.root, deps.paths.environment, plan.app.key)}`;
  const stays = `The uptime report on the server keeps the old date of ${which}, so its daily check may still say it is old`;
  const record = await readUptimeRecord(deps.paths);
  const key = await readReportKey(deps.paths, deps.redactor);
  if (record?.reportUrl === undefined || key === undefined) {
    deps.reporter.warn(
      `${stays}: this computer did not set the report up. Run \`${provision}\` on the computer that did to put the new date there.`,
    );
    return;
  }
  deps.reporter.step(`Writing the new date of ${which} into the server's uptime report`);
  try {
    await reportHostPlan(deps, {
      plan,
      services,
      entry: record.id,
      report: {
        settings: await reportSettings(deps, plan, {
          url: record.reportUrl,
          entry: record.id,
          server,
          key,
        }),
        key,
      },
      command: provision,
      phase: "provision",
    });
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    deps.reporter.warn(`${stays}. ${errorText(error)}`);
  }
}

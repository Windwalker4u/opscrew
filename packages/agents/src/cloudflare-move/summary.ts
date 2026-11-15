/** The summary of a move to another Cloudflare account, shown before its first change (plan 4.2). */
import { listText, OpsCrewError, plural } from "@opscrew/core";
import { deploysInPlace, opscrewRecordNames, tunnelMode } from "@opscrew/iac-templates";
import { type DeployPlan, snapshotOffsiteOf } from "@opscrew/plan-schema";
import { originTlsHostnames } from "../provision/origin-tls";
import { bucketMinutes, syncMinutes } from "../retarget/bucket";
import { sizeText, windowMinutes } from "../retarget/texts";
import { accountPieces } from "./checks";
import { A_TOKEN_VAR, FINISH_COMMAND, MOVE_COMMAND, SWITCH_COMMAND } from "./texts";
import type { MoveBucketSize, MoveSession, MoveSummary, StayingEnvironment } from "./types";

/** The app's pieces of `plan` that prepare makes in B's zone `zone`, in words. */
function piecesInB(plan: DeployPlan, zone: string): string[] {
  const names = opscrewRecordNames(plan, zone).filter((name) => !name.startsWith("_"));
  const parts = accountPieces(plan);
  // A deploy through Cloudflare Access from GitHub's machines or a runner machine (a runner on the
  // server or this computer deploys in place), Portainer's webhook, or a site's Worker.
  const secrets =
    (parts.serviceTokens && !(tunnelMode(plan) && deploysInPlace(plan))) || parts.worker;
  const pieces: string[] = [];
  if (plan.target.provider === "cloudflare-workers") {
    pieces.push(
      `the Worker ${plan.target.worker} with the code it runs now (its custom domains ${listText(names)} are attached at the switch)`,
    );
  } else if (names.length > 0) {
    pieces.push(`DNS records for ${listText(names)}`);
  }
  if (plan.dns.proxied) pieces.push("OpsCrew's rules for its hostnames");
  if (originTlsHostnames(plan).length > 0) {
    pieces.push(
      "origin protection: the same client certificate, and a new Origin CA certificate that the finish puts in place",
    );
  }
  if (parts.tunnel) {
    const where = plan.target.provider === "portainer" ? "in your Portainer" : "on the server";
    pieces.push(
      `a Cloudflare Tunnel${parts.access ? " with its Access" : ""}, and its connector ${where} beside the current one`,
    );
  }
  if (parts.access) {
    pieces.push(
      "the Zero Trust organization and its one-time PIN login, when the new account has none",
    );
  }
  if (parts.storage && plan.storage?.objectStorage !== undefined) {
    pieces.push(`the R2 bucket ${plan.storage.objectStorage.bucket}`);
  }
  const offsite = snapshotOffsiteOf(plan);
  if (parts.backups && offsite !== undefined && "bucket" in offsite) {
    pieces.push(`the R2 bucket ${offsite.bucket} of the snapshots' copies`);
  }
  if (secrets) {
    pieces.push(
      "the deploy's credentials for the new account as extra GitHub secrets, so deploys work on both sides of the switch",
    );
  }
  return pieces;
}

/** Where a staying environment is, in words. */
function stayingWords(env: StayingEnvironment): string {
  if (env.zone !== undefined) return `${env.name} (in ${env.zone})`;
  return env.cloudflare
    ? `${env.name} (its zone isn't one ${A_TOKEN_VAR} sees)`
    : `${env.name} (not on Cloudflare)`;
}

/**
 * What the move will do (plan 4.2): B's zone, each covered environment's pieces in B, the buckets
 * with their sizes, objects and minutes (`sizes`, measured on the app's servers), the environments
 * that stay or are skipped, the other apps in the zone (each needs its own prepare), the switch's
 * HTTPS gap and the finish's window.
 */
export function moveSummary(
  session: MoveSession,
  sizes: readonly MoveBucketSize[],
  otherHostnames: readonly string[],
): MoveSummary {
  const { zone } = session;
  const { a, b } = session.accounts;
  const bName = b.name === undefined ? b.accountId : `${b.name} (${b.accountId})`;
  const app = session.environments[0]?.plan.app.name ?? "the app";
  const environments = session.environments.map((env) => ({
    name: env.environment,
    pieces: piecesInB(env.plan, zone),
  }));
  const buckets = sizes.map((size) => ({ ...size, minutes: bucketMinutes(size) }));
  // The finish's window: the app stopped while its bucket's last changes are copied.
  const windows = session.environments.flatMap((env) => {
    const own = sizes.find(
      (size) => size.environment === env.environment && size.root === "storage",
    );
    if (own === undefined) return [];
    const portainer = env.plan.target.provider === "portainer";
    return [
      {
        environment: env.environment,
        minutes: windowMinutes(0, portainer) + syncMinutes(own.count),
      },
    ];
  });
  const zoneStep =
    b.zone === undefined
      ? `Add ${zone} to ${bName} as a new zone (pending until the switch), and copy the records in it that are no OpsCrew app's.`
      : `Use ${zone} in ${bName} (${b.zone.status}), and copy the records that are no OpsCrew app's and missing there.`;
  const lines = [
    `Moving ${app}'s Cloudflare setup of ${zone} from the account ${a.accountId} to ${bName}, while the current account keeps serving:`,
    `  1. ${zoneStep}`,
    "  2. Make each environment's pieces in the new account, each plan approved by its hash:",
    ...environments.map((env) => `     - ${env.name}: ${env.pieces.join("; ")}.`),
    ...(buckets.length === 0
      ? []
      : [
          "  3. Copy each R2 bucket once (the finish copies only what changed since):",
          ...buckets.map(
            (bucket) =>
              `     - ${bucket.environment}'s ${bucket.bucket}: ${sizeText(bucket.bytes)} in ${plural(bucket.count, "object")}, about ${bucket.minutes} minutes.`,
          ),
        ]),
    `  ${buckets.length === 0 ? 3 : 4}. Mark the app as prepared in the new zone.`,
    ...(session.staying.length === 0
      ? []
      : [`Staying as they are: ${listText(session.staying.map(stayingWords))}.`]),
    ...(session.skipped.length === 0
      ? []
      : [`Skipped, since they are not deployed: ${listText(session.skipped)}.`]),
    ...(otherHostnames.length === 0
      ? []
      : [
          `Other OpsCrew apps in ${zone}, each needing its own \`${MOVE_COMMAND} --to ${b.accountId}\` from its repository before the switch: ${listText(otherHostnames)}.`,
        ]),
    `Then the switch (\`${SWITCH_COMMAND}\`) points ${zone} at the new account: from the nameserver change until the new zone is active and its certificate issued (minutes, at worst 24 hours), HTTPS visitors may get certificate errors.`,
    `Then the finish (\`${FINISH_COMMAND}\`): ${
      windows.length === 0
        ? "no maintenance window"
        : `a maintenance window of about ${listText(windows.map((window) => `${window.minutes} minutes for ${window.environment}`))}, the app stopped while its bucket's last changes are copied`
    }; the app's pieces in the current account are removed after you type the app's name.`,
  ];
  return {
    zone,
    to: { accountId: b.accountId, ...(b.name === undefined ? {} : { name: b.name }) },
    lines,
  };
}

/**
 * Shows `summary` and asks `confirmStart` once; refused, the move stops with nothing changed.
 * Without `confirmStart` (a script) the summary is only shown.
 */
export async function confirmMoveStart(
  session: Pick<MoveSession, "deps" | "command">,
  summary: MoveSummary,
  confirmStart: ((summary: MoveSummary) => Promise<boolean>) | undefined,
): Promise<void> {
  session.deps.reporter.info(summary.lines.join("\n"));
  if (confirmStart === undefined || (await confirmStart(summary))) return;
  throw new OpsCrewError("APPROVAL_REFUSED", "The move was not started. Nothing was changed.", {
    hint: `Run \`${session.command}\` again when you are ready.`,
  });
}

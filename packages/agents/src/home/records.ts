/**
 * Deleting the address updater's records at Cloudflare (research R12, data-model 11): by destroy,
 * by a switch out of home and by a Cloudflare move's abort. The records' content is the home's
 * address, so the plan holds only their ids, types and names; it is hashed and approved like any
 * Cloudflare deletion, read again after the approval, and nothing is deleted when it changed.
 */

import type { CloudflareClient } from "@opscrew/connector-cloudflare";
import { DNS_UPDATER_RECORD_COMMENT } from "@opscrew/connector-ssh-host";
import type { PhaseName } from "@opscrew/contracts";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { PlanRefusedError } from "../shared";

/** The comment the updater writes on its own A and AAAA records, and the only ones it touches. */
export const UPDATER_RECORD_COMMENT = DNS_UPDATER_RECORD_COMMENT;

/** The plan that deletes the updater's records at one name: never their content. */
export interface UpdaterRecordsDeletion {
  action: "delete-updater-records";
  app: string;
  zoneId: string;
  /** The app's `dns.domain`. */
  name: string;
  /** Sorted by id. */
  records: { id: string; type: "A" | "AAAA"; name: string }[];
  /** SHA-256 of the canonical JSON of the fields above. */
  planHash: string;
}

/** The Cloudflare calls the deletion makes (the zone's own client: A's, or B's in a move). */
export type UpdaterRecordsClient = Pick<CloudflareClient, "listDnsRecords" | "deleteRecord">;

/** Which records: the app, its zone and its name. */
export interface UpdaterRecordsTarget {
  app: string;
  zoneId: string;
  name: string;
}

/**
 * The deletion plan of the updater's A and AAAA records at `name`, read from Cloudflare now;
 * `undefined` when there is none (nothing to approve).
 */
export async function planRecordDeletion(
  client: UpdaterRecordsClient,
  { app, zoneId, name }: UpdaterRecordsTarget,
): Promise<UpdaterRecordsDeletion | undefined> {
  const listed = await client.listDnsRecords(zoneId, { name });
  const records: UpdaterRecordsDeletion["records"] = listed
    .filter((record) => record.comment === UPDATER_RECORD_COMMENT)
    .flatMap(({ id, type, name: at }) =>
      type === "A" || type === "AAAA" ? [{ id, type, name: at } as const] : [],
    )
    .sort((x, y) => x.id.localeCompare(y.id));
  if (records.length === 0) return undefined;
  const body = { action: "delete-updater-records" as const, app, zoneId, name, records };
  return { ...body, planHash: sha256Hex(canonicalJson(body)) };
}

/** {@link deleteUpdaterRecords}'s target, the command that runs it again and its audit phase. */
export interface UpdaterRecordsRequest extends UpdaterRecordsTarget {
  /** The command to run again: `opscrew destroy`. */
  command: string;
  phase: PhaseName;
  /**
   * The hash of the deletion plan an earlier run showed and stopped at, given back with
   * `--approve <hash>`: the plan read now must have it, or nothing is asked or deleted.
   */
  approvedHash?: string;
}

/** Nothing deleted: the records changed since their deletion plan was shown or approved. */
function recordsChanged(app: string, command: string): OpsCrewError {
  return new OpsCrewError(
    "PLAN_HASH_MISMATCH",
    `The address updater's records of ${app} changed at Cloudflare since their deletion was approved, so OpsCrew did not delete them. Nothing in Cloudflare was changed.`,
    { hint: `Run \`${command}\` again to see what is there now.` },
  );
}

/**
 * Deletes the updater's records at the app's name: the plan (by type and name) approved as
 * `cloudflare-apply` with `allowDestroy` and the app's name typed (`--approve <hash> --confirm
 * <app>` in a script), read again, then each record through `deleteRecord`. With
 * `approvedHash`, the plan read first must have that hash. Answers the plan it applied, or
 * `undefined` when there was no record (nothing asked).
 * @throws PlanRefusedError when the approval is refused; `PLAN_HASH_MISMATCH` when the records
 * changed since the plan was shown or approved. Nothing is deleted in either case.
 */
export async function deleteUpdaterRecords(
  deps: Pick<PhaseDeps, "approvals" | "audit" | "reporter">,
  client: UpdaterRecordsClient,
  request: UpdaterRecordsRequest,
): Promise<UpdaterRecordsDeletion | undefined> {
  const { app, command, phase, approvedHash } = request;
  const plan = await planRecordDeletion(client, request);
  if (plan === undefined) return undefined;
  if (approvedHash !== undefined && plan.planHash !== approvedHash.trim().toLowerCase()) {
    throw recordsChanged(app, command);
  }
  const listed = plan.records.map((record) => `${record.type} ${record.name}`).join(", ");
  const approval = await deps.approvals.request({
    kind: "cloudflare-apply",
    title: `Delete the address updater's records of ${app} at Cloudflare`,
    details: [
      `The address updater of ${app} kept these records, which go now: ${listed}.`,
      "Type the app's name to approve.",
    ].join("\n"),
    planHash: plan.planHash,
    allowDestroy: true,
    // Typed in a terminal, `--confirm <app>` in a script.
    confirmPhrase: app,
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "deletion of the address updater's records",
      ...(approval.reason === undefined ? {} : { reason: approval.reason }),
      unchanged: "Nothing in Cloudflare was changed.",
      hint: `Run \`${command}\` again when you are ready (in a script: --approve ${plan.planHash} --confirm ${app}).`,
    });
  }
  await deps.approvals.assertApprovedCloudflarePlan(plan.planHash, { allowDestroy: true });
  const again = await planRecordDeletion(client, request);
  if (again?.planHash !== plan.planHash) throw recordsChanged(app, command);
  for (const record of plan.records) await client.deleteRecord(plan.zoneId, record.id);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "updater records deleted",
    phase,
    target: app,
    decision: "approved",
    detail: `plan ${plan.planHash}, zone ${plan.zoneId}: ${plan.records.map((r) => `${r.type} ${r.id}`).join(", ")}`,
  });
  deps.reporter.success(`Deleted the address updater's records of ${app}: ${listed}.`);
  return plan;
}

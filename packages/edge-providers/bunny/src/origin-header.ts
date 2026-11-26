/**
 * Plan-hash-bound management of Bunny.net's origin-verification header Edge Rule (ADR 0038 D6).
 *
 * Why this is NOT in Terraform: `bunnynet_pullzone_edgerule` persists `SetRequestHeader` values
 * inside Terraform state. Instead, OpsCrew keeps the 32-byte hex secret in local
 * `generated_values.json` (0600) and applies it through the Bunny.net API after an approval bound
 * to the plan's SHA-256 hash. Neither the plan display nor the hash payload ever contains the
 * plaintext token — only its SHA-256 fingerprint binds the approval to the exact token value.
 */
import type { EdgeOriginHeaderPlan } from "@opscrew/contracts";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import {
  BUNNY_ACTION_SET_REQUEST_HEADER,
  type BunnyClient,
  OPSCREW_ORIGIN_HEADER_DESCRIPTION,
} from "./client";

const HEX_64 = /^[0-9a-f]{64}$/;

export type OriginHeaderAction = EdgeOriginHeaderPlan["action"];

/** Validates that `token` is a 32-byte lowercase hex secret (64 hex chars). */
export function assertOriginTokenFormat(token: string): void {
  if (!HEX_64.test(token)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The edge origin-verification token must be 64 lower-case hexadecimal characters (32 random bytes).",
      {
        hint: "Let OpsCrew generate the token automatically instead of supplying a custom format.",
      },
    );
  }
}

function parsePullZoneId(resourceId: string): number {
  if (!/^\d+$/.test(resourceId)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Invalid Bunny.net Pull Zone id "${resourceId}": expected a positive integer.`,
    );
  }
  const id = Number(resourceId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Invalid Bunny.net Pull Zone id "${resourceId}": expected a positive integer.`,
    );
  }
  return id;
}

/**
 * Inspects the Bunny Pull Zone's current Edge Rules and plans creating or updating OpsCrew's
 * `SetRequestHeader` rule without exposing the token value in the plan or hash input.
 */
export async function planBunnyOriginHeader(
  client: Pick<BunnyClient, "listEdgeRules">,
  input: {
    pullZoneId: number | string;
    headerName: string;
    token: string;
  },
): Promise<EdgeOriginHeaderPlan> {
  assertOriginTokenFormat(input.token);
  const pullZoneId =
    typeof input.pullZoneId === "number" ? input.pullZoneId : parsePullZoneId(input.pullZoneId);
  const headerName = input.headerName;
  const rules = await client.listEdgeRules(pullZoneId);
  const existing = rules.find(
    (rule) =>
      rule.ActionType === BUNNY_ACTION_SET_REQUEST_HEADER &&
      (rule.Description === OPSCREW_ORIGIN_HEADER_DESCRIPTION ||
        rule.ActionParameter1?.toLowerCase() === headerName.toLowerCase()),
  );
  const tokenFingerprint = sha256Hex(input.token).slice(0, 12);
  const matches =
    existing?.Enabled &&
    existing.ActionParameter1 === headerName &&
    existing.ActionParameter2 === input.token;
  const action: OriginHeaderAction =
    existing === undefined ? "create" : matches ? "noop" : "update";
  const summary =
    action === "noop"
      ? `Bunny Pull Zone ${pullZoneId} already sends ${headerName} (fingerprint ${tokenFingerprint}).`
      : action === "create"
        ? `Add Bunny Edge Rule on Pull Zone ${pullZoneId} to send ${headerName} (fingerprint ${tokenFingerprint}) to the origin.`
        : `Update Bunny Edge Rule ${existing?.Guid} on Pull Zone ${pullZoneId} to send the new ${headerName} (fingerprint ${tokenFingerprint}) to the origin.`;
  const hash = sha256Hex(
    canonicalJson({
      op: "bunny-origin-header",
      pullZoneId,
      headerName,
      action,
      existingGuid: existing?.Guid ?? null,
      tokenFingerprint,
    }),
  );
  return {
    action,
    resourceId: String(pullZoneId),
    headerName,
    ...(existing === undefined ? {} : { existingId: existing.Guid }),
    tokenFingerprint,
    summary,
    hash,
  };
}

/**
 * Applies a previously planned Bunny origin-header change after verifying `approvedHash` matches
 * `plan.hash` (constitution I).
 */
export async function applyBunnyOriginHeader(
  client: Pick<BunnyClient, "upsertOriginHeaderRule">,
  plan: EdgeOriginHeaderPlan,
  input: {
    token: string;
    approvedHash: string;
  },
): Promise<{ applied: boolean }> {
  assertOriginTokenFormat(input.token);
  if (input.approvedHash.toLowerCase() !== plan.hash.toLowerCase()) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Approval hash mismatch for Bunny Pull Zone ${plan.resourceId} origin-header update. Nothing was changed.`,
      { hint: "Re-run the command to generate a fresh plan and approve its hash." },
    );
  }
  const actualFingerprint = sha256Hex(input.token).slice(0, 12);
  if (actualFingerprint !== plan.tokenFingerprint) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      "The origin-verification token changed after the Bunny plan was hashed. Nothing was changed.",
      { hint: "Re-run the command so the approval hash matches the current token." },
    );
  }
  if (plan.action === "noop") return { applied: false };
  await client.upsertOriginHeaderRule({
    pullZoneId: parsePullZoneId(plan.resourceId),
    ...(plan.existingId === undefined ? {} : { guid: plan.existingId }),
    headerName: plan.headerName,
    token: input.token,
  });
  return { applied: true };
}

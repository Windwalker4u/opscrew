/**
 * Plan-hash-bound management of Bunny.net's origin-verification header Edge Rule (ADR 0038 D6).
 *
 * Why this is NOT in Terraform: `bunnynet_pullzone_edgerule` persists `SetRequestHeader` values
 * inside Terraform state. Instead, OpsCrew keeps the 32-byte hex secret in local
 * `generated_values.json` (0600) and applies it through the Bunny.net API after an approval bound
 * to the plan's SHA-256 hash. Neither the plan display nor the hash payload ever contains the
 * plaintext token — only its SHA-256 fingerprint binds the approval to the exact token value.
 */
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import {
  BUNNY_ACTION_SET_REQUEST_HEADER,
  type BunnyClient,
  OPSCREW_ORIGIN_HEADER_DESCRIPTION,
} from "./client";

/** Default HTTP header carrying OpsCrew's shared origin-verification secret. */
export const BUNNY_ORIGIN_AUTH_HEADER = "X-OpsCrew-Origin-Token";

const HEX_64 = /^[0-9a-f]{64}$/;

export type OriginHeaderAction = "create" | "update" | "noop";

export interface BunnyOriginHeaderPlan {
  action: OriginHeaderAction;
  pullZoneId: number;
  headerName: string;
  existingGuid?: string;
  /** Short SHA-256 fingerprint of the desired token (never the plaintext secret). */
  tokenFingerprint: string;
  /** Plain-English summary shown before approval (contains no secret). */
  summary: string;
  /** SHA-256 hash binding approval to this exact pull zone, header, action, and token fingerprint. */
  hash: string;
}

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

/**
 * Inspects the Bunny Pull Zone's current Edge Rules and plans creating or updating OpsCrew's
 * `SetRequestHeader` rule without exposing the token value in the plan or hash input.
 */
export async function planBunnyOriginHeader(
  client: Pick<BunnyClient, "listEdgeRules">,
  input: {
    pullZoneId: number;
    headerName?: string;
    token: string;
  },
): Promise<BunnyOriginHeaderPlan> {
  assertOriginTokenFormat(input.token);
  const headerName = input.headerName ?? BUNNY_ORIGIN_AUTH_HEADER;
  const rules = await client.listEdgeRules(input.pullZoneId);
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
      ? `Bunny Pull Zone ${input.pullZoneId} already sends ${headerName} (fingerprint ${tokenFingerprint}).`
      : action === "create"
        ? `Add Bunny Edge Rule on Pull Zone ${input.pullZoneId} to send ${headerName} (fingerprint ${tokenFingerprint}) to the origin.`
        : `Update Bunny Edge Rule ${existing?.Guid} on Pull Zone ${input.pullZoneId} to send the new ${headerName} (fingerprint ${tokenFingerprint}) to the origin.`;
  const hash = sha256Hex(
    canonicalJson({
      op: "bunny-origin-header",
      pullZoneId: input.pullZoneId,
      headerName,
      action,
      existingGuid: existing?.Guid ?? null,
      tokenFingerprint,
    }),
  );
  return {
    action,
    pullZoneId: input.pullZoneId,
    headerName,
    ...(existing === undefined ? {} : { existingGuid: existing.Guid }),
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
  plan: BunnyOriginHeaderPlan,
  input: {
    token: string;
    approvedHash: string;
  },
): Promise<{ applied: boolean }> {
  assertOriginTokenFormat(input.token);
  if (input.approvedHash.toLowerCase() !== plan.hash.toLowerCase()) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Approval hash mismatch for Bunny Pull Zone ${plan.pullZoneId} origin-header update. Nothing was changed.`,
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
    pullZoneId: plan.pullZoneId,
    ...(plan.existingGuid === undefined ? {} : { guid: plan.existingGuid }),
    headerName: plan.headerName,
    token: input.token,
  });
  return { applied: true };
}

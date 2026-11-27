/**
 * Plan-hash-bound management of Gcore CDN's `staticRequestHeaders` origin-verification header
 * (ADR 0038 D6).
 *
 * Why this is NOT in Terraform: `gcore_cdn_resource.options.static_request_headers` persists
 * header values inside Terraform state. Instead, OpsCrew keeps the 32-byte hex secret in local
 * `generated_values.json` (0600) and applies it via `PATCH /cdn/resources/{id}` after an approval
 * bound to the plan's SHA-256 hash. Existing non-OpsCrew headers are preserved.
 */
import type { EdgeOriginHeaderPlan } from "@opscrew/contracts";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import type { GcoreClient } from "./client";

const HEX_64 = /^[0-9a-f]{64}$/;

export type GcoreOriginHeaderAction = EdgeOriginHeaderPlan["action"];

function assertOriginTokenFormat(token: string): void {
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

function parseResourceId(resourceId: number | string): number {
  if (typeof resourceId === "number") {
    if (!Number.isSafeInteger(resourceId) || resourceId <= 0) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `Invalid Gcore CDN resource id "${resourceId}": expected a positive integer.`,
      );
    }
    return resourceId;
  }
  if (!/^\d+$/.test(resourceId)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Invalid Gcore CDN resource id "${resourceId}": expected a positive integer.`,
    );
  }
  const id = Number(resourceId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Invalid Gcore CDN resource id "${resourceId}": expected a positive integer.`,
    );
  }
  return id;
}

function nonOpsCrewHeaders(
  current: Readonly<Record<string, string>> | undefined,
  headerName: string,
): Record<string, string> {
  const preserved: Record<string, string> = {};
  for (const [k, v] of Object.entries(current ?? {})) {
    if (k.toLowerCase() !== headerName.toLowerCase()) preserved[k] = v;
  }
  return preserved;
}

/**
 * Inspects the Gcore CDN resource's current `staticRequestHeaders` and plans creating or updating
 * OpsCrew's origin-verification header without exposing the plaintext token in the plan or hash.
 */
export async function planGcoreOriginHeader(
  client: Pick<GcoreClient, "getCdnResource">,
  input: {
    resourceId: number | string;
    headerName: string;
    token: string;
  },
): Promise<EdgeOriginHeaderPlan> {
  assertOriginTokenFormat(input.token);
  const resourceId = parseResourceId(input.resourceId);
  const headerName = input.headerName;
  const resource = await client.getCdnResource(resourceId);
  const current = resource.options?.staticRequestHeaders;
  const existingEntry = Object.entries(current?.value ?? {}).find(
    ([k]) => k.toLowerCase() === headerName.toLowerCase(),
  );
  const existingValue = existingEntry?.[1];
  const preserved = nonOpsCrewHeaders(current?.value, headerName);
  const tokenFingerprint = sha256Hex(input.token).slice(0, 12);
  const matches = current?.enabled === true && existingValue === input.token;
  const action: GcoreOriginHeaderAction =
    existingValue === undefined ? "create" : matches ? "noop" : "update";
  const summary =
    action === "noop"
      ? `Gcore CDN resource ${resourceId} already sends ${headerName} (fingerprint ${tokenFingerprint}).`
      : action === "create"
        ? `Add ${headerName} (fingerprint ${tokenFingerprint}) to Gcore CDN resource ${resourceId} staticRequestHeaders.`
        : `Update ${headerName} (fingerprint ${tokenFingerprint}) on Gcore CDN resource ${resourceId} staticRequestHeaders.`;
  const hash = sha256Hex(
    canonicalJson({
      op: "gcore-origin-header",
      resourceId,
      headerName,
      action,
      tokenFingerprint,
      preservedKeys: Object.keys(preserved).sort(),
    }),
  );
  return {
    action,
    resourceId: String(resourceId),
    headerName,
    tokenFingerprint,
    summary,
    hash,
  };
}

/**
 * Applies a previously planned Gcore origin-header update after verifying `approvedHash` matches
 * `plan.hash` (constitution I), preserving any unrelated headers currently configured on the
 * CDN resource.
 */
export async function applyGcoreOriginHeader(
  client: Pick<GcoreClient, "getCdnResource" | "patchStaticRequestHeaders">,
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
      `Approval hash mismatch for Gcore CDN resource ${plan.resourceId} origin-header update. Nothing was changed.`,
      { hint: "Re-run the command to generate a fresh plan and approve its hash." },
    );
  }
  const actualFingerprint = sha256Hex(input.token).slice(0, 12);
  if (actualFingerprint !== plan.tokenFingerprint) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      "The origin-verification token changed after the Gcore plan was hashed. Nothing was changed.",
      { hint: "Re-run the command so the approval hash matches the current token." },
    );
  }
  if (plan.action === "noop") return { applied: false };
  const resourceId = parseResourceId(plan.resourceId);
  const resource = await client.getCdnResource(resourceId);
  const preserved = nonOpsCrewHeaders(
    resource.options?.staticRequestHeaders?.value,
    plan.headerName,
  );
  await client.patchStaticRequestHeaders({
    resourceId,
    headers: {
      ...preserved,
      [plan.headerName]: input.token,
    },
  });
  return { applied: true };
}

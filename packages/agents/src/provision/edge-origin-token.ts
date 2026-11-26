/**
 * Provisioning and connector sync for `shared-header` edge origin-verification tokens (ADR 0038 D6,
 * Bunny.net / Gcore). The 32-byte hex secret lives in local `generated_values.json` (0600) and in
 * the server's `/srv/edge/tls/<app>/origin-token.<ext>` (0600), NEVER in Terraform state or git.
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readTextIfExists, writeFileAtomic } from "@opscrew/core";
import {
  applyBunnyOriginHeader,
  type BunnyClient,
  type BunnyOriginHeaderPlan,
  planBunnyOriginHeader,
} from "@opscrew/edge-provider-bunny";
import { edgeProvider } from "@opscrew/edge-providers";
import { activeEdgeProvider, type DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  type EdgeOriginTokenSchema,
  GeneratedValuesSchema,
  generatedValuesFile,
} from "../shared/app-secrets";
import { requestApproval } from "../shared/approvals";

/** Credential name used by `opscrew rotate` for the shared edge origin-verification token. */
export const EDGE_ORIGIN_TOKEN_CREDENTIAL = "edge-origin-token";

export type EdgeOriginTokenValue = z.infer<typeof EdgeOriginTokenSchema>;

const RawGeneratedObjectSchema = z.looseObject({});

/** Generates a 32-byte lower-case hex token (64 hex characters). */
export function generateEdgeOriginToken(
  randomBytes: (n: number) => Buffer = nodeRandomBytes,
): string {
  return randomBytes(32).toString("hex");
}

/** Registers every token in `value` with `redactor`. */
function registerTokens(
  deps: Pick<PhaseDeps, "redactor">,
  value: EdgeOriginTokenValue | undefined,
): void {
  if (value === undefined) return;
  deps.redactor.addLiteral(value.current, "edge-origin-token");
  if (value.previous !== undefined) deps.redactor.addLiteral(value.previous, "edge-origin-token");
}

/** Reads `edgeOriginToken` from `generated_values.json` and registers it with the redactor. */
export async function readEdgeOriginToken(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
): Promise<EdgeOriginTokenValue | undefined> {
  const text = await readTextIfExists(generatedValuesFile(deps));
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const values = GeneratedValuesSchema.safeParse(parsed);
  if (!values.success || values.data.edgeOriginToken === undefined) return undefined;
  registerTokens(deps, values.data.edgeOriginToken);
  return values.data.edgeOriginToken;
}

/** Persists `edgeOriginToken` atomically into `generated_values.json` (mode 0600). */
export async function writeEdgeOriginToken(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  value: EdgeOriginTokenValue,
): Promise<void> {
  registerTokens(deps, value);
  const file = generatedValuesFile(deps);
  const existingText = await readTextIfExists(file);
  const current =
    existingText === undefined ? {} : RawGeneratedObjectSchema.parse(JSON.parse(existingText));
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    file,
    `${JSON.stringify({ ...current, edgeOriginToken: value }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

/** Returns the existing `edgeOriginToken` or generates and persists a new 32-byte hex secret once. */
export async function ensureEdgeOriginToken(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  randomBytes: (n: number) => Buffer = nodeRandomBytes,
): Promise<EdgeOriginTokenValue> {
  const kept = await readEdgeOriginToken(deps);
  if (kept !== undefined) return kept;
  const created: EdgeOriginTokenValue = { current: generateEdgeOriginToken(randomBytes) };
  await writeEdgeOriginToken(deps, created);
  return created;
}

/** Formats `edgeOriginToken` for the `OPSCREW_EDGE_ORIGIN_TOKEN` deploy secret (1 or 2 lines). */
export function formatEdgeOriginTokenSecret(value: EdgeOriginTokenValue): string {
  return value.previous === undefined ? value.current : `${value.current}\n${value.previous}`;
}

/**
 * Plans, approves by SHA-256 hash, and applies Bunny.net's `SetRequestHeader` origin-verification
 * Edge Rule via the typed Bunny API client (never via Terraform).
 */
export async function syncBunnyOriginHeader(
  deps: Pick<PhaseDeps, "approvals" | "reporter" | "redactor">,
  plan: DeployPlan,
  input: {
    pullZoneId: number;
    token: string;
    client: Pick<BunnyClient, "listEdgeRules" | "upsertOriginHeaderRule">;
    command: string;
    planOnly?: boolean;
  },
): Promise<{ plan: BunnyOriginHeaderPlan; applied: boolean }> {
  deps.redactor.addLiteral(input.token, "edge-origin-token");
  const edgeId = activeEdgeProvider(plan) ?? "bunny";
  const headerName = edgeProvider(edgeId).capabilities.originAuthHeader ?? "X-OpsCrew-Origin-Token";
  const planned = await planBunnyOriginHeader(input.client, {
    pullZoneId: input.pullZoneId,
    headerName,
    token: input.token,
  });
  if (planned.action === "noop") {
    return { plan: planned, applied: false };
  }
  if (input.planOnly === true) {
    deps.reporter.info(
      `${planned.summary}\nPlan hash: ${planned.hash}\nIn a script, approve it with --approve ${planned.hash}.`,
    );
    return { plan: planned, applied: false };
  }
  await requestApproval(deps, {
    kind: "iac-apply",
    title: `Configure ${headerName} on Bunny.net Pull Zone ${input.pullZoneId}`,
    details: `${planned.summary}\nPlan hash: ${planned.hash}`,
    hash: planned.hash,
    refused: {
      plan: "Bunny.net origin-header update",
      unchanged: "Nothing was changed on Bunny.net.",
      again: input.command,
    },
  });
  await deps.approvals.assertApprovedPlan(planned.hash);
  const result = await applyBunnyOriginHeader(input.client, planned, {
    token: input.token,
    approvedHash: planned.hash,
  });
  return { plan: planned, applied: result.applied };
}

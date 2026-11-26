/**
 * Zero-downtime rotation for `shared-header` edge origin-verification tokens (ADR 0038 D6,
 * `opscrew rotate edge-origin-token`):
 *
 * 1. Generate a new 32-byte hex token `next`, keeping `previous = current`.
 * 2. Update the server proxy's 0600 snippet to accept BOTH `[next, previous]` and reload the proxy
 *    (and update `OPSCREW_EDGE_ORIGIN_TOKEN` to `next\nprevious`), recording `{ current: next,
 *    previous }` in `generated_values.json` so a crash can resume without downtime.
 * 3. Plan, approve by SHA-256 hash, and apply `next` to the edge provider (Bunny.net Edge Rule)
 *    through its typed API connector so edge traffic immediately sends `next`.
 * 4. Narrow the server proxy's 0600 snippet to `[next]` only and reload the proxy, update
 *    `OPSCREW_EDGE_ORIGIN_TOKEN` to `next`, and persist `{ current: next }` in
 *    `generated_values.json`.
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import type { BunnyClient } from "@opscrew/edge-provider-bunny";
import { edgeProvider } from "@opscrew/edge-providers";
import {
  DEPLOY_SECRETS,
  type EdgeProxy,
  edgeProxy,
  originTokenServerPath,
  originTokenSnippet,
  usesSharedOriginHeader,
} from "@opscrew/iac-templates";
import { activeEdgeProvider, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  formatEdgeOriginTokenSecret,
  generateEdgeOriginToken,
  readEdgeOriginToken,
  syncBunnyOriginHeader,
  writeEdgeOriginToken,
} from "../provision/edge-origin-token";

export interface EdgeOriginTokenRotationHooks {
  /** Bunny Pull Zone id whose origin-verification header rule is updated. */
  pullZoneId: number;
  /** Typed Bunny API client. */
  bunny: Pick<BunnyClient, "listEdgeRules" | "upsertOriginHeaderRule">;
  /** Writes the 0600 proxy snippet to `serverPath` and reloads the server's reverse proxy. */
  installServerSnippet(input: {
    proxy: EdgeProxy;
    serverPath: string;
    content: string;
    phase: "dual-accept" | "narrow";
  }): Promise<void>;
  /** Updates the `OPSCREW_EDGE_ORIGIN_TOKEN` deploy secret in GitHub Actions (optional in local tests). */
  setDeploySecret?(name: string, value: string): Promise<void>;
  /** Command shown in refusal hints (default `opscrew rotate edge-origin-token`). */
  command?: string;
  /** Deterministic randomness override for tests. */
  randomBytes?: (n: number) => Buffer;
}

export interface EdgeOriginTokenRotationResult {
  rotated: boolean;
  edgePlanHash: string;
  serverPath: string;
  proxy: EdgeProxy;
}

/**
 * Rotates the per-app shared origin-verification token with zero downtime:
 * server dual-accept (`[next, previous]`) -> approved edge switch (`next`) -> server narrow (`[next]`).
 */
export async function rotateEdgeOriginToken(
  deps: Pick<PhaseDeps, "paths" | "approvals" | "reporter" | "redactor">,
  plan: DeployPlan,
  hooks: EdgeOriginTokenRotationHooks,
): Promise<EdgeOriginTokenRotationResult> {
  if (!usesSharedOriginHeader(plan)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "This environment does not use a shared-header edge provider (such as Bunny.net), so there is no edge-origin-token to rotate. Nothing was changed.",
    );
  }
  const existing = await readEdgeOriginToken(deps);
  if (existing === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "This computer does not keep the environment's current edge-origin-token yet. Nothing was changed.",
      {
        hint: "Run `opscrew provision` first, or rotate from the computer that provisioned this environment.",
      },
    );
  }
  const edgeId = activeEdgeProvider(plan) ?? "bunny";
  const headerName = edgeProvider(edgeId).capabilities.originAuthHeader ?? "X-OpsCrew-Origin-Token";
  const proxy = edgeProxy(plan);
  const serverPath = originTokenServerPath(proxy, plan.app.name);
  const next = generateEdgeOriginToken(hooks.randomBytes ?? nodeRandomBytes);
  const previous = existing.current;
  deps.redactor.addLiteral(next, "edge-origin-token");

  // Step 1: Server accepts BOTH [next, previous] before the edge switches.
  const dualSnippet = originTokenSnippet(proxy, headerName, [next, previous]);
  await writeEdgeOriginToken(deps, { current: next, previous });
  await hooks.installServerSnippet({
    proxy,
    serverPath,
    content: dualSnippet,
    phase: "dual-accept",
  });
  await hooks.setDeploySecret?.(
    DEPLOY_SECRETS.edgeOriginToken,
    formatEdgeOriginTokenSecret({ current: next, previous }),
  );

  // Step 2: Plan, approve by hash, and switch the edge provider to `next`.
  const synced = await syncBunnyOriginHeader(deps, plan, {
    pullZoneId: hooks.pullZoneId,
    token: next,
    client: hooks.bunny,
    command: hooks.command ?? "opscrew rotate edge-origin-token",
  });

  // Step 3: Narrow the server to accept ONLY [next] and drop `previous` locally.
  const narrowSnippet = originTokenSnippet(proxy, headerName, [next]);
  await hooks.installServerSnippet({
    proxy,
    serverPath,
    content: narrowSnippet,
    phase: "narrow",
  });
  await hooks.setDeploySecret?.(
    DEPLOY_SECRETS.edgeOriginToken,
    formatEdgeOriginTokenSecret({ current: next }),
  );
  await writeEdgeOriginToken(deps, { current: next });

  return {
    rotated: synced.applied,
    edgePlanHash: synced.plan.hash,
    serverPath,
    proxy,
  };
}

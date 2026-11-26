/**
 * Zero-downtime rotation for `shared-header` edge origin-verification tokens (ADR 0038 D6,
 * `opscrew rotate edge-origin-token`):
 *
 * 1. If an earlier rotation stopped mid-flight (`existing.previous` is set), resume with that
 *    exact `{ current, previous }` pair so the edge's live token is never dropped (B4). Otherwise
 *    generate a new 32-byte hex token `next`, keeping `previous = existing.current`.
 * 2. Plan the edge provider origin-header switch and request a SHA-256 hash-bound approval BEFORE
 *    mutating anything locally, on the server, in GitHub, or at the edge provider (constitution I).
 *    A refusal leaves every store and file completely untouched.
 * 3. Once approved:
 *    a. Persist `{ current: next, previous }` in `generated_values.json` (0600), update
 *       `OPSCREW_EDGE_ORIGIN_TOKEN` in GitHub Actions to `next\nprevious`, and install the
 *       dual-accept snippet on the server (`/srv/edge/tls/<app>/origin-token.<ext>`, mode 0600) +
 *       reload the server's reverse proxy over SSH.
 *    b. Apply `next` to the edge provider through its typed registry connector (bound to the
 *       approved plan hash).
 *    c. Narrow the server snippet to `[next]` and reload the proxy, update
 *       `OPSCREW_EDGE_ORIGIN_TOKEN` to `next`, persist `{ current: next }` locally (dropping
 *       `previous`), record the rotation date, and refresh the encrypted recovery copy.
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { edgeProvider } from "@opscrew/edge-providers";
import {
  DEPLOY_SECRETS,
  EDGE_DIR,
  type EdgeProxy,
  edgeProxy,
  OPENLITESPEED_COMMAND,
  originTokenServerPath,
  originTokenSnippet,
  shellQuote,
  usesSharedOriginHeader,
} from "@opscrew/iac-templates";
import { APP_SERVER, activeEdgeProvider, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { GitHubSetup } from "../provision/credentials";
import {
  EDGE_ORIGIN_TOKEN_CREDENTIAL,
  formatEdgeOriginTokenSecret,
  generateEdgeOriginToken,
  readEdgeOriginToken,
  requireThirdPartyEdgeKey,
  writeEdgeOriginToken,
} from "../provision/edge-origin-token";
import { deploySecretPlace, setSecretAt } from "../provision/secrets";
import type { ProvisionServices } from "../provision/types";
import { type RefreshRecoveryResult, refreshRecoveryCopy } from "../secrets/copy";
import { requestApproval } from "../shared/approvals";
import { infrastructureOutputs } from "../shared/engine";
import { serverShell } from "../status/servers";
import type { RotationEngineOptions } from "./infra";
import { recordRotation } from "./record";

export interface EdgeOriginTokenRotationOptions extends Partial<RotationEngineOptions> {
  /** Edge provider resource id (if omitted, read from Terraform outputs via `resourceIdOutput`). */
  resourceId?: string;
  /** Repository where `OPSCREW_EDGE_ORIGIN_TOKEN` is stored (optional in local tests). */
  github?: Pick<GitHubSetup, "api" | "owner" | "repo">;
  /** Remote shell override for tests (defaults to OpsCrew's typed SSH `serverShell`). */
  remote?: ProvisionServices["remote"];
  /** HTTP fetch override for tests. */
  fetch?: FetchLike;
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
  copy?: RefreshRecoveryResult;
}

const RELOAD_COMMAND: Record<EdgeProxy, string> = {
  caddy: `docker compose -f ${EDGE_DIR}/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile`,
  nginx: `docker compose -f ${EDGE_DIR}/compose.yaml exec -T nginx nginx -t && docker compose -f ${EDGE_DIR}/compose.yaml exec -T nginx nginx -s reload`,
  openlitespeed: `docker compose -f ${EDGE_DIR}/compose.yaml exec -T openlitespeed ${OPENLITESPEED_COMMAND} reload`,
};

async function installSnippetOnServer(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: {
    proxy: EdgeProxy;
    serverPath: string;
    content: string;
    remote?: ProvisionServices["remote"];
  },
): Promise<void> {
  const { remote } = await serverShell(deps, plan, APP_SERVER, {
    ...(input.remote === undefined ? {} : { remote: input.remote }),
  });
  const dir = `${EDGE_DIR}/tls/${plan.app.name}`;
  const path = input.serverPath;
  const cmd = [
    "set -eu",
    "umask 077",
    `mkdir -p ${shellQuote(dir)}`,
    `chmod 700 ${shellQuote(dir)}`,
    `if [ -f ${shellQuote(path)} ]; then cp ${shellQuote(path)} ${shellQuote(`${path}.previous`)}; fi`,
    `cat > ${shellQuote(`${path}.new`)}`,
    `mv -f ${shellQuote(`${path}.new`)} ${shellQuote(path)}`,
    `if ! ${RELOAD_COMMAND[input.proxy]}; then`,
    `  if [ -f ${shellQuote(`${path}.previous`)} ]; then mv -f ${shellQuote(`${path}.previous`)} ${shellQuote(path)}; else rm -f ${shellQuote(path)}; fi`,
    "  exit 1",
    "fi",
    `rm -f ${shellQuote(`${path}.previous`)}`,
  ].join("\n");
  const result = await remote.run(cmd, { input: input.content, timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Failed to update ${path} and reload ${input.proxy} on the server (exit code ${result.exitCode}).`,
      {
        hint: "Re-run `opscrew rotate edge-origin-token` once the server is reachable; the previous token is still accepted.",
      },
    );
  }
}

/**
 * Rotates the per-app shared origin-verification token with zero downtime:
 * approve -> server dual-accept (`[next, previous]`) -> edge switch (`next`) -> server narrow (`[next]`).
 */
export async function rotateEdgeOriginToken(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: EdgeOriginTokenRotationOptions,
): Promise<EdgeOriginTokenRotationResult> {
  if (!usesSharedOriginHeader(plan)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "This environment does not use a shared-header edge provider, so there is no edge-origin-token to rotate. Nothing was changed.",
    );
  }
  const edgeId = activeEdgeProvider(plan);
  if (edgeId === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "This environment has no active edge provider, so there is no edge-origin-token to rotate. Nothing was changed.",
    );
  }
  const edge = edgeProvider(edgeId);
  const headerName = edge.capabilities.originAuthHeader;
  const connector = edge.connector;
  if (
    headerName === undefined ||
    connector?.planOriginHeader === undefined ||
    connector.applyOriginHeader === undefined
  ) {
    throw new OpsCrewError(
      "INTERNAL",
      `Edge provider "${edgeId}" does not define a shared-header rotation connector.`,
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

  const { envVar, apiKey } = requireThirdPartyEdgeKey(deps, edgeId);
  let resourceId = options.resourceId;
  if (resourceId === undefined) {
    const idOutputName = edge.terraform.root?.resourceIdOutput;
    const outputs =
      idOutputName === undefined
        ? undefined
        : await infrastructureOutputs(deps, plan, {
            ...(options.services?.engine === undefined ? {} : { engine: options.services.engine }),
            ...(options.preference === undefined ? {} : { preference: options.preference }),
            engineEnv: { [envVar]: apiKey },
          });
    const raw = idOutputName === undefined ? undefined : outputs?.[idOutputName];
    resourceId = raw === undefined || raw === null ? undefined : String(raw);
  }
  if (resourceId === undefined || resourceId === "") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew could not read the ${edge.displayName} resource id from Terraform state. Nothing was changed.`,
      {
        hint: "Run `opscrew provision` first so the edge resource exists in state, then try again.",
      },
    );
  }
  const proxy = edgeProxy(plan);
  const serverPath = originTokenServerPath(proxy, plan.app.name);
  const command = options.command ?? "opscrew rotate edge-origin-token";

  // B4: If an earlier rotation stopped after recording `previous`, resume with that exact pair so
  // the token the edge may still be sending is never dropped.
  const resuming = existing.previous !== undefined;
  const next = resuming
    ? existing.current
    : generateEdgeOriginToken(options.randomBytes ?? nodeRandomBytes);
  const previous = resuming ? (existing.previous as string) : existing.current;
  deps.redactor.addLiteral(next, "edge-origin-token");
  deps.redactor.addLiteral(previous, "edge-origin-token");

  // Plan and approve BEFORE mutating any local file, server file, GitHub secret, or edge rule.
  const edgePlan = await connector.planOriginHeader({
    apiKey,
    resourceId,
    headerName,
    token: next,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    redactor: deps.redactor,
  });

  await requestApproval(deps, {
    kind: "iac-apply",
    title: `Rotate ${headerName} on ${edge.displayName} (${resourceId}) and the server's ${proxy}`,
    details: [
      resuming
        ? "Resuming unfinished edge-origin-token rotation with the recorded token pair."
        : "Zero-downtime rotation: server accepts both tokens -> edge switches -> server narrows to the new token.",
      edgePlan.summary,
      `Plan hash: ${edgePlan.hash}`,
    ].join("\n"),
    hash: edgePlan.hash,
    refused: {
      plan: `${edge.displayName} origin-token rotation`,
      unchanged: "Nothing was changed locally, on your server, in GitHub, or at the edge provider.",
      again: command,
    },
  });
  await deps.approvals.assertApprovedPlan(edgePlan.hash);

  const secretPlace =
    options.github === undefined
      ? undefined
      : deploySecretPlace(plan, DEPLOY_SECRETS.edgeOriginToken);

  // Step 1: Persist { current: next, previous } locally, update deploy secret, and enable dual-accept on server.
  await writeEdgeOriginToken(deps, { current: next, previous });
  if (secretPlace !== undefined && options.github !== undefined) {
    await setSecretAt(
      deps,
      options.github,
      secretPlace,
      formatEdgeOriginTokenSecret({ current: next, previous }),
    );
  }
  const dualSnippet = originTokenSnippet(proxy, headerName, [next, previous]);
  await installSnippetOnServer(deps, plan, {
    proxy,
    serverPath,
    content: dualSnippet,
    ...(options.remote === undefined ? {} : { remote: options.remote }),
  });

  // Step 2: Switch the edge provider to `next` using the approved hash.
  const applied = await connector.applyOriginHeader({
    apiKey,
    plan: edgePlan,
    token: next,
    approvedHash: edgePlan.hash,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    redactor: deps.redactor,
  });

  // Step 3: Narrow the server to accept ONLY [next], update deploy secret, and drop `previous` locally.
  const narrowSnippet = originTokenSnippet(proxy, headerName, [next]);
  await installSnippetOnServer(deps, plan, {
    proxy,
    serverPath,
    content: narrowSnippet,
    ...(options.remote === undefined ? {} : { remote: options.remote }),
  });
  if (secretPlace !== undefined && options.github !== undefined) {
    await setSecretAt(
      deps,
      options.github,
      secretPlace,
      formatEdgeOriginTokenSecret({ current: next }),
    );
  }
  await writeEdgeOriginToken(deps, { current: next });
  await recordRotation(deps, [EDGE_ORIGIN_TOKEN_CREDENTIAL]);
  const copy = await refreshRecoveryCopy(deps, plan);

  return {
    rotated: applied.applied || resuming,
    edgePlanHash: edgePlan.hash,
    serverPath,
    proxy,
    copy,
  };
}

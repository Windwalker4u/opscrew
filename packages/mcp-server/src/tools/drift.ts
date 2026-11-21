import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type PhaseDeps,
  type ProvisionServices,
  readOwnServer,
  renderDriftReport,
  runDrift,
} from "@opscrew/agents";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { CLOUD_NAMES } from "../providers";
import {
  type CallExtra,
  clientSupportsElicitation,
  dialogHandler,
  hostKeyNeedsTerminal,
} from "./elicitation";
import {
  appInput,
  environmentInput,
  projectDirInput,
  runTool,
  type ToolCall,
  toolEnvironment,
} from "./shared";

/** Test-only collaborators for `opscrew_drift` (production uses the real ones). */
export interface DriftToolOptions {
  /** Engine, cloud provider, Cloudflare and own-server fakes (same shape as provision's). */
  services?: ProvisionServices;
}

/**
 * The phase deps of a drift check. On a server the user owns whose SSH host key this computer
 * never confirmed, the user confirms it in a dialog (MCP elicitation); the model cannot supply
 * one, and a client without dialogs gets the terminal command instead. Every other deployment
 * gets the plain, non-interactive deps. `app` is a further app's key (`undefined`: the first app).
 */
async function driftPhaseDeps(
  server: McpServer,
  deps: ResolvedMcpDeps,
  call: ToolCall,
  extra: CallExtra,
  app: string | undefined,
  environment: string,
): Promise<PhaseDeps> {
  const paths = resolveProjectPaths(call.projectDir, { env: deps.env, app, environment });
  const plan = await readArtifact("plan", paths.files.plan).catch(() => undefined);
  if (plan?.target.provider !== "own") return call.phaseDeps({ app, environment });
  const recorded = await readOwnServer(paths).catch(() => undefined);
  if (recorded === undefined || recorded.hostKey !== undefined) {
    return call.phaseDeps({ app, environment });
  }
  if (!clientSupportsElicitation(server))
    throw hostKeyNeedsTerminal("drift", "Nothing was checked.");
  const phase = await call.phaseDeps({
    approvalHandler: dialogHandler(server, deps, extra),
    app,
    environment,
  });
  // Only the first connection asks (a dialog for the user); a pinned key is checked silently.
  return { ...phase, interactive: true };
}

/**
 * `opscrew_drift`: the `opscrew drift` report: resources changed outside OpsCrew, changes not
 * applied yet and generated files that differ; on a server the user owns, also how the server
 * differs from what OpsCrew set up (never its address); in the user's Portainer, how its stacks,
 * registry entry and deploy branch differ (never Portainer's address or a value). Never changes
 * infrastructure, the server, Portainer or repository files (temporary plan files under `.opscrew/plans` are deleted). `options` is for
 * tests only.
 */
export function registerDriftTool(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: DriftToolOptions = {},
): void {
  const services = options.services === undefined ? {} : { services: options.services };
  server.registerTool(
    "opscrew_drift",
    {
      title: "Infrastructure drift",
      description:
        "Check whether the deployment still matches opscrew/plan.yaml (cloud and Cloudflare resources, unapplied changes, generated files, the server or Portainer setup). Read-only; the user undoes drift with `npx opscrew provision`.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }, extra: CallExtra) =>
      runTool(deps, "opscrew_drift", projectDir, async (call) => {
        const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await driftPhaseDeps(server, deps, call, extra, appKey, name);
        const report = await runDrift(phase, services);
        const plan = await readArtifact("plan", phase.paths.files.plan);
        return {
          text: renderDriftReport(report, plan, flag),
          data: { ...report },
        };
      }),
  );
}

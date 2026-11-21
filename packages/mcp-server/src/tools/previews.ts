import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listPreviews, type PreviewServices, previewListLines } from "@opscrew/agents";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import {
  appInput,
  environmentInput,
  projectDirInput,
  requireServerTarget,
  runTool,
  toolEnvironment,
} from "./shared";

/**
 * `opscrew_preview_list` (spec.md US7): the previews of a preview environment, as
 * `opscrew preview list` reads them from the preview server (read-only): each preview's pull
 * request, address, state, commit and times, and how many run against the cap. Removing one stays
 * a terminal command. `options` (the deploy user's shell) is for tests only.
 */
export function registerPreviewTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: { services?: PreviewServices } = {},
): void {
  server.registerTool(
    "opscrew_preview_list",
    {
      title: "List the previews",
      description:
        "List a preview environment's pull-request previews (number, address, state, commit, age, cap). Read-only. Removing one stays in the user's terminal: `npx opscrew preview destroy <n>`; its logs: `npx opscrew preview logs <n>`.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_preview_list", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        requireServerTarget(
          plan,
          "opscrew_preview_list",
          "Previews need a server of their own: the user adds an environment for them on a server with `npx opscrew env add preview --previews --target <provider>` (or own).",
        );
        const list = await listPreviews(phase, plan, options);
        return { text: previewListLines(list, phase.clock.now()).join("\n"), data: { ...list } };
      }),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listSnapshots, type SnapshotServices, snapshotListLines } from "@opscrew/agents";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { refuseUnconfirmedOwnServer } from "./elicitation";
import { appInput, environmentInput, projectDirInput, runTool, toolEnvironment } from "./shared";

/**
 * `opscrew_snapshots` (024 US8): the environment's snapshots as `opscrew snapshot list` reads them
 * (read-only): each one's id, kind, time, the version that ran, size, services and where it is,
 * and whether its off-server copy exists. Taking, restoring and deleting one stay terminal
 * commands. On the user's own server it connects only once the server's SSH host key was
 * confirmed in a terminal. `options` (the machines' and providers' fakes) is for tests only.
 */
export function registerSnapshotsTool(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: { services?: SnapshotServices } = {},
): void {
  server.registerTool(
    "opscrew_snapshots",
    {
      title: "List the snapshots",
      description:
        "List an environment's data snapshots, newest first, with kind, time, version, size, services, place and off-server copy. Read-only. Taking, restoring (`npx opscrew restore <id>`), deleting and scheduling snapshots stay in the user's terminal (`npx opscrew snapshot …`) because they ask for approval.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_snapshots", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        await refuseUnconfirmedOwnServer(plan, phase.paths, "snapshot list", "Nothing was read.");
        const snapshots = await listSnapshots(
          phase,
          options.services === undefined ? {} : { services: options.services },
        );
        return { text: snapshotListLines(snapshots).join("\n"), data: { snapshots } };
      }),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type RunAdviseOptions, renderAdviceReport, runAdvise } from "@opscrew/agents";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { appInput, environmentInput, projectDirInput, runTool, toolEnvironment } from "./shared";

/**
 * `opscrew_advise`: the `opscrew advise` report, read only: what to change in a deployed
 * environment, the most urgent first, each with its figures, its monthly price before and after and
 * how to apply it, as text and structured content. Applying stays a terminal command
 * (`opscrew advise --apply <id>`). `options` (the servers', GitHub's and Cloudflare's fakes) is
 * for tests only.
 */
export function registerAdviseTool(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: RunAdviseOptions = {},
): void {
  server.registerTool(
    "opscrew_advise",
    {
      title: "Advise",
      description:
        "Propose changes to a deployed environment, most urgent first (size, cost, backups, updates, alerts, expiring tokens), with reasons and prices. Read-only. Applying is a terminal command only: `npx opscrew advise --apply <id>`.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_advise", projectDir, async (call) => {
        const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const report = await runAdvise(phase, plan, options);
        return { text: renderAdviceReport(report, flag), data: { ...report } };
      }),
  );
}

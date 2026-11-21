import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { placementEstimate, resolveCatalog } from "@opscrew/agents";
import type { ComputeCatalog } from "@opscrew/contracts";
import { formatMoney, listText, OpsCrewError, orText } from "@opscrew/core";
import { readArtifact, VpsProviderSchema } from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS, cloudProvider } from "@opscrew/providers";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { CLOUD_IDS } from "../providers";
import { appInput, environmentInput, projectDirInput, runTool, toolEnvironment } from "./shared";

/** Test-only collaborators for `opscrew_placement_estimate` (production reads the provider's prices). */
export interface PlacementToolOptions {
  /** The cloud provider's catalogue (production: design's, live when its token verifies, else its dated price list). */
  catalog?: ComputeCatalog;
}

/**
 * `opscrew_placement_estimate` (feature 018, FR-1821): what one of the app's services would cost
 * on a server of its own (the server's type, size and monthly price, and the app's new monthly
 * total) and how much slower each query from the app gets, from design's estimate. Reads the plan
 * and the provider's prices; writes nothing and makes no key.
 */
export function registerPlacementTool(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: PlacementToolOptions = {},
): void {
  server.registerTool(
    "opscrew_placement_estimate",
    {
      title: "Estimate a service on a server of its own",
      description:
        "Estimate the monthly cost and per-query delay of giving one of the app's services its own server. Writes nothing; to place it, the user sets `server` on the service in opscrew/plan.yaml, then opscrew_select_design.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        service: z.string().min(1).describe("The service's name in the plan, e.g. db."),
        provider: z
          .enum(VpsProviderSchema.options)
          .describe("Where the new server would be: a cloud provider or the user's own."),
        location: z
          .string()
          .min(1)
          .optional()
          .describe("A cloud server's location, e.g. fsn1; not for own."),
        serverType: z
          .string()
          .min(1)
          .optional()
          .describe("Cloud server type; default the smallest that fits."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment, service, provider, location, serverType }) =>
      runTool(deps, "opscrew_placement_estimate", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        if (provider !== "own" && location === undefined) {
          throw new OpsCrewError(
            "INVALID_INPUT",
            `A new ${cloudProvider(provider).name} server needs its location for the estimate.`,
            {
              hint: "Pass location, for example the app's own server's location for the shortest hop.",
            },
          );
        }
        // Design's catalogue: live when the token verifies, else the dated price list, which it says.
        let catalog = options.catalog;
        if (catalog === undefined && provider !== "own") {
          const found = await resolveCatalog(phase, provider, location as string);
          if (found.warning !== undefined) phase.reporter.warn(found.warning);
          catalog = found.catalog;
        }
        const estimate = await placementEstimate({
          plan,
          service,
          server:
            provider === "own"
              ? { provider }
              : {
                  provider,
                  location: location as string,
                  ...(serverType === undefined ? {} : { serverType }),
                },
          ...(catalog === undefined ? {} : { catalog }),
        });
        const lines = [
          estimate.server === undefined
            ? `${service} on a server of yours: no server price (you already pay for it).`
            : `${service} on a new ${estimate.server.serverType} (${estimate.server.vcpus} vCPU, ${estimate.server.memoryGb} GB memory): ${formatMoney(estimate.server.cost.monthly)} per month${estimate.server.cost.source === "static" ? " (from the provider's published price list, an estimate)" : ""}.`,
          `The app's monthly total with it: ${formatMoney(estimate.total)}.`,
          estimate.delay.text,
          ...(estimate.delay.warning === undefined ? [] : [estimate.delay.warning]),
        ];
        return { text: lines.join("\n"), data: { service, provider, ...estimate } };
      }),
  );
}

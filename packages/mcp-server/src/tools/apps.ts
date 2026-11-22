import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addApp, listApps, removeApp } from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { type CallExtra, dialogHandler, REQUIRES_USER, requireDialogs } from "./elicitation";
import { projectDirInput, runTool, toolApp } from "./shared";

const KEY_INPUT = z.string().min(1).describe("App key, e.g. docs (lower-case letters, digits, -).");

/**
 * The tools for several apps in one repository (contracts/apps.md "CLI and MCP"):
 * `opscrew_app_add`, `opscrew_app_list` and `opscrew_app_remove`, which the user confirms by
 * typing the app's key in a dialog.
 */
export function registerAppTools(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_app_list",
    {
      title: "List the repository's apps",
      description:
        "List the repository's apps: the first (app .) and each further app with its key, folder and whether it is deployed. Pass a key as app to the other tools. Writes nothing.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_app_list", projectDir, async (call) => {
        const apps = await listApps((await call.phaseDeps()).paths);
        const lines = apps.map(
          (app) =>
            `- ${app.key ?? "the first app (app .)"}: in ${app.dir}, ${app.deployed ? "deployed" : "not deployed"}`,
        );
        return { text: ["The repository's apps:", ...lines].join("\n"), data: { apps } };
      }),
  );

  server.registerTool(
    "opscrew_app_add",
    {
      title: "Add an app of the repository",
      description:
        "Add a further app in its own folder of the repository (checks the folder and that its names are free) and write opscrew/apps/<key>/app.yaml. Next: the planning tools with app set to its key.",
      inputSchema: {
        ...projectDirInput,
        key: KEY_INPUT,
        dir: z.string().min(1).describe("Its folder, e.g. sites/docs."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ projectDir, key, dir }) =>
      runTool(deps, "opscrew_app_add", projectDir, async (call) => {
        const app = await addApp(call.projectDir, key.trim(), dir);
        return {
          text: `Added the app ${app.key} in ${app.dir} (opscrew/apps/${app.key}/app.yaml). Next: call opscrew_interview_questions with app ${app.key}, then opscrew_save_requirements and the design tools with app ${app.key}.`,
          data: { app },
        };
      }),
  );

  server.registerTool(
    "opscrew_app_remove",
    {
      title: "Remove an app of the repository",
      description:
        "Remove a further app's OpsCrew files and local data; its folder stays. Refused while deployed (`npx opscrew destroy --app <key>` first) and for the first app. Only when the user asks; they type its key in a dialog.",
      inputSchema: { ...projectDirInput, key: KEY_INPUT },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, key }, extra: CallExtra) =>
      runTool(deps, "opscrew_app_remove", projectDir, async (call) => {
        const appKey = await toolApp(call.projectDir, key);
        requireDialogs(server, `npx opscrew app remove ${key.trim()}`);
        const phase = await call.phaseDeps({
          approvalHandler: dialogHandler(server, deps, extra),
          app: appKey,
        });
        // removeApp refuses the first app, a deployed one and one whose GitHub Pages verification
        // record may still be in DNS before it asks. It deletes the app's deploy keys,
        // passphrases and secrets: the user types its key.
        const removed = await removeApp(phase, {
          confirm: async (name) => {
            const approval = await phase.approvals.request({
              kind: "repo-write",
              title: `Remove the app ${name}'s files`,
              details: `This removes the app ${name}'s files: its record, plans and answers in opscrew/apps/${name}, its infrastructure code and deploy workflows, and what OpsCrew keeps for it on this computer (its deploy keys, state passphrases and generated secrets). Its folder in the repository stays.`,
              allowDestroy: true,
              confirmPhrase: name,
            });
            if (!approval.approved) {
              throw new OpsCrewError(
                "APPROVAL_REFUSED",
                `The user did not confirm removing the app ${name}, so nothing was removed.`,
                { hint: "Call opscrew_app_remove again only when the user asks." },
              );
            }
          },
        });
        return {
          text: `Removed the app ${appKey}'s files${removed.length === 0 ? "; none were left" : `: ${removed.join(", ")}`}.`,
          data: { removed },
        };
      }),
  );
}

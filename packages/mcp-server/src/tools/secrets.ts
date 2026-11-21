import { readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  COPY_PATH,
  type ProvisionServices,
  publishRotatedKey,
  recoveryStatus,
  recoveryStatusLines,
  requireGitRepo,
  restoreConflictText,
  restoreRecoveryCopy,
  setRecoveryFolder,
  setupGitHub,
} from "@opscrew/agents";
import { errorText, listText, OpsCrewError, plural } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { type CallExtra, dialogHandler, REQUIRES_USER, requireDialogs } from "./elicitation";
import {
  appInput,
  environmentInput,
  IDEMPOTENT_WRITE,
  projectDirInput,
  runTool,
  toolEnvironment,
} from "./shared";

/** Test-only collaborators for the secrets tools. */
export interface SecretsToolOptions {
  /** The GitHub fake `opscrew_secrets_rotate` opens its pull request with. */
  provisionServices?: Pick<ProvisionServices, "github">;
}

/** A full path the user chose, refused plainly otherwise (the model never invents one). */
function fullPath(file: string, what: string): string {
  if (path.isAbsolute(file)) return file;
  throw new OpsCrewError("INVALID_INPUT", `${what} must be a full path, not ${file}.`, {
    hint: "Ask the user for the full path of the file, then call the tool again.",
  });
}

/**
 * The recovery copy's tools: `opscrew_secrets_status`, `opscrew_secrets_restore` (reads only the
 * user's key file), `opscrew_secrets_rotate` (writes the new key only to `keyOut`) and
 * `opscrew_secrets_folder`. No result ever contains a key. `options` is for tests only.
 */
export function registerSecretsTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: SecretsToolOptions = {},
): void {
  server.registerTool(
    "opscrew_secrets_status",
    {
      title: "Recovery copy status",
      description: `Show the encrypted recovery copy of OpsCrew's local files (${COPY_PATH}): last update, how many keys open it, whether it is behind, and its folder copy. Writes nothing.`,
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_secrets_status", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const copy = await recoveryStatus(await call.phaseDeps({ app: appKey, environment: name }));
        return { text: recoveryStatusLines(copy).join("\n"), data: { ...copy } };
      }),
  );

  server.registerTool(
    "opscrew_secrets_restore",
    {
      title: "Restore from the recovery copy",
      description:
        "Rebuild OpsCrew's local files from the encrypted recovery copy with the age key file the user names. On a conflict nothing is written: ask the user which side to keep, then call again with onConflict.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        keyFile: z
          .string()
          .min(1)
          .describe("Full path of the user's age key file, named by the user."),
        from: z
          .string()
          .optional()
          .describe(`Another copy to restore from (default ${COPY_PATH}).`),
        onConflict: z
          .enum(["use-copy", "keep-local"])
          .optional()
          .describe("Only after the user chose which side to keep."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, app, environment, keyFile, from, onConflict }) =>
      runTool(deps, "opscrew_secrets_restore", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const file = fullPath(keyFile, "keyFile");
        let identity: string;
        try {
          identity = await readFile(file, "utf8");
        } catch (error) {
          throw new OpsCrewError("INVALID_INPUT", `OpsCrew could not read the key file ${file}.`, {
            hint: `Ask the user to check the path of their age key file (${errorText(error)}).`,
          });
        }
        const result = await restoreRecoveryCopy(
          await call.phaseDeps({ app: appKey, environment: name }),
          {
            identity,
            ...(from !== undefined ? { from: fullPath(from, "from") } : {}),
            ...(onConflict !== undefined ? { onConflict } : {}),
          },
        );
        if (result.conflicts !== undefined) {
          return {
            text: `${restoreConflictText(result.conflicts)} Ask the user which side to keep, then call opscrew_secrets_restore again with onConflict use-copy or keep-local.`,
            data: { restored: [], conflicts: result.conflicts },
          };
        }
        return {
          text:
            result.restored.length === 0
              ? "This computer already has every file in the recovery copy; nothing was written."
              : `Restored ${plural(result.restored.length, "file")}: ${listText(result.restored)}. The next provision reuses them, so nothing is generated again.`,
          data: { restored: result.restored },
        };
      }),
  );

  server.registerTool(
    "opscrew_secrets_rotate",
    {
      title: "New key for the recovery copy",
      description:
        "Make a new age key for the recovery copy, write it once to keyOut, re-encrypt the copy and propose it in a pull request, each step approved by the user in a dialog.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        keyOut: z
          .string()
          .min(1)
          .describe("New key file path outside the repo, chosen by the user."),
        backup: z
          .string()
          .nullable()
          .optional()
          .describe("Backup public key (age1…) to use instead; null drops it; omit to keep it."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, app, environment, keyOut, backup }, extra: CallExtra) =>
      runTool(deps, "opscrew_secrets_rotate", projectDir, async (call) => {
        const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
        const file = fullPath(keyOut, "keyOut");
        requireDialogs(server, `npx opscrew rotate recovery-key${flag} --key-out ${file}`);
        const phase = await call.phaseDeps({
          approvalHandler: dialogHandler(server, deps, extra),
          app: appKey,
          environment: name,
        });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const git = await requireGitRepo(phase);
        const github = await setupGitHub(phase, git, options.provisionServices ?? {});
        const rotated = await publishRotatedKey(phase, {
          git,
          github,
          plan,
          keyOut: file,
          ...(backup !== undefined ? { backup } : {}),
        });
        return {
          text: [
            rotated.message,
            ...(rotated.prUrl !== undefined ? [`Pull request: ${rotated.prUrl}`] : []),
          ].join("\n"),
          data: {
            keyFile: rotated.handover.path,
            branch: rotated.branch,
            pushed: rotated.pushed,
            ...(rotated.prUrl !== undefined ? { prUrl: rotated.prUrl } : {}),
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_secrets_folder",
    {
      title: "Folder for the recovery copy",
      description:
        "Set a folder outside the repository, chosen by the user, that also gets the recovery copy on each change, or null to stop. This computer's setting.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        folder: z.string().min(1).nullable().describe("Full folder path, or null to stop."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectDir, app, environment, folder }) =>
      runTool(deps, "opscrew_secrets_folder", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        await setRecoveryFolder(
          await call.phaseDeps({ app: appKey, environment: name }),
          folder ?? undefined,
        );
        return {
          text:
            folder === null
              ? "OpsCrew no longer writes a folder copy of the recovery copy."
              : `OpsCrew writes the recovery copy to ${folder} as well, each time it changes.`,
          data: { folder },
        };
      }),
  );
}

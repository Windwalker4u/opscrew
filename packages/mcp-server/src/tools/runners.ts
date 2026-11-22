import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  addRunnerHost,
  applyRunnerHost,
  listRunnerHosts,
  type RunnerGitHubApi,
  type RunnerHardening,
  type RunnerHardeningChange,
  type RunnerHostServices,
  removeRunnerHost,
  setRunnerHost,
} from "@opscrew/agents";
import { isUserFacingError, listText, OpsCrewError, upperFirst } from "@opscrew/core";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { type CallExtra, dialogHandler, REQUIRES_USER, requireDialogs } from "./elicitation";
import { projectDirInput, runTool, withHint } from "./shared";

/** Test-only collaborators for the runner machine tools. */
export interface RunnerHostToolOptions {
  /** The runner machine's shell and host adapter (production: SSH with its recorded login). */
  machine?: RunnerHostServices;
  /** GitHub's runner API (production: the client of the user's token). */
  github?: RunnerGitHubApi;
}

const NAME_INPUT = z.string().min(1).describe("Its name in the project, e.g. home.");

/** The terminal command that adds the machine `name`, without its address. */
const addCommand = (name: string) => `npx opscrew runner host add ${name} --ssh <user@host[:port]>`;

const PARTS = z
  .array(z.enum(["ssh", "firewall"]))
  .min(1)
  .optional();

/** The hardening inputs, as the CLI's `--harden`, `--no-harden` and `--ssh-from`. */
const HARDEN_INPUTS = {
  harden: PARTS.describe("Only when the user asks: ssh and/or firewall."),
  sshFrom: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("With firewall: addresses the user names that may reach SSH."),
};

/** The change the hardening inputs ask for (`on`, `off`, `sshFrom`). */
function hardeningChange(input: {
  harden?: RunnerHardeningChange["on"];
  noHarden?: RunnerHardeningChange["off"];
  sshFrom?: string[];
}): RunnerHardeningChange {
  return {
    ...(input.harden === undefined ? {} : { on: input.harden }),
    ...(input.noHarden === undefined ? {} : { off: input.noHarden }),
    ...(input.sshFrom === undefined ? {} : { sshFrom: input.sshFrom }),
  };
}

/**
 * The hardening the user chose, applied with the machine's next approved host plan:
 * `hardening chosen: SSH and SSH firewall`, or `no hardening chosen`.
 */
function hardeningText(harden: RunnerHardening | undefined): string {
  const parts = [
    ...(harden?.ssh ? ["SSH"] : []),
    ...(harden?.firewall !== undefined ? ["SSH firewall"] : []),
  ];
  return parts.length === 0 ? "no hardening chosen" : `hardening chosen: ${listText(parts)}`;
}

/**
 * Re-throws a refusal (the user declined or cancelled a dialog) with a next step that never names
 * `--approve`: the user asked again, here or in the terminal, where each plan is shown first.
 */
function declined(error: unknown, tool: string, terminal: string): never {
  if (isUserFacingError(error) && error.code === "APPROVAL_REFUSED") {
    withHint(
      error,
      `Call ${tool} again only when the user asks, or ask them to run \`${terminal}\` in a terminal in the project directory.`,
    );
  }
  throw error;
}

/**
 * The runner machine tools (contracts/runners.md "Runner machines"): `opscrew_runner_host_list`,
 * `opscrew_runner_host_add` and `opscrew_runner_host_set` (its hardening, FR-1536), whose host
 * plan only the user approves in a dialog, and `opscrew_runner_host_remove`, which the user
 * confirms by typing the machine's name. The machine's address and login, and the addresses its
 * SSH firewall lets in, stay on the user's computer. `options` is for tests only.
 */
export function registerRunnerHostTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: RunnerHostToolOptions = {},
): void {
  const services = options.machine === undefined ? {} : { services: options.machine };

  server.registerTool(
    "opscrew_runner_host_list",
    {
      title: "List the runner machines",
      description:
        "List the runner machines this computer knows: CPU, Docker, the chosen hardening and the environments using each. Never their address. Writes nothing.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_runner_host_list", projectDir, async (call) => {
        const machines = (await listRunnerHosts(await call.phaseDeps())).map(
          ({ harden, ...machine }) => ({
            ...machine,
            hardened: [
              ...(harden?.ssh ? ["ssh"] : []),
              ...(harden?.firewall !== undefined ? ["firewall"] : []),
            ],
            text: hardeningText(harden),
          }),
        );
        const lines = machines.map(
          (machine) =>
            `- ${machine.name}: ${machine.arch}, ${machine.docker ? "Docker installed" : "Docker not installed yet"}, ${machine.text}, ${machine.environments.length === 0 ? "no environment's deploy job" : `the deploy jobs of ${machine.environments.join(", ")}`}`,
        );
        return {
          text:
            machines.length === 0
              ? "This computer knows no runner machine for this project. The user adds one with opscrew_runner_host_add, or in a terminal with `npx opscrew runner host add <name> --ssh <user@host[:port]>`."
              : ["The project's runner machines:", ...lines].join("\n"),
          data: { machines: machines.map(({ text: _text, ...machine }) => machine) },
        };
      }),
  );

  server.registerTool(
    "opscrew_runner_host_add",
    {
      title: "Set up a runner machine",
      description:
        "Set up a machine of the user's as a runner machine over SSH (key file or agent, never a password), with optional hardening; its host plan is applied only after the USER approves it in a dialog. Then opscrew_env_set with runner host.",
      inputSchema: {
        ...projectDirInput,
        name: NAME_INPUT,
        user: z.string().min(1).describe("SSH user: root or one with passwordless sudo."),
        host: z.string().min(1).describe("Its address or host name, from the user."),
        port: z.number().int().min(1).max(65535).optional().describe("SSH port (default 22)."),
        keyFile: z
          .string()
          .min(1)
          .optional()
          .describe("Private key file path; omit for the SSH agent."),
        ...HARDEN_INPUTS,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, name, user, host, port, keyFile, harden, sshFrom }, extra: CallExtra) =>
      runTool(deps, "opscrew_runner_host_add", projectDir, async (call) => {
        requireDialogs(server, addCommand(name));
        const dialogs = dialogHandler(server, deps, extra);
        const phase = await call.phaseDeps({ approvalHandler: dialogs });
        // The first connection's host key is confirmed by the user in a dialog.
        const asking = { ...phase, interactive: true };
        let hash: string;
        try {
          const added = await addRunnerHost(asking, {
            name,
            ssh: { user, host, ...(port === undefined ? {} : { port }) },
            ...(keyFile === undefined ? {} : { keyFile }),
            harden: hardeningChange({
              ...(harden === undefined ? {} : { harden }),
              ...(sshFrom === undefined ? {} : { sshFrom }),
            }),
            ...services,
          });
          hash = added.hash;
          await applyRunnerHost(asking, { name, approvedHash: hash, ...services });
        } catch (error) {
          declined(error, "opscrew_runner_host_add", addCommand(name));
        }
        const applied = dialogs.decisions.some((d) => d.kind === "host-apply" && d.approved);
        return {
          text: [
            applied
              ? `Set up the runner machine ${name} (host plan ${hash}).`
              : `The runner machine ${name} is set up already; nothing on it changed.`,
            `Next: an environment runs its deploy job there with opscrew_env_set (runner "host", runnerHost "${name}"; build "runner" to build its image there too), then opscrew_plan and opscrew_apply with that environment.`,
          ].join("\n"),
          data: { name, hostPlanHash: hash, applied, approvals: dialogs.decisions },
        };
      }),
  );

  server.registerTool(
    "opscrew_runner_host_set",
    {
      title: "Change a runner machine's hardening",
      description:
        "Change a runner machine's hardening, only when the user asks (harden turns parts on, noHarden off); applied after the USER approves its host plan in a dialog.",
      inputSchema: {
        ...projectDirInput,
        name: NAME_INPUT,
        ...HARDEN_INPUTS,
        noHarden: PARTS.describe("Parts to turn off."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, name, harden, noHarden, sshFrom }, extra: CallExtra) =>
      runTool(deps, "opscrew_runner_host_set", projectDir, async (call) => {
        const terminal = `npx opscrew runner host set ${name} --harden ssh|firewall`;
        if (harden === undefined && noHarden === undefined) {
          throw new OpsCrewError("INVALID_INPUT", "Name what to change: harden or noHarden.", {
            hint: 'For example harden ["firewall"] with sshFrom the user names, or noHarden ["ssh"].',
          });
        }
        requireDialogs(server, terminal);
        const dialogs = dialogHandler(server, deps, extra);
        const phase = await call.phaseDeps({ approvalHandler: dialogs });
        let hash: string;
        try {
          const set = await setRunnerHost(phase, {
            name,
            harden: hardeningChange({
              ...(harden === undefined ? {} : { harden }),
              ...(noHarden === undefined ? {} : { noHarden }),
              ...(sshFrom === undefined ? {} : { sshFrom }),
            }),
            ...services,
          });
          hash = set.hash;
          await applyRunnerHost(phase, {
            name,
            approvedHash: hash,
            command: `opscrew runner host set ${name}`,
            ...services,
          });
        } catch (error) {
          declined(error, "opscrew_runner_host_set", terminal);
        }
        const applied = dialogs.decisions.some((d) => d.kind === "host-apply" && d.approved);
        const [machine] = (await listRunnerHosts(phase)).filter((item) => item.name === name);
        return {
          text: `${applied ? `Changed the runner machine ${name} (host plan ${hash}).` : `Nothing on the runner machine ${name} changed.`} ${upperFirst(hardeningText(machine?.harden))}.`,
          data: { name, hostPlanHash: hash, applied, approvals: dialogs.decisions },
        };
      }),
  );

  server.registerTool(
    "opscrew_runner_host_remove",
    {
      title: "Remove a runner machine",
      description:
        "Undo OpsCrew's setup on a runner machine and forget its login. Refused while an environment's deploy job runs there. Only when the user asks; they type its name in a dialog.",
      inputSchema: { ...projectDirInput, name: NAME_INPUT },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, name }, extra: CallExtra) =>
      runTool(deps, "opscrew_runner_host_remove", projectDir, async (call) => {
        const terminal = `npx opscrew runner host remove ${name}`;
        requireDialogs(server, terminal);
        const dialogs = dialogHandler(server, deps, extra);
        const phase = await call.phaseDeps({ approvalHandler: dialogs });
        try {
          await removeRunnerHost(phase, {
            name,
            ...services,
            ...(options.github === undefined ? {} : { runnerGitHub: options.github }),
          });
        } catch (error) {
          declined(error, "opscrew_runner_host_remove", terminal);
        }
        return {
          text: `OpsCrew no longer keeps the runner machine ${name} on this computer.`,
          data: { name, approvals: dialogs.decisions },
        };
      }),
  );
}

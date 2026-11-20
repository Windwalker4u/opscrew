import type {
  CommandResult,
  CommandRunner,
  RemoteExec,
  ServerSnapshotApi,
} from "@opscrew/contracts";
import type { TcpConnect } from "@opscrew/secops";
import type { SetupOutcome } from "../shared";
import { HOST_KEY } from "./deploy";
import { ScriptedRunner } from "./deps";

/** The SSH host key a server presents once OpsCrew installed it again (tests only). */
export const NEW_HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewHostKeyForTestsOnlyNewHostKeyForTestsOnly";

/** A command that found nothing. */
const FAILED: CommandResult = { exitCode: 1, stdout: "", stderr: "No such file or directory" };

/** The provider's id of {@link FakeFirstBoot}'s server, as the fake engine's outputs give it. */
export const FIRST_BOOT_SERVER_ID = "4711";

/**
 * cloud-init's errors of a failed first boot, as the live Contabo server's of 2026-11-20 read:
 * the provider's own first-boot command, the package install and OpsCrew's setup script. Each
 * quotes its command and `quoted` (a test's marker), which OpsCrew must never show.
 */
export function firstBootErrors(quoted: string): string[] {
  return [
    `('bootcmd', ProcessExecutionError("Unexpected error while running command.\\nCommand: ['/bin/sh', '-c', 'echo ${quoted}']\\nExit code: 1"))`,
    `('package_update_upgrade_install', ProcessExecutionError("Unexpected error while running command.\\nCommand: ['eatmydata', 'apt-get', 'install', '${quoted}']\\nExit code: 100"))`,
    "('scripts_user', RuntimeError('Runparts: 1 failures (runcmd) in 1 attempted commands'))",
  ];
}

export interface FirstBootOptions {
  /** Whether SSH opens at the first boot; false: only after a restart (default true). */
  network?: boolean;
  /** How the first boot's setup came out (default `failed`). */
  setup?: SetupOutcome;
  /** cloud-init's errors once its setup failed (default none). */
  errors?: string[];
  /** How many host key scans the old system still answers after an install (default 2). */
  oldScans?: number;
  /** How the setup comes out after an install (default `ready`). */
  setupAfterInstall?: SetupOutcome;
  /** Whether the provider's connector has `restart` and `reinstall` (default true). */
  repairs?: boolean;
  /** The deploy user's shell for every other command (default: each fails). */
  base?: (host: string) => RemoteExec;
}

/**
 * A server OpsCrew just created whose first boot a test scripts (FR-3108 to FR-3110): its SSH port
 * ({@link tcpConnect}), the deploy user's shell ({@link remote}: the setup's probe and cloud-init's
 * result), its host key ({@link runner}'s `ssh-keyscan`, the old system's for a few scans after an
 * install) and its provider's API ({@link servers}), which records each restart and install.
 */
export class FakeFirstBoot {
  /** The provider calls, in order: `restart <id>`, `reinstall <id>`. */
  readonly calls: string[] = [];
  /** What the last install was given. */
  installed: { image: string; userData: string } | undefined;
  private open: boolean;
  private setup: SetupOutcome;
  private key = HOST_KEY;
  private oldScans: number;
  private installing = false;

  constructor(private readonly options: FirstBootOptions = {}) {
    this.open = options.network ?? true;
    this.setup = options.setup ?? "failed";
    this.oldScans = options.oldScans ?? 2;
  }

  /** The provider's server API; only `restart` and `reinstall` are used here. */
  get servers(): ServerSnapshotApi {
    const unused = async (): Promise<never> => {
      throw new Error("not used by a first boot's repair");
    };
    const api: ServerSnapshotApi = {
      findAppServers: async () => [],
      snapshotServer: unused,
      listSnapshots: unused,
      deleteSnapshot: unused,
      rebuild: unused,
      powerOff: unused,
      powerOn: unused,
    };
    if (this.options.repairs === false) return api;
    return {
      ...api,
      restart: async (serverId) => {
        this.calls.push(`restart ${serverId}`);
        this.open = true;
      },
      reinstall: async (serverId, request) => {
        this.calls.push(`reinstall ${serverId}`);
        this.installed = request;
        this.installing = true;
      },
    };
  }

  readonly tcpConnect: TcpConnect = async () => this.open;

  readonly remote = (host: string): RemoteExec => ({
    host,
    run: async (command) =>
      this.run(command) ?? (await this.options.base?.(host).run(command)) ?? FAILED,
  });

  /** `base` (default: every command succeeds), with `ssh-keyscan` answering as this server. */
  runner(base: CommandRunner = new ScriptedRunner()): ScriptedRunner {
    return new ScriptedRunner((command, args, options) =>
      command === "ssh-keyscan"
        ? { exitCode: 0, stdout: `${args[args.length - 1]} ${this.scan()}\n`, stderr: "" }
        : base.run(command, args, options),
    );
  }

  /** The key the server answers with: the old system's for a while after an install. */
  private scan(): string {
    if (this.installing) {
      if (this.oldScans > 0) {
        this.oldScans--;
        return this.key;
      }
      this.installing = false;
      this.key = NEW_HOST_KEY;
      this.setup = this.options.setupAfterInstall ?? "ready";
    }
    return this.key;
  }

  /** The first boot's answer to `command`; none for any other command. */
  private run(command: string): CommandResult | undefined {
    const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    if (command.includes("/var/lib/opscrew-ready")) {
      return ok(`${this.setup === "running" ? "waiting" : this.setup}\n`);
    }
    if (command === "cat /var/lib/cloud/data/result.json" && this.setup === "failed") {
      return ok(JSON.stringify({ v1: { datasource: null, errors: this.options.errors ?? [] } }));
    }
    return command.includes("result.json") ? FAILED : undefined;
  }
}

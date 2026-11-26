import { runnerDir } from "./constants";
import { shellQuote } from "./shell";

/**
 * The systemd user unit OpsCrew writes for `app`'s runner (deploy's `runnerUnit(app)`).
 *
 * `run.sh` runs through `sg docker`, so the runner and its jobs have the docker group from
 * /etc/group whatever groups deploy's user manager has: the manager keeps the groups it started
 * with, so one started before deploy joined docker (a login while the server was being set up)
 * gives its services no docker group, and on a server OpsCrew created only root could restart it.
 * deploy is a member, so `sg` asks no password.
 *
 * A stop signals every process of the unit (`KillMode=control-group`): `sg` runs the command in a
 * child of its own and passes no signal on, so a stop of its process alone would leave the runner
 * running. The runner's listener stops on SIGTERM.
 */
export function runnerUnitText(app: string): string {
  const command = `exec ${shellQuote(`${runnerDir(app)}/run.sh`)}`;
  // One double-quoted word for systemd: \ and " escaped, % (its specifiers) and $ (its variables)
  // doubled.
  const word = `"${command.replace(/[\\"]/g, "\\$&").replace(/[%$]/g, "$&$&")}"`;
  return [
    "[Unit]",
    `Description=GitHub Actions runner of ${app} (OpsCrew)`,
    "",
    "[Service]",
    `ExecStart=/usr/bin/sg docker -c ${word}`,
    `WorkingDirectory=${runnerDir(app)}`,
    "Restart=always",
    "RestartSec=5",
    "KillMode=control-group",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=5min",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * The systemd user unit OpsCrew writes for a self-hosted GitLab Runner of `app` (Feature 042),
 * running under the `deploy` user with `sg docker` and `KillMode=control-group` matching GitHub's.
 */
export function gitlabRunnerUnitText(app: string): string {
  const dir = runnerDir(app);
  const command = `exec ${shellQuote(`${dir}/gitlab-runner`)} run --config ${shellQuote(`${dir}/config.toml`)} --working-directory ${shellQuote(`${dir}/builds`)}`;
  const word = `"${command.replace(/[\\"]/g, "\\$&").replace(/[%$]/g, "$&$&")}"`;
  return [
    "[Unit]",
    `Description=GitLab Runner of ${app} (OpsCrew)`,
    "",
    "[Service]",
    `ExecStart=/usr/bin/sg docker -c ${word}`,
    `WorkingDirectory=${dir}`,
    "Restart=always",
    "RestartSec=5",
    "KillMode=control-group",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=5min",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface GitLabRunnerInstallOptions {
  app: string;
  instanceUrl: string;
  description: string;
  downloadUrl: string;
  sha256: string;
}

/**
 * Shell script that installs a pinned GitLab Runner binary verified by SHA-256 and registers it
 * with the shell executor, reading the `glrt-` runner authentication token ONLY from standard
 * input (never in a plan, hash, CLI argument, or log).
 */
export function gitlabRunnerInstallScript(options: GitLabRunnerInstallOptions): string {
  const dir = runnerDir(options.app);
  const bin = `${dir}/gitlab-runner`;
  const config = `${dir}/config.toml`;
  return [
    "set -eu",
    "IFS= read -r RUNNER_TOKEN",
    'if [ -z "$RUNNER_TOKEN" ]; then echo "missing GitLab runner authentication token on stdin" >&2; exit 1; fi',
    `mkdir -p ${shellQuote(dir)} ${shellQuote(`${dir}/builds`)}`,
    `curl -fsSL ${shellQuote(options.downloadUrl)} -o ${shellQuote(`${bin}.tmp`)}`,
    `printf '%s  %s\\n' ${shellQuote(options.sha256)} ${shellQuote(`${bin}.tmp`)} | sha256sum -c -`,
    `chmod 0755 ${shellQuote(`${bin}.tmp`)} && mv ${shellQuote(`${bin}.tmp`)} ${shellQuote(bin)}`,
    `${shellQuote(bin)} register --non-interactive --url ${shellQuote(options.instanceUrl)} --token "$RUNNER_TOKEN" --executor shell --description ${shellQuote(options.description)} --config ${shellQuote(config)}`,
    `chmod 0600 ${shellQuote(config)}`,
  ].join("\n");
}

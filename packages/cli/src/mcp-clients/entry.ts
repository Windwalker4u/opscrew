import { CLOUD_PROVIDERS } from "@opscrew/providers";

/** The name of OpsCrew's entry in every app's configuration. */
export const SERVER_NAME = "opscrew";

/**
 * The variables OpsCrew's MCP tools read credentials (and the login parts that go with them) from,
 * besides the cloud providers' own: Cloudflare (and the new account's token while a move to
 * another account runs), GitHub, Portainer, the registrars, a hosting account or SFTP host, the
 * add-ons, the scheduled check's webhook, the app's secrets file, the bucket keys, and OpsCrew's
 * home folder. An app's own runtime settings and GitHub Actions secrets are not among them.
 */
const OTHER_CREDENTIAL_VARIABLES = [
  "CLOUDFLARE_API_TOKEN",
  "OPSCREW_CLOUDFLARE_DEPLOY_TOKEN",
  "OPSCREW_NEW_CLOUDFLARE_API_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPSCREW_GHCR_READ_TOKEN",
  "PORTAINER_API_KEY",
  "GODADDY_API_TOKEN",
  "NAMECHEAP_API_USER",
  "NAMECHEAP_API_KEY",
  "NAMECHEAP_USERNAME",
  "NAMECHEAP_CLIENT_IP",
  "PORKBUN_API_KEY",
  "PORKBUN_SECRET_API_KEY",
  "OPSCREW_HOSTING_URL",
  "OPSCREW_HOSTING_USER",
  "OPSCREW_HOSTING_TOKEN",
  "OPSCREW_SFTP_HOST",
  "OPSCREW_SFTP_USER",
  "OPSCREW_SFTP_KEY",
  "OPSCREW_BESZEL_TOKEN",
  "OPSCREW_GRAFANA_CLOUD_TOKEN",
  "OPSCREW_CHECK_WEBHOOK",
  "OPSCREW_CHECK_NTFY_TOKEN",
  "OPSCREW_APP_ENV_FILE",
  "OPSCREW_STORAGE_ACCESS_KEY_ID",
  "OPSCREW_STORAGE_SECRET_ACCESS_KEY",
  "OPSCREW_OFFSITE_ACCESS_KEY_ID",
  "OPSCREW_OFFSITE_SECRET_ACCESS_KEY",
  "OPSCREW_OFFSITE_SFTP_KEY",
  "OPSCREW_HOME",
];

/**
 * The names (never the values) of the variables Codex forwards to OpsCrew's server from the
 * environment it starts in: every cloud provider's credential variables, then the others.
 */
export const CREDENTIAL_VARIABLES: readonly string[] = [
  ...CLOUD_PROVIDERS.flatMap((provider) => provider.credentials.envVars),
  ...OTHER_CREDENTIAL_VARIABLES,
];

/** How every app starts OpsCrew's server: `npx -y opscrew@<version> mcp`, on every OS. */
export function serverCommand(version: string): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", `opscrew@${version}`, "mcp"] };
}

/** OpsCrew's table in Codex's `config.toml`, as data. */
export function codexEntry(version: string) {
  return {
    ...serverCommand(version),
    // Codex waits 10 seconds by default, less than npx's first download of OpsCrew.
    startup_timeout_sec: 120,
    env_vars: [...CREDENTIAL_VARIABLES],
  };
}

/** {@link codexEntry} as the TOML text appended to `config.toml`, ending with a newline. */
export function codexTable(version: string): string {
  const entry = codexEntry(version);
  const quoted = (values: readonly string[]) => values.map((value) => JSON.stringify(value));
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${quoted(entry.args).join(", ")}]`,
    `startup_timeout_sec = ${entry.startup_timeout_sec}`,
    "env_vars = [",
    ...quoted(entry.env_vars).map((name) => `  ${name},`),
    "]",
    "",
  ].join("\n");
}

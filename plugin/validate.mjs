#!/usr/bin/env node
// Checks the OpsCrew plugin for Claude Code and for Codex, and the repository's marketplace file
// for each: the required fields of each format, a name and a description for every skill, and the
// MCP server pinned to the plugin's version (FR-111, FR-3209). Exit code 1 on any error.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(pluginDir, "..");
const errors = [];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${file}: ${error.message}`);
    return undefined;
  }
}

// plugin.json
const manifest = readJson(join(pluginDir, ".claude-plugin", "plugin.json"));
if (
  manifest &&
  (typeof manifest.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name))
) {
  errors.push("plugin.json: `name` must be kebab-case");
}

// .mcp.json
const mcp = readJson(join(pluginDir, ".mcp.json"));
const servers = mcp?.mcpServers;
if (mcp && (typeof servers !== "object" || servers === null || Object.keys(servers).length === 0)) {
  errors.push(".mcp.json: `mcpServers` must define at least one server");
}
for (const [name, server] of Object.entries(servers ?? {})) {
  if (typeof server.command !== "string" && typeof server.url !== "string") {
    errors.push(`.mcp.json: server ${name} needs a \`command\` (stdio) or \`url\``);
  }
}

// The MCP server runs the OpsCrew CLI that Claude Code installs from the plugin's lockfile when it
// installs the plugin, at the plugin's version (FR-111: no floating `@latest`). Claude Code installs
// only exact registry versions, and only when package.json and the lockfile list the same packages.
// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's variable, not a template.
const launcher = "${CLAUDE_PLUGIN_ROOT}/node_modules/opscrew/dist/opscrew.js";
if (mcp && !JSON.stringify(mcp).includes(launcher)) {
  errors.push(`.mcp.json: must run ${launcher}, the CLI installed from the plugin's lockfile`);
}
const pkg = readJson(join(pluginDir, "package.json"));
const lock = readJson(join(pluginDir, "package-lock.json"));
const version = manifest?.version;
if (pkg && JSON.stringify(pkg.dependencies) !== JSON.stringify({ opscrew: version })) {
  errors.push(`package.json: must depend on exactly opscrew ${version}, the plugin's version`);
}
if (lock) {
  const fix = "run `npm install --package-lock-only --ignore-scripts` in plugin/";
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    errors.push(`package-lock.json: lockfileVersion must be 2 or 3; ${fix}`);
  }
  if (JSON.stringify(lock.packages?.[""]?.dependencies) !== JSON.stringify(pkg?.dependencies)) {
    errors.push(`package-lock.json: lists other dependencies than package.json; ${fix}`);
  }
  if (lock.packages?.["node_modules/opscrew"]?.version !== version) {
    errors.push(`package-lock.json: must lock opscrew ${version}; ${fix}`);
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    if (!entry.resolved?.startsWith("https://registry.npmjs.org/") || !entry.integrity) {
      errors.push(
        `package-lock.json: ${path} must come from registry.npmjs.org with its integrity`,
      );
    }
  }
}

// skills/<name>/SKILL.md, among them the three FR-111 names
const skillsDir = join(pluginDir, "skills");
const skills = existsSync(skillsDir)
  ? readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory())
  : [];
for (const required of ["opscrew-deploy", "opscrew-scan", "opscrew-adapt"]) {
  if (!skills.includes(required)) errors.push(`skills/${required}: missing (FR-111)`);
}
for (const skill of skills) {
  const file = join(skillsDir, skill, "SKILL.md");
  if (!existsSync(file)) {
    errors.push(`skills/${skill}: missing SKILL.md`);
    continue;
  }
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(
    readFileSync(file, "utf8").replace(/\r\n/g, "\n"),
  );
  if (!frontmatter) {
    errors.push(`skills/${skill}/SKILL.md: missing YAML frontmatter`);
    continue;
  }
  const field = (key) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(frontmatter[1])?.[1].trim();
  if (field("name") !== skill) {
    errors.push(`skills/${skill}/SKILL.md: \`name\` must equal the directory name`);
  }
  if (!field("description")) errors.push(`skills/${skill}/SKILL.md: missing \`description\``);
}

// .claude-plugin/marketplace.json at the repository root
const marketplace = readJson(join(repoRoot, ".claude-plugin", "marketplace.json"));
if (marketplace) {
  if (typeof marketplace.name !== "string" || marketplace.name === "") {
    errors.push("marketplace.json: missing `name`");
  }
  if (typeof marketplace.owner?.name !== "string") {
    errors.push("marketplace.json: missing owner.name");
  }
  const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  if (entries.length === 0)
    errors.push("marketplace.json: `plugins` must list at least one plugin");
  for (const entry of entries) {
    if (typeof entry.name !== "string" || entry.source === undefined) {
      errors.push("marketplace.json: every plugin needs `name` and `source`");
    } else if (typeof entry.source === "string" && !entry.source.startsWith("./")) {
      errors.push(`marketplace.json: relative source for ${entry.name} must start with ./`);
    } else if (
      typeof entry.source === "string" &&
      !existsSync(join(repoRoot, entry.source, ".claude-plugin", "plugin.json"))
    ) {
      errors.push(`marketplace.json: source ${entry.source} has no .claude-plugin/plugin.json`);
    }
  }
}

// .codex-plugin/plugin.json, Codex's manifest (research R7 and R9): the same skills, and the server
// inline as `npx -y opscrew@<version> mcp`, since Codex installs no npm package for a plugin.
// Its paths must start with ./ and stay inside the plugin's folder.
const codex = readJson(join(pluginDir, ".codex-plugin", "plugin.json"));
const codexServer = codex?.mcpServers?.opscrew;
if (codex) {
  if (codex.name !== manifest?.name || codex.version !== version) {
    errors.push(".codex-plugin/plugin.json: `name` and `version` must equal the Claude manifest's");
  }
  if (codex.skills !== "./skills/") {
    errors.push('.codex-plugin/plugin.json: `skills` must be "./skills/", the folder both read');
  }
  const args = ["-y", `opscrew@${version}`, "mcp"];
  if (codexServer?.command !== "npx" || JSON.stringify(codexServer.args) !== JSON.stringify(args)) {
    errors.push(`.codex-plugin/plugin.json: mcpServers.opscrew must run npx ${args.join(" ")}`);
  }
  // Tokens reach the server from the user's environment, by name only: `env` holds no value.
  if (
    JSON.stringify(codexServer?.env) !== JSON.stringify({ OPSCREW_MCP_CLIENT: "codex" }) ||
    !Array.isArray(codexServer?.env_vars) ||
    !codexServer.env_vars.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))
  ) {
    errors.push(
      ".codex-plugin/plugin.json: mcpServers.opscrew must name its tokens in `env_vars` and set only OPSCREW_MCP_CLIENT in `env`",
    );
  }
}

// .agents/plugins/marketplace.json, Codex's marketplace file, which Codex reads before Claude's
// (research R9). A local source starts with ./, holds no .., and resolves from the repository's
// root. Codex refuses the whole file on a policy value it doesn't know.
const codexMarketplace = readJson(join(repoRoot, ".agents", "plugins", "marketplace.json"));
if (codexMarketplace) {
  const where = ".agents/plugins/marketplace.json";
  if (codexMarketplace.name !== marketplace?.name) {
    errors.push(`${where}: \`name\` must equal .claude-plugin/marketplace.json's`);
  }
  const entries = Array.isArray(codexMarketplace.plugins) ? codexMarketplace.plugins : [];
  if (entries.length === 0) errors.push(`${where}: \`plugins\` must list at least one plugin`);
  for (const entry of entries) {
    const path = entry.source?.source === "local" ? entry.source.path : undefined;
    if (
      typeof path !== "string" ||
      !path.startsWith("./") ||
      path.split(/[\\/]/).includes("..") ||
      !existsSync(join(repoRoot, path, ".codex-plugin", "plugin.json"))
    ) {
      errors.push(
        `${where}: ${entry.name} needs a local source "./<folder>" with a .codex-plugin/plugin.json`,
      );
    }
    if (entry.name !== codex?.name || entry.version !== version) {
      errors.push(`${where}: ${entry.name} must be the plugin ${codex?.name} at ${version}`);
    }
    const { installation = "AVAILABLE", authentication = "ON_INSTALL" } = entry.policy ?? {};
    if (
      !["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(installation) ||
      !["ON_INSTALL", "ON_USE"].includes(authentication)
    ) {
      errors.push(`${where}: ${entry.name} has a policy Codex doesn't know`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}
console.log(
  `OpsCrew plugin OK for Claude Code and Codex: ${skills.length} skills, ${Object.keys(servers ?? {}).length} MCP server(s).`,
);

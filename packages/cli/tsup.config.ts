import { defineConfig } from "tsup";
import { version } from "./package.json";
import { buildVersion, gitAt } from "./scripts/build-version.mjs";

export default defineConfig({
  entry: { opscrew: "src/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  // Workspace packages are consumed from TypeScript source, so they are bundled. Everything in
  // the `opscrew` package's `dependencies` and `peerDependencies` (commander, zod, the MCP SDK,
  // the Claude Agent SDK...) stays external, which tsup does by default; the two SDKs are listed
  // to make that explicit. The Claude Agent SDK is an optional peer that runtime-claude imports
  // only when an AI step runs, installing it once when it is missing.
  noExternal: [/^@opscrew\//],
  external: ["@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk", "openai"],
  banner: { js: "#!/usr/bin/env node" },
  // The version the CLI reports, and generated files record: the release's own only on its tag.
  define: { __OPSCREW_VERSION__: JSON.stringify(buildVersion(version, gitAt(process.cwd()))) },
});

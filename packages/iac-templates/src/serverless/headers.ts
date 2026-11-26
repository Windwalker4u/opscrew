import { posix } from "node:path";
import type { DeployPlan } from "@opscrew/plan-schema";
import { BASELINE_HEADERS, HSTS } from "../runtime/services";
import type { RenderedFile } from "../types";
import { planFilePath } from "../workflow/shared";
import { cloudflareDir, siteFiles, workersTarget } from "./site";

/**
 * OpsCrew's security headers on Cloudflare's hosting, the same as on servers: HSTS (a Worker's
 * custom domain is always HTTPS) and the baseline headers.
 */
export const SITE_HEADERS: readonly (readonly [name: string, value: string])[] = [
  ["Strict-Transport-Security", HSTS],
  ...BASELINE_HEADERS,
];

/**
 * The deploy step's program that writes OpsCrew's headers into the site's `_headers` (in the
 * folder `$SITE`), run with the runner's Node.js (`shell: node {0}`, followed by `main();`). It is
 * plain JavaScript in the committed workflow, so the user can read it; the tests run this exact
 * text. Cloudflare keeps only the last of two rules for every path (`/*`), so OpsCrew's headers go
 * into the site's own `/*` rule, after its path line, when it has one; a header that rule already
 * sets, or removes (`! Name`), stays the site's. Without one, OpsCrew's rule comes first.
 * Cloudflare applies every rule a path matches and joins a header's values with a comma, so a
 * site's value is never weakened: each later rule of the site's that sets one of OpsCrew's headers
 * gets `! Name` first, which drops OpsCrew's value there, and a header a rule before the site's
 * `/*` rule sets is left out (the step says so). The site's other lines are kept as they are.
 */
export function headersProgram(plan: DeployPlan): string {
  const headers = SITE_HEADERS.map((header) => `  ${JSON.stringify(header)},`).join("\n");
  return String.raw`// OpsCrew's security headers for the site's static files (${planFilePath(plan)}), added to its _headers.

const HEADERS = [
${headers}
];

/**
 * The site's _headers text (undefined without one) with OpsCrew's headers in its rule for "/*",
 * and the names of those OpsCrew left out (see below).
 */
function withHeaders(text) {
  const lines = text ? text.split("\n") : [];
  // Cloudflare reads a line that starts with "/" or "<scheme>://" as the path of a new rule.
  const isPath = (line) => /^(\/|[^\s]+:\/\/)/.test(line.trim());
  // Each rule: its path line, the lines up to the next one, and the headers it sets and detaches.
  const rules = [];
  lines.forEach((line, at) => {
    if (isPath(line)) rules.push({ at, path: line.trim(), sets: new Set(), detaches: new Set() });
    else if (rules.length > 0) {
      const header = line.trim();
      const rule = rules[rules.length - 1];
      if (header.startsWith("!")) rule.detaches.add(header.slice(1).trim().toLowerCase());
      else if (!header.startsWith("#") && header.includes(":")) {
        rule.sets.add(header.slice(0, header.indexOf(":")).trim().toLowerCase());
      }
    }
  });
  const all = rules.map((rule) => rule.path).lastIndexOf("/*");
  const everyPath = rules[all];
  // Cloudflare applies every rule that matches, in order, and joins a header's values with a
  // comma ("DENY, SAMEORIGIN", which browsers ignore). So a header the site's own rule for "/*"
  // sets or detaches stays the site's, and a header a rule before that rule sets is left out: only
  // a detach ("! Name") in a later rule drops what an earlier one added.
  const left = [];
  const added = HEADERS.filter(([name]) => {
    const key = name.toLowerCase();
    if (everyPath && (everyPath.sets.has(key) || everyPath.detaches.has(key))) return false;
    if (rules.slice(0, Math.max(all, 0)).some((rule) => rule.sets.has(key))) {
      left.push(name);
      return false;
    }
    return true;
  });
  // In each later rule that sets one of them, OpsCrew's value is detached first, so the site's
  // value is the only one there.
  const detach = new Map();
  for (const rule of rules) {
    if (rule === everyPath || (everyPath && rule.at < everyPath.at)) continue;
    const own = added.filter(([name]) => {
      const key = name.toLowerCase();
      return rule.sets.has(key) && !rule.detaches.has(key);
    });
    if (own.length > 0) detach.set(rule.at, own.map(([name]) => "  ! " + name));
  }
  const ours = added.map(([name, value]) => "  " + name + ": " + value);
  if (everyPath) detach.set(everyPath.at, ours);
  const merged = lines.flatMap((line, at) => [line, ...(detach.get(at) || [])]);
  const out = everyPath
    ? merged
    : ["/*", ...ours, ...(lines.length > 0 ? ["", ...merged] : [""])];
  return { text: out.join("\n"), left };
}

function main() {
  const fs = require("node:fs");
  const file = require("node:path").join(process.env.SITE, "_headers");
  const own = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  const { text, left } = withHeaders(own);
  fs.writeFileSync(file, text);
  console.log(
    own === undefined
      ? "Wrote " + file + " with OpsCrew's security headers."
      : "Added OpsCrew's security headers to " + file + ", the site's own.",
  );
  if (left.length > 0) {
    console.log(
      "Left out " + left.join(", ") + ": a rule of the site's before its rule for /* sets it, and Cloudflare would join the two values. Move that rule after the one for /* to get OpsCrew's value on every other path.",
    );
  }
}`;
}

/** The SSR headers wrapper's file name, next to the Wrangler config, which names it as `main`. */
export const HEADERS_ENTRY = "headers-entry.js";

/**
 * For `render: ssr`: `headers-entry.js` next to the environment's Wrangler config, the Worker's
 * `main`. It re-exports everything the adapter's Worker module (`site.entry`) exports, Durable
 * Object classes included, and its default export is the adapter's (its `scheduled` and other
 * handlers too) with a `fetch` that copies each response and adds {@link SITE_HEADERS} where the
 * app set none; a WebSocket's `101` passes as it is. Static files never reach the Worker (`run_worker_first` stays off), so they get
 * the same headers from `_headers` ({@link headersProgram}).
 */
export function renderHeadersEntry(plan: DeployPlan): RenderedFile {
  workersTarget(plan);
  const { entry } = siteFiles(plan);
  if (entry === undefined) {
    throw new Error("The headers wrapper is only for a server-rendered site (render: ssr).");
  }
  const dir = cloudflareDir(plan);
  const relative = posix.relative(dir, entry);
  const from = JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`);
  const lines = [
    `// Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew provision\` regenerates it.`,
    "// The Worker's entry (main in wrangler.jsonc): the Worker your framework's Cloudflare adapter",
    "// builds, whose responses get OpsCrew's security headers where the app set none. Static files",
    "// get the same headers from _headers.",
    `import worker from ${from};`,
    "",
    `export * from ${from};`,
    "",
    "const HEADERS = [",
    ...SITE_HEADERS.map((header) => `  ${JSON.stringify(header)},`),
    "];",
    "",
    "export default {",
    "  ...worker,",
    "  async fetch(request, env, ctx) {",
    "    const response = await worker.fetch(request, env, ctx);",
    "    // A WebSocket's switch of protocols passes as it is: it carries the socket.",
    "    if (response.status === 101) return response;",
    "    const headed = new Response(response.body, response);",
    "    for (const [name, value] of HEADERS) {",
    "      if (!headed.headers.has(name)) headed.headers.set(name, value);",
    "    }",
    "    return headed;",
    "  },",
    "};",
    "",
  ];
  return { path: `${dir}/${HEADERS_ENTRY}`, content: lines.join("\n"), kind: "runtime" };
}

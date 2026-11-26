/**
 * `opscrew verify` on Cloudflare's hosting: the headers a site's own committed `_headers` sets that
 * break the site, or its protection, when they go missing (a Content-Security-Policy, and the
 * cross-origin policies), served on the paths its rules name.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult } from "@opscrew/contracts";
import { detectSite } from "@opscrew/detect";
import { type DeployPlan, readOptionalArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { checkResult } from "../shared";

/** The headers of the site's own `_headers` that verify checks the deployed site serves. */
export const KEPT_HEADERS = [
  "Content-Security-Policy",
  "Cross-Origin-Opener-Policy",
  "Cross-Origin-Resource-Policy",
] as const;

/** A header a rule of the site's `_headers` sets: the rule's path, the header and its value. */
export interface OwnHeader {
  path: string;
  name: (typeof KEPT_HEADERS)[number];
  value: string;
}

/**
 * The {@link KEPT_HEADERS} the rules of a `_headers` text set, read as Cloudflare reads the file: a
 * line that starts with `/` or `<scheme>://` is a rule's path, and the lines after it, up to the
 * next path, its `Name: value` headers (`#` comments and `! Name` detaches set nothing).
 */
export function ownHeaders(text: string): OwnHeader[] {
  const found: OwnHeader[] = [];
  let path: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^(\/|[^\s]+:\/\/)/.test(line)) {
      path = line;
      continue;
    }
    const colon = line.indexOf(":");
    if (path === undefined || line.startsWith("#") || line.startsWith("!") || colon < 0) continue;
    const name = KEPT_HEADERS.find(
      (kept) => kept.toLowerCase() === line.slice(0, colon).trim().toLowerCase(),
    );
    if (name !== undefined) found.push({ path, name, value: line.slice(colon + 1).trim() });
  }
  return found;
}

/**
 * The path verify asks for a rule's `path`: the path itself, or a folder rule's (`/*`, `/docs/*`)
 * folder; none for a rule with a placeholder, another wildcard or a host of its own.
 */
export function pathToAsk(path: string): string | undefined {
  const asked = path.endsWith("/*") ? path.slice(0, -1) : path;
  return /^\/[^*:\s]*$/.test(asked) ? asked : undefined;
}

/** One header's state on the deployed site: served as the rule sets it, missing, or different. */
type Seen =
  | { header: OwnHeader; url: string; state: "served" | "missing" }
  | { header: OwnHeader; url: string; state: "different"; served: string }
  | { header: OwnHeader; url: string; state: "unchecked" };

/**
 * The site as detection reads it from the analysis' facts; none without an analysis, or when it
 * cannot be read (the other checks of verify need neither).
 */
async function ownSite(deps: Pick<PhaseDeps, "paths">) {
  try {
    const architecture = await readOptionalArtifact("architecture", deps.paths.files.architecture);
    return architecture && (await detectSite(deps.paths.root, architecture.facts));
  } catch {
    return undefined;
  }
}

/** A header value with its spaces made single, for comparing. */
const spaced = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Checks that the site on Cloudflare's hosting serves each {@link KEPT_HEADERS} header its own
 * committed `_headers` (the one detection finds: `public/_headers`, `static/_headers` …) sets, on
 * the path its rule names ({@link pathToAsk}), as the site sets it: Cloudflare joins the values of
 * every rule a path matches, so a served value that holds the site's counts. `read` asks for a URL
 * and gives its answer's headers, or none when it did not answer or answered with a server error.
 * Undefined, with no check, when the site has no `_headers` or it sets none of them.
 */
export async function ownHeadersCheck(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  input: { domain: string; flag: string; read: (url: string) => Promise<Headers | undefined> },
): Promise<CheckResult | undefined> {
  if (plan.target.provider !== "cloudflare-workers") return undefined;
  const site = await ownSite(deps);
  if (site?.headers === undefined) return undefined;
  const file = site.headers;
  const text = await readFile(join(deps.paths.root, ...file.split("/")), "utf8").catch(() => "");
  const headers = ownHeaders(text).filter((header) => pathToAsk(header.path) !== undefined);
  if (headers.length === 0) return undefined;

  const answers = new Map<string, Promise<Headers | undefined>>();
  const seen: Seen[] = [];
  for (const header of headers) {
    const url = `https://${input.domain}${pathToAsk(header.path)}`;
    if (!answers.has(url)) answers.set(url, input.read(url));
    const answer = await answers.get(url);
    const served = answer?.get(header.name);
    if (answer === undefined) seen.push({ header, url, state: "unchecked" });
    else if (served === null || served === undefined) seen.push({ header, url, state: "missing" });
    else if (spaced(served).includes(spaced(header.value))) {
      seen.push({ header, url, state: "served" });
    } else seen.push({ header, url, state: "different", served });
  }

  const id = "site-own-headers";
  const title = `The site serves the headers its ${file} sets`;
  const names = [...new Set(headers.map((header) => header.name))].join(", ");
  const wrong = seen.filter((one) => one.state === "missing" || one.state === "different");
  if (wrong.length > 0) {
    const lines = wrong.map((one) =>
      one.state === "missing"
        ? `${one.url} serves no ${one.header.name}, which ${file} sets for ${one.header.path}.`
        : `${one.url} serves a ${one.header.name} other than the one ${file} sets for ${one.header.path} (it serves "${"served" in one ? one.served : ""}").`,
    );
    const lost = [...new Set(wrong.map((one) => one.header.name))];
    return checkResult(id, title, "medium", "fail", lines.join(" "), {
      remediation: `The deploy job keeps the site's own _headers and only adds OpsCrew's headers to it. Check that the build copies ${file} into ${site.outputDir ?? "its output folder"} as it is, that no later rule in it removes the header (${lost.map((name) => `\`! ${name}\``).join(", ")}), and that no Transform Rule in the Cloudflare dashboard changes it; then push to ${plan.cicd.branch} to deploy again and run \`opscrew verify${input.flag}\`.`,
      target: wrong[0]?.url ?? `https://${input.domain}/`,
    });
  }
  if (seen.every((one) => one.state === "unchecked")) {
    return checkResult(
      id,
      title,
      "medium",
      "skip",
      `Skipped because the site did not answer on the paths ${file} sets ${names} for.`,
      { target: seen[0]?.url ?? `https://${input.domain}/` },
    );
  }
  const unchecked = seen.filter((one) => one.state === "unchecked").map((one) => one.url);
  return checkResult(
    id,
    title,
    "medium",
    "pass",
    `The site serves the ${names} ${file} sets${unchecked.length > 0 ? `, where it answered (not ${[...new Set(unchecked)].join(", ")})` : ""}.`,
    { target: seen[0]?.url ?? `https://${input.domain}/` },
  );
}

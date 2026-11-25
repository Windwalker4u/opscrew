/** What detection reads from the app's own Dockerfile beyond its port. */
import { posix } from "node:path";

/** A Dockerfile's instructions, one per line: continuations joined, comments dropped. */
function instructionsOf(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * The working directory of a Dockerfile's last stage, where the app runs in the image: its last
 * `WORKDIR`, a relative one resolved against the one before it in the same stage. Undefined when
 * the stage sets none, when a relative one has nothing in the stage to resolve against (it would
 * follow the base image's), or when the value holds a variable (`$APP_HOME`).
 */
export function dockerfileWorkdir(text: string): string | undefined {
  const instructions = instructionsOf(text);
  const lastFrom = instructions.findLastIndex((line) => /^FROM\s/i.test(line));
  let workdir: string | undefined;
  for (const line of instructions.slice(lastFrom + 1)) {
    const match = /^WORKDIR\s+(.+)$/i.exec(line);
    if (!match) continue;
    const value = (match[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value.includes("$")) workdir = undefined;
    else if (value.startsWith("/")) workdir = value;
    else workdir = workdir === undefined ? undefined : posix.join(workdir, value);
  }
  if (workdir === undefined) return undefined;
  const clean = posix.normalize(workdir).replace(/(.)\/+$/, "$1");
  return /\s/.test(clean) ? undefined : clean;
}

/**
 * Base images whose server binary carries the file capability `cap_net_bind_service`, by the
 * image's repository name (its last path part), with that binary.
 */
const CAPABILITY_BINARIES: Readonly<Record<string, string>> = {
  frankenphp: "/usr/local/bin/frankenphp",
  caddy: "/usr/bin/caddy",
};

/**
 * The note for a Dockerfile (at `path`) whose last stage builds on an image that ships a binary
 * with a file capability (FrankenPHP's and Caddy's images, followed through stage aliases): the
 * app's container runs with `cap_drop: ALL` and no-new-privileges, under which the kernel refuses
 * to start such a binary. Undefined for other images, or when the stage drops the capability
 * (`setcap -r`, or a `cp` of the binary by its path).
 */
export function fileCapabilityNote(text: string, path: string): string | undefined {
  const stages: { image: string; alias?: string; lines: string[] }[] = [];
  for (const line of instructionsOf(text)) {
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      const stage = { image: from[1] as string, lines: [] };
      stages.push(from[2] === undefined ? stage : { ...stage, alias: from[2].toLowerCase() });
    } else {
      stages.at(-1)?.lines.push(line);
    }
  }
  // The last stage and the stages it builds on, by alias.
  const chain = [];
  for (let stage = stages.at(-1); stage !== undefined; ) {
    chain.push(stage);
    const image = stage.image.toLowerCase();
    stage = stages.slice(0, stages.indexOf(stage)).findLast((s) => s.alias === image);
  }
  const image = chain.at(-1)?.image;
  if (image === undefined) return undefined;
  const repository = image.replace(/@.*$/, "").replace(/:[^/]*$/, "");
  const name = repository.split("/").at(-1)?.toLowerCase() ?? "";
  const binary = CAPABILITY_BINARIES[name];
  if (binary === undefined) return undefined;
  // Only a removal (`setcap -r`) or a copy of the binary itself drops it; `setcap …=+eip` adds it.
  const escaped = binary.replaceAll(".", "\\.");
  const dropped = new RegExp(`\\bsetcap\\s+(?:-\\S+\\s+)*-r\\b|\\bcp\\s+\\S*${escaped}\\b`);
  if (chain.some((stage) => stage.lines.some((line) => dropped.test(line)))) return undefined;
  const file = posix.basename(binary);
  return `${path} builds on ${repository}, whose ${file} binary (${binary}) carries the file capability cap_net_bind_service. OpsCrew runs the app's container with every capability dropped (cap_drop: ALL) and no-new-privileges, so the kernel refuses to start that binary ("operation not permitted") and the deploy fails its health check. Drop the capability in the Dockerfile, after the FROM line: \`RUN setcap -r ${binary}\` (where the image has setcap), or copy the binary over itself, which drops it: \`RUN cp ${binary} /tmp/${file} && mv /tmp/${file} ${binary}\`. The app then needs a port above 1024 (8080, say).`;
}

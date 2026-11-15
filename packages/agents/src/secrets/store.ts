/**
 * What the recovery copy keeps beside it: the local record (`.opscrew/recovery.json`, hashes and
 * times only), the folder setting (`.opscrew/secrets.json`), the repository's `opscrew/.sops.yaml`
 * and `.gitattributes`, the key file handed to the user, and the sops binary.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ensureStateDir,
  errorMessage,
  exists,
  fetchPinnedTool,
  isAgeRecipient,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  sha256Hex,
  writeFileAtomic,
} from "@opscrew/core";
import { LOCAL_TOOLS, type RenderedFile } from "@opscrew/iac-templates";
import { parse } from "yaml";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { readValidJson } from "../shared/files";
import { copyPath } from "./files";

/** The creation rule's file in the repository (committed). */
export const SOPS_CONFIG_PATH = "opscrew/.sops.yaml";

/** The `.gitattributes` lines that keep the environment's copy and its rule LF on every computer. */
function gitattributesLines(paths: Pick<ProjectPaths, "root" | "artefactsDir">): string[] {
  return [`${copyPath(paths)} text eol=lf`, `${SOPS_CONFIG_PATH} text eol=lf`];
}

/**
 * The first app's creation rule's `path_regex`: every copy no earlier rule matches, wherever sops
 * is run. A repository from before each app had its own rule has only this one.
 */
const COPY_RULE = "secrets\\.sops\\.json$";

/**
 * A further app's creation rule's `path_regex`: its copies (`apps/<key>/secrets.sops.json` and its
 * environments'), as sops matches them: relative to the folder of `.sops.yaml`, with the system's
 * separator, or as the full path. It goes before {@link COPY_RULE}: sops takes the first rule that
 * matches.
 */
function appRule(key: string): string {
  const sep = "[/\\\\]";
  return `(^|${sep})apps${sep}${key}${sep}(environments${sep}[^/\\\\]+${sep})?secrets\\.sops\\.json$`;
}

/** The `path_regex` of the rule for the copies of `app` (a further app's key, else the first app). */
function ruleOf(app: string | undefined): string {
  return app === undefined ? COPY_RULE : appRule(app);
}

const HEX64 = z.string().regex(/^[0-9a-f]{64}$/);

const RecoveryRecordSchema = z.object({
  /** SHA-256 of each file the repository's copy holds, by path. */
  hashes: z.record(z.string(), HEX64).optional(),
  /** SHA-256 of the copy this computer last wrote or restored from. */
  copySha256: HEX64.optional(),
  /** When this computer last wrote a copy (the folder's or the repository's). */
  copiedAt: z.string().optional(),
  /** When this computer last handed a copy to the repository. */
  repositoryCopyAt: z.string().optional(),
  /** SHA-256 of each file the folder copy this computer last wrote holds, by path. */
  folderHashes: z.record(z.string(), HEX64).optional(),
  /** The answer to committing the copy to a public repository (FR-1415). */
  publicConfirmed: z.boolean().optional(),
  /**
   * The age recipients (`age1…`, public keys) the copy this computer last wrote is encrypted to,
   * as `opscrew/.sops.yaml` names them: read when that file is not in this checkout yet (a first
   * provision that stopped before its pull request, 024 D16).
   */
  recipients: z.array(z.string()).optional(),
});

/** `.opscrew/recovery.json`: hashes, times and public keys, never a value. */
export type RecoveryRecord = z.infer<typeof RecoveryRecordSchema>;

function recordFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "recovery.json");
}

/** The local record; empty when there is none yet. */
export async function readRecord(paths: Pick<ProjectPaths, "stateDir">): Promise<RecoveryRecord> {
  return (await readValidJson(recordFile(paths), RecoveryRecordSchema)) ?? {};
}

export async function writeRecord(
  paths: Pick<ProjectPaths, "stateDir">,
  record: RecoveryRecord,
): Promise<void> {
  await writeFileAtomic(recordFile(paths), `${JSON.stringify(record, null, 2)}\n`);
}

const SettingsSchema = z.object({ folder: z.string().min(1).optional() });

function settingsFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "secrets.json");
}

/** The folder the copy is also written to (`.opscrew/secrets.json`), if the user named one. */
export async function readFolder(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<string | undefined> {
  return (await readValidJson(settingsFile(paths), SettingsSchema))?.folder;
}

/**
 * Sets the folder the recovery copy is also written to (`opscrew secrets folder <path>`), or clears
 * it (`undefined`). The setting is this computer's (`.opscrew/secrets.json`). A folder inside the
 * repository is refused.
 */
export async function setRecoveryFolder(
  deps: Pick<PhaseDeps, "paths">,
  folder: string | undefined,
): Promise<void> {
  const full =
    folder === undefined
      ? undefined
      : fullPathOutside(folder, [[deps.paths.root, "the repository"]], {
          what: "The folder for the recovery copy",
          refused: "OpsCrew does not keep the folder copy",
          hint: "Pick a folder outside the repository, for example on a backup drive or in a synced folder, then try again.",
        });
  await ensureStateDir(deps.paths);
  await writeFileAtomic(
    settingsFile(deps.paths),
    `${JSON.stringify(full === undefined ? {} : { folder: full })}\n`,
  );
}

/** The folder copy of the app's recovery copy: `<folder>/<app>.sops.json`. */
export function folderCopyPath(folder: string, app: string): string {
  return join(folder, `${app}.sops.json`);
}

/** The environment's copy in this checkout ({@link copyPath}), if there is one. */
export function readRepositoryCopy(
  paths: Pick<ProjectPaths, "root" | "artefactsDir">,
): Promise<string | undefined> {
  return readTextIfExists(join(paths.root, copyPath(paths)));
}

/**
 * Stops with `SECRETS_COPY_CHANGED_ELSEWHERE` when the environment's copy in the repository is not
 * the one this computer last wrote or restored from: another computer updated it, so writing this
 * computer's files over it could lose that computer's secrets (FR-1417).
 */
export function requireOwnCopy(
  paths: Pick<ProjectPaths, "root" | "artefactsDir">,
  repositoryCopy: string | undefined,
  record: RecoveryRecord,
): void {
  if (repositoryCopy === undefined || sha256Hex(repositoryCopy) === record.copySha256) return;
  throw new OpsCrewError(
    "SECRETS_COPY_CHANGED_ELSEWHERE",
    `${copyPath(paths)} in the repository is not the copy this computer last wrote: another computer updated it, so OpsCrew did not update it from this computer's files.`,
    {
      hint: "Run `opscrew secrets restore` first: it shows which files and generated values differ, by name only, and lets you choose which side to keep.",
    },
  );
}

const SopsRuleSchema = z.looseObject({ path_regex: z.string(), age: z.string() });
type SopsRule = z.infer<typeof SopsRuleSchema>;
const SopsConfigSchema = z.looseObject({ creation_rules: z.array(SopsRuleSchema) });

/**
 * The creation rules of `opscrew/.sops.yaml`'s text. A file that does not parse stops plainly:
 * it holds every app's rule, so OpsCrew never writes it again from one app's rule alone.
 */
function sopsRules(text: string): SopsRule[] {
  let rules: SopsRule[] | undefined;
  try {
    rules = SopsConfigSchema.safeParse(parse(text)).data?.creation_rules;
  } catch {
    rules = undefined;
  }
  if (rules !== undefined) return rules;
  throw new OpsCrewError(
    "ARTIFACT_INVALID",
    `${SOPS_CONFIG_PATH} does not parse as the creation rules OpsCrew writes, and it names the keys of every app's recovery copy, so OpsCrew changed neither it nor a copy.`,
    {
      hint: `Put back the one OpsCrew wrote (\`git restore ${SOPS_CONFIG_PATH}\`) or fix its YAML, then run the command again. Or delete it: each app's next update of its copy writes the app's rule again, from the keys that copy is sealed to.`,
    },
  );
}

/** The text of `opscrew/.sops.yaml`, checked to parse ({@link sopsRules}); `undefined` without it. */
export async function readSopsConfig(paths: Pick<ProjectPaths, "root">) {
  const text = await readTextIfExists(join(paths.root, SOPS_CONFIG_PATH));
  if (text !== undefined) sopsRules(text);
  return text;
}

export const CopyMetadataSchema = z.looseObject({
  sops: z.looseObject({
    lastmodified: z.string().optional(),
    age: z.array(z.unknown()).optional(),
  }),
});

const SealedToSchema = z.object({
  sops: z.looseObject({ age: z.array(z.looseObject({ recipient: z.string() })) }),
});

/** The recipients (`age1…`) a sops copy is sealed to, from its metadata (`sops.age[].recipient`). */
function sealedTo(copy: string): string[] | undefined {
  try {
    return SealedToSchema.safeParse(JSON.parse(copy)).data?.sops.age.map((a) => a.recipient);
  } catch {
    return undefined;
  }
}

/** The recipients of the app's copies, and whether its own rule in `opscrew/.sops.yaml` names them. */
export interface CopyRule {
  recipients: string[];
  /** False for an app with no rule of its own yet: its rule is still to be written. */
  own: boolean;
}

/** `recipients` when they are one or two age keys; otherwise a plain stop naming `where`. */
function checkedRecipients(
  recipients: string[] | undefined,
  where: string,
  app: string | undefined,
): string[] {
  if (
    recipients !== undefined &&
    recipients.length > 0 &&
    recipients.length <= 2 &&
    recipients.every(isAgeRecipient)
  ) {
    return recipients;
  }
  const rotate = `opscrew rotate recovery-key${app === undefined ? "" : ` --app ${app}`}`;
  throw new OpsCrewError(
    "ARTIFACT_INVALID",
    `${where} does not name one or two age keys (age1…), so OpsCrew cannot tell whom to encrypt the recovery copy to.`,
    {
      hint: `Put back the file OpsCrew wrote (git restore), or make a new key with \`${rotate}\`.`,
    },
  );
}

/**
 * Whom the app's copies are encrypted to ({@link CopyRule}): its own rule in `opscrew/.sops.yaml`;
 * else, for an app whose copy is in this checkout (written before each app had its own rule), the
 * keys that copy is sealed to, read from its sops metadata; else, for a further app with no copy
 * yet, the first app's rule. `undefined` when none of them exists. A `.sops.yaml` that does not
 * parse, a rule or a copy without one or two age keys, stops plainly.
 */
export async function readCopyRule(
  paths: Pick<ProjectPaths, "root" | "app" | "artefactsDir">,
): Promise<CopyRule | undefined> {
  const text = await readSopsConfig(paths);
  const rules = text === undefined ? [] : sopsRules(text);
  const ages = (rule: SopsRule) => rule.age.split(",").map((r) => r.trim());
  const own = rules.find((rule) => rule.path_regex === ruleOf(paths.app));
  if (own !== undefined) {
    const where = `${SOPS_CONFIG_PATH}'s rule for this app's secrets.sops.json`;
    return { recipients: checkedRecipients(ages(own), where, paths.app), own: true };
  }
  const copy = await readRepositoryCopy(paths);
  if (copy !== undefined) {
    const path = copyPath(paths);
    return { recipients: checkedRecipients(sealedTo(copy), path, paths.app), own: false };
  }
  const general =
    paths.app === undefined ? undefined : rules.find((rule) => rule.path_regex === COPY_RULE);
  if (general === undefined) return undefined;
  const where = `${SOPS_CONFIG_PATH}'s rule for the first app's secrets.sops.json`;
  return { recipients: checkedRecipients(ages(general), where, paths.app), own: false };
}

/** The recipients (`age1…`) of the app's copies ({@link readCopyRule}); `undefined` without them. */
export async function readRecipients(
  paths: Pick<ProjectPaths, "root" | "app" | "artefactsDir">,
): Promise<string[] | undefined> {
  return (await readCopyRule(paths))?.recipients;
}

/**
 * The recipients the recovery copy is encrypted to, the main key's first: {@link readRecipients},
 * else those `.opscrew/recovery.json` kept when this computer wrote the copy (D16); `undefined`
 * while there is no copy.
 */
export async function knownRecipients(
  paths: Pick<ProjectPaths, "root" | "stateDir" | "app" | "artefactsDir">,
): Promise<string[] | undefined> {
  return (await readRecipients(paths)) ?? (await readRecord(paths)).recipients;
}

/**
 * `opscrew/.sops.yaml` (its text now: `current`) with the rule of the copies of `app` (a further
 * app's key; absent: the first app) set to `recipients`, the other apps' rules as they are. A
 * further app's new rule goes before the first app's, which matches every copy. A `current` that
 * does not parse stops plainly ({@link sopsRules}).
 */
export function sopsConfigFile(
  recipients: readonly string[],
  app?: string,
  current?: string,
): RenderedFile {
  const rules = current === undefined ? [] : sopsRules(current);
  const rule = { path_regex: ruleOf(app), age: recipients.join(",") };
  const index = rules.findIndex((r) => r.path_regex === rule.path_regex);
  const general = rules.findIndex((r) => r.path_regex === COPY_RULE);
  if (index >= 0) rules[index] = rule;
  else if (app !== undefined && general >= 0) rules.splice(general, 0, rule);
  else rules.push(rule);
  return {
    path: SOPS_CONFIG_PATH,
    content: [
      "# Written by OpsCrew: the age keys that can open each app's secrets.sops.json, the encrypted",
      "# recovery copy of what OpsCrew keeps on your computer for it. sops takes the first rule that",
      "# matches, so a further app's rule (apps/<key>/) comes before the first app's.",
      "creation_rules:",
      ...rules.flatMap((r) => [
        `  - path_regex: '${r.path_regex.replaceAll("'", "''")}'`,
        `    age: ${r.age}`,
      ]),
      "",
    ].join("\n"),
    kind: "doc",
    mode: 0o644,
  };
}

/**
 * `.gitattributes` with the environment's copy's lines added, or `undefined` when it has them
 * already.
 */
export async function gitattributesFile(
  paths: Pick<ProjectPaths, "root" | "artefactsDir">,
): Promise<RenderedFile | undefined> {
  const current = (await readTextIfExists(join(paths.root, ".gitattributes"))) ?? "";
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = gitattributesLines(paths).filter((line) => !lines.has(line));
  if (missing.length === 0) return undefined;
  const head = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  return {
    path: ".gitattributes",
    content: `${head}${missing.join("\n")}\n`,
    kind: "doc",
    mode: 0o644,
  };
}

/** The environment's copy ({@link copyPath}) as a file for the pull request. */
export function copyFile(
  paths: Pick<ProjectPaths, "root" | "artefactsDir">,
  copy: string,
): RenderedFile {
  return { path: copyPath(paths), content: copy, kind: "doc", mode: 0o644 };
}

/** True when `file` is `dir` or lies below it. */
function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * `file` as a full path, refused when it is not absolute or lies inside one of `dirs` (each with
 * its name for the message).
 */
function fullPathOutside(
  file: string,
  dirs: readonly (readonly [string, string])[],
  wording: { what: string; refused: string; hint: string },
): string {
  if (!isAbsolute(file)) {
    throw new OpsCrewError("INVALID_INPUT", `${wording.what} needs a full path, not ${file}.`, {
      hint: wording.hint,
    });
  }
  const full = resolve(file);
  for (const [dir, name] of dirs) {
    if (inside(dir, full)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `${wording.refused} inside ${name} (${dir}): it could be committed or copied with it.`,
        { hint: wording.hint },
      );
    }
  }
  return full;
}

/**
 * The full path for a new key file, refused before anything is encrypted or written when it is not
 * absolute, lies inside the repository or OpsCrew's own folder, or already exists.
 */
export async function keyFilePath(
  paths: Pick<ProjectPaths, "root" | "homeDir">,
  file: string,
): Promise<string> {
  const hint =
    "Pick a file outside the repository and outside OpsCrew's folder, for example in your home folder, then try again.";
  const full = fullPathOutside(
    file,
    [
      [paths.root, "the repository"],
      [paths.homeDir, "OpsCrew's folder"],
    ],
    { what: "The key file", refused: "OpsCrew does not write the age key", hint },
  );
  if (await exists(full)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `A file already exists at ${full}, and OpsCrew never writes a key over a file. Nothing was written.`,
      { hint },
    );
  }
  return full;
}

/** The file a new age key was written to, once (mode 0600). The key itself is never returned. */
export interface KeyHandover {
  path: string;
}

/**
 * Writes a new age key once to `file` (from {@link keyFilePath}): mode 0600, never over an existing
 * file, in age's key file format (sops reads it as `SOPS_AGE_KEY_FILE`).
 */
export async function writeKeyFile(
  deps: Pick<PhaseDeps, "clock">,
  file: string,
  key: { identity: string; recipient: string },
): Promise<KeyHandover> {
  const content = [
    `# created: ${deps.clock.now().toISOString()}`,
    `# public key: ${key.recipient}`,
    key.identity,
    "",
  ].join("\n");
  try {
    await writeFile(file, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
    throw new OpsCrewError(
      "INVALID_INPUT",
      exists
        ? `A file already exists at ${file}, and OpsCrew never writes a key over a file.`
        : `OpsCrew could not write the new age key to ${file} (${errorMessage(error)}).`,
      { hint: "Pick another file for the key (its folder must exist), then try again." },
    );
  }
  return { path: file };
}

/** What to tell the user about a key file handed over. */
export function keyHandoverNote(handover: KeyHandover): string {
  return `OpsCrew wrote your new age key to ${handover.path}. Only it (or your backup key) opens the recovery copy of this app's secrets, and OpsCrew keeps no copy of it: move it into your password manager, then delete the file.`;
}

/**
 * The pinned sops (`LOCAL_TOOLS.sops`), fetched and checked into OpsCrew's tools folder, or
 * `OPSCREW_SOPS_BIN` as it is.
 */
export async function sopsBinary(deps: Pick<PhaseDeps, "fetch" | "env" | "paths">) {
  const tool = await fetchPinnedTool(LOCAL_TOOLS.sops, {
    fetch: deps.fetch,
    fs: { readFile, writeFile, mkdir, rename, chmod },
    env: deps.env,
    homeDir: deps.paths.homeDir,
    platform: process.platform,
    arch: process.arch,
  });
  return tool.path;
}

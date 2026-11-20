import { join } from "node:path";
import { isRecord, readTextIfExists } from "@opscrew/core";
import { normalizeAppDir } from "./app-dir";
import { parseJson } from "./manifests";

/**
 * What a PHP app needs from the PHP it runs on, as Composer states it (feature 027, plan 5): what
 * a hosting account's PHP versions are checked against when OpsCrew sets the account up.
 */
export interface PhpNeeds {
  /** `composer.json`'s PHP constraint (`require.php`), as written; absent when it names none. */
  php?: string;
  /**
   * The extensions `composer.json` and every package `composer.lock` installs require (`ext-*`,
   * lower-case, without the prefix), sorted and deduplicated, without {@link PHP_8_EXTENSIONS}.
   * Development packages are left out: a release is installed without them.
   */
  extensions: string[];
  /**
   * The extensions only the development packages need: `composer.json`'s `require-dev` and every
   * package of `composer.lock`'s `packages-dev`, in the same form, without those in
   * {@link extensions}. A build that installs the development packages (Railpack's) needs them too.
   */
  devExtensions: string[];
  /**
   * Who requires each extension of {@link extensions} and {@link devExtensions}: the packages, by
   * name, and `composer.json` for the app's own requirement, in the order read (an extension the
   * release needs names only the release's).
   */
  requiredBy: Record<string, string[]>;
  /**
   * The WebSocket servers `composer.json` requires (`laravel/reverb`, `cboden/ratchet`, …), sorted:
   * each needs a PHP process that keeps running.
   */
  websockets: string[];
}

/**
 * The extensions every PHP 8 build has: compiled in for good (`core`, `date`, `hash`, `json`,
 * `pcre`, `random`, `reflection`, `spl`, `standard`) or on in every build (`ctype`, `filter`). An
 * app's need for them is met wherever PHP 8 runs.
 */
export const PHP_8_EXTENSIONS: ReadonlySet<string> = new Set([
  "core",
  "ctype",
  "date",
  "filter",
  "hash",
  "json",
  "pcre",
  "random",
  "reflection",
  "spl",
  "standard",
]);

/** Packages that serve WebSockets from PHP, in a process of their own. */
const WEBSOCKET_SERVERS: ReadonlySet<string> = new Set([
  "beyondcode/laravel-websockets",
  "cboden/ratchet",
  "laravel/reverb",
  "workerman/workerman",
]);

/** A manifest's `require` (or `require-dev`) mapping, or an empty one when it has none. */
function requireOf(manifest: unknown, key = "require"): Record<string, unknown> {
  const mapping = isRecord(manifest) ? manifest[key] : undefined;
  return isRecord(mapping) ? mapping : {};
}

/** Who requires something (a package's name, or `composer.json`) and what it requires. */
type Requirements = [by: string, requirements: Record<string, unknown>];

/** The packages a lock file lists under `key` (`packages` or `packages-dev`), with their needs. */
function lockedPackages(lock: unknown, key: string): Requirements[] {
  const packages = isRecord(lock) ? lock[key] : undefined;
  return (Array.isArray(packages) ? packages : []).map((locked) => [
    isRecord(locked) && typeof locked.name === "string" ? locked.name : "a locked package",
    requireOf(locked),
  ]);
}

/**
 * The extensions `sources` require (`ext-*`, lower-case, without the prefix), without
 * {@link PHP_8_EXTENSIONS} and those in `except`, each with who requires it, in the order read.
 */
function extensionsOf(
  sources: Requirements[],
  except: readonly string[] = [],
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [by, requirements] of sources) {
    for (const name of Object.keys(requirements)) {
      const extension = /^ext-(.+)$/i.exec(name)?.[1]?.toLowerCase();
      if (extension === undefined || PHP_8_EXTENSIONS.has(extension)) continue;
      if (except.includes(extension)) continue;
      const requiring = found.get(extension) ?? [];
      if (!requiring.includes(by)) found.set(extension, [...requiring, by]);
    }
  }
  return found;
}

/**
 * The PHP needs ({@link PhpNeeds}) of the app in `appDir` (repo-relative, default the repository
 * root): its `composer.json` and the `composer.lock` beside it, from the app's folder, else from
 * the repository root. Without a readable `composer.json` the app needs nothing OpsCrew can tell.
 */
export async function detectPhpNeeds(root: string, appDir = "."): Promise<PhpNeeds> {
  const dir = normalizeAppDir(appDir);
  const folders = dir === "." ? ["."] : [dir, "."];
  let folder: string | undefined;
  let manifest: string | undefined;
  for (const candidate of folders) {
    manifest = await readTextIfExists(join(root, candidate, "composer.json"));
    if (manifest !== undefined) {
      folder = candidate;
      break;
    }
  }
  if (folder === undefined) {
    return { extensions: [], devExtensions: [], requiredBy: {}, websockets: [] };
  }
  const composer = parseJson(manifest);
  const require = requireOf(composer);
  const lock = parseJson(await readTextIfExists(join(root, folder, "composer.lock")));
  const release = extensionsOf([["composer.json", require], ...lockedPackages(lock, "packages")]);
  const development = extensionsOf(
    [
      ["composer.json", requireOf(composer, "require-dev")],
      ...lockedPackages(lock, "packages-dev"),
    ],
    [...release.keys()],
  );
  const php = require.php;
  return {
    ...(typeof php === "string" && php.trim() !== "" ? { php: php.trim() } : {}),
    extensions: [...release.keys()].sort(),
    devExtensions: [...development.keys()].sort(),
    requiredBy: Object.fromEntries([...release, ...development]),
    websockets: Object.keys(require)
      .map((name) => name.toLowerCase())
      .filter((name) => WEBSOCKET_SERVERS.has(name))
      .sort(),
  };
}

import type { ManifestEntry } from "../carrier";

/**
 * What the move copies and removes to bring `fresh` (the new side's manifest) to `old` (the old
 * side's), as the tests compute it: every old path the new side lacks or holds with other facts,
 * and every new path the old side lacks, but those under another such path.
 */
export function manifestDelta(
  old: readonly ManifestEntry[],
  fresh: readonly ManifestEntry[],
): { copy: string[]; remove: string[] } {
  const there = new Map(fresh.map((entry) => [entry.path, JSON.stringify(entry)]));
  const here = new Set(old.map((entry) => entry.path));
  const copy = old
    .filter((entry) => there.get(entry.path) !== JSON.stringify(entry))
    .map((entry) => entry.path);
  const gone = fresh.map((entry) => entry.path).filter((path) => !here.has(path));
  const remove = gone.filter((path) => !gone.some((above) => path.startsWith(`${above}/`)));
  return { copy, remove };
}

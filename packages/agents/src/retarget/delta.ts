import type { ManifestEntry } from "@opscrew/connector-docker";

/** The paths the maintenance window copies to the new side's mount, and those it removes there. */
export interface MountDelta {
  /** The old side's paths the new side lacks or holds otherwise, in the old manifest's order. */
  copy: string[];
  /** The new side's paths the old side lacks; a removed folder's content is not listed again. */
  remove: string[];
}

/** True when `a` and `b` are the same path's facts, as the carrier's digest hashes them. */
function same(a: ManifestEntry, b: ManifestEntry): boolean {
  return (
    a.type === b.type &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.size === b.size &&
    a.target === b.target &&
    a.sha256 === b.sha256
  );
}

/**
 * What makes the new side's mount (its manifest `fresh`, copied while the old side served) the
 * old side's (`old`, read in the window): every old path absent there or differing in type, mode,
 * owner, group, size, link target or content, and every path only the new side has (a folder's
 * own entry, without its content, which goes with it).
 */
export function mountDelta(
  old: readonly ManifestEntry[],
  fresh: readonly ManifestEntry[],
): MountDelta {
  const there = new Map(fresh.map((entry) => [entry.path, entry]));
  const here = new Set(old.map((entry) => entry.path));
  const copy = old.flatMap((entry) => {
    const other = there.get(entry.path);
    return other !== undefined && same(entry, other) ? [] : [entry.path];
  });
  const remove: string[] = [];
  for (const { path } of fresh) {
    if (here.has(path) || remove.some((folder) => path.startsWith(`${folder}/`))) continue;
    remove.push(path);
  }
  return { copy, remove };
}

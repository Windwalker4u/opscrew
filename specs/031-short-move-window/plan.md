# Implementation Plan: A move's maintenance window of about a minute

**Branch**: `031-short-move-window` | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

## Summary

Copy a move's data while the old app serves, start and check the app on the new side on that copy,
and keep only the delta, the release command and a restart in place for the maintenance window.
Decisions: [research.md](research.md) R2.

## Technical Context

TypeScript (strict ESM), Vitest. Changed: `@opscrew/connector-docker` (the carrier), `@opscrew/agents`
(`retarget/`), the guide. No new dependency, no contract change.

## Constitution Check

- **I (plans and approvals):** unchanged. The window keeps its single `remote-exec` approval
  (`allowDowntime` in scripts). The pre-copy changes nothing on the old side: it reads it, and
  writes only the new side's mounts and starts only the new side's app.
- **IV (no secrets):** manifests hold paths and digests of the app's own data folders, never
  printed. No file content is printed.
- **Injected side effects:** the carrier runs through the Docker client as today; tests use the
  move fakes.

## Design

### 1. The carrier's delta (`packages/connectors/docker/src/carrier.ts`, T3101)

Three operations join `VolumeCarrier`:

```ts
/** One path of a source, as the digest hashes it. */
export interface ManifestEntry {
  /** Relative to the source's root, `./`-prefixed as `find` prints it (`./a/b.txt`; `.` is the root). */
  path: string;
  /** `stat -c %F`: `regular file`, `regular empty file`, `directory`, `symbolic link`, … */
  type: string;
  mode: string; // octal, `stat -c %a`
  uid: number;
  gid: number;
  /** Bytes; 0 for a folder (its size depends on the file system). */
  size: number;
  /** A symbolic link's target. */
  target?: string;
  /** A regular file's SHA-256 (hex). */
  sha256?: string;
}

interface VolumeCarrier {
  // … readVolume, writeVolume, volumeDigest, sourceSize as today
  /** Every path of the source with its facts, sorted by path, from a read-only carrier. */
  volumeManifest(source: CarrierSource): Promise<ManifestEntry[]>;
  /**
   * The source's `paths` (manifest paths) as a tar stream, files under `data/` as
   * {@link readVolume} streams them, from a read-only carrier. Folders are archived without their
   * content (`--no-recursion`): each changed path is listed itself.
   */
  readPaths(source: CarrierSource, paths: readonly string[]): Promise<Readable>;
  /**
   * Unpacks `archive` (as {@link readPaths} streams it) over the source's content without emptying
   * it, owners and modes kept, then removes `remove` (manifest paths, deepest first) and their
   * content. On failure `archive` is destroyed, and the call settles once it has closed.
   */
  updateVolume(source: CarrierSource, archive: Readable, remove: readonly string[]): Promise<void>;
}
```

- The path lists reach a carrier as a file put into the stopped carrier (Docker's archive upload),
  read by `tar -T` and by a removal loop, never as command-line arguments, so names with spaces or
  dashes are safe and no list is limited by the command's length.
- The same checks as today: the source must exist, a folder must be under `allowedRoots` and no
  link, and every carrier is removed, also on failure.
- `volumeDigest` stays the arbiter: the manifest only decides what to send.

### 2. The delta (`packages/agents/src/retarget/`, T3102)

`mountDelta(old: ManifestEntry[], fresh: ManifestEntry[]): { copy: string[]; remove: string[] }`:
- **copy:** every old entry absent on the new side, or differing in type, mode, uid, gid, size,
  target or sha256. A folder's own entry is copied when its mode or owner differs.
- **remove:** every new-side path the old side lacks, minus those under a removed folder.

### 3. The flow (T3102)

**Before the window**, when the move copies data and the window has not run (a step between
`deployed` and the window's approval):
1. The new side's app, workers and services stop. It serves nobody yet.
2. **The pre-copy:** every mount is copied whole (`writeVolume(readVolume)`) from the old side,
   which keeps serving. No digest check here.
3. The new side's services start.
4. **On a server side:** the marker says `copied`, and the deploy workflow runs with the image's
   digest (030's FR-3027), so the release command runs on the pre-copied data and the app starts.
   OpsCrew then checks it over SSH (`waitHealthy`), and stops the edge when it isn't shared.
   - On failure: the new side's app stops, the marker goes back to `waiting`, and the move stops
     before any downtime with the cause. The rerun starts the pre-copy again.
5. It records the pre-copy as done for this move (the session's step or a machine-local file, as
   `retarget-deployed.json`), so a rerun after a stop at the window's approval doesn't copy again.

**The window** (one approval, as today):
1. The old app stops; Postgres is dumped while it runs; the old services stop; the new app and
   services stop.
2. Each mount: the two manifests → the delta → `updateVolume(readPaths)`, unless the delta is
   empty, then the digest check as today.
3. The new services start, and Postgres is restored as today.
4. The release command runs on the final data: the `release` service in a one-off run on the new
   side (`docker compose run --rm --no-deps -T release`), as before 030's T3021. Portainer keeps its
   own `release`.
5. The app starts again in place (`docker compose up -d app` with its workers and cron), OpsCrew
   checks it, and the marker is removed. No workflow runs.
6. Rollback: as today, with the new side's app stopped and the marker at `copied` (it was started
   once already, on the pre-copied data).

A move whose new side is a Portainer: steps 1–3 and 5 of the pre-copy, the window's delta; its app
starts as today.

### 4. Texts and estimates (T3102)

- **The summary and the window's approval** give the pre-copy apart from the window: "copies 481
  MB while your app serves (about N minutes), then a maintenance window of about M minutes".
  - N comes from today's throughput figure.
  - M is a fixed minute, plus Postgres's dump and restore at today's figure, plus a share of the
    data for the changes (5% of the files' size, at least 0).
- **The pre-copy's progress** says plainly that the app still serves.

### 5. The guide (T3103)

`docs/guide/retarget.md`, "The maintenance window": the pre-copy, the delta, the window's length,
Postgres's exception, and what a rerun does.

## Order

- **Wave 1** (parallel): T3101 the carrier; T3102 the flow, against the interface in 1. with a
  fake carrier in `agents/src/testing/move.ts`.
- **Then:** T3103 the guide. T3104 is the lead's: the PHP app's move as the live run, with the
  coverage rows for both 030's move and this feature.

## Complexity Tracking

None.

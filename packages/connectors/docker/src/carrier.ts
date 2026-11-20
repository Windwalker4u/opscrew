import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { buffer } from "node:stream/consumers";
import { errorMessage, OpsCrewError } from "@opscrew/core";
import { DockerApiError, type DockerClient, type MountSpec } from "./client";
import { ContainerLeftError, createPulled, type OneOffResult, runOneOff } from "./one-off";
import { parseTar, type TarEntry, tarStream } from "./tar";

/** Where a carrier mounts its source; an archive holds the source's files under `data/`. */
const MOUNT = "/data";

/** Where the carrier that stages paths for {@link VolumeCarrier.readPaths} mounts its source. */
const SOURCE_MOUNT = "/source";

/** The file a carrier reads a list of paths from, one per line, put in before it starts. */
const LIST = "/opscrew-paths";

/** The folder the manifest's carrier writes its listings into, read back once it has exited. */
const MANIFEST = "/manifest";

/** The manifest carrier's exit code when a name holds a line break. */
const LINE_BREAK_EXIT = 3;

/** Where the carrier that checks a folder is no symbolic link mounts the folder's parent. */
const PARENT_MOUNT = "/parent";

/** The label on every carrier container, with its source's volume name or folder path. */
const CARRIER_LABEL = "opscrew.carrier";

/**
 * Hashes what is at {@link MOUNT}: each path's type, mode, owner, group and link target, the size
 * of everything but folders (a folder's size depends on the file system, not its content), and
 * each file's SHA-256, sorted and reduced to one SHA-256.
 */
const DIGEST_SCRIPT = `set -e
cd ${MOUNT}
find . -type d -exec stat -c '%F %a %u %g %N' {} + > /tmp/listing
find . ! -type d -exec stat -c '%F %a %u %g %s %N' {} + >> /tmp/listing
find . -type f -exec sha256sum {} + >> /tmp/listing
sort /tmp/listing | sha256sum`;

/**
 * Lists what is at {@link MOUNT} with the facts {@link DIGEST_SCRIPT} hashes, into {@link MANIFEST}:
 * `stat` (type, mode, owner, group, size and path), `sum` (each file's SHA-256 and path), `link`
 * (each link's path, then its target, a line each). Paths are the lines' last field, so it exits
 * {@link LINE_BREAK_EXIT} first when a name holds a line break.
 */
export const MANIFEST_SCRIPT = `set -e
cd ${MOUNT}
if [ -n "$(find . -name "$(printf '*\\n*')" | head -n 1)" ]; then exit ${LINE_BREAK_EXIT}; fi
mkdir ${MANIFEST}
find . -exec stat -c '%F %a %u %g %s %n' {} + > ${MANIFEST}/stat
find . -type f -exec sha256sum {} + > ${MANIFEST}/sum
find . -type l -exec sh -c 'for f do printf "%s\\n" "$f"; readlink "$f" || exit 1; done' sh {} + > ${MANIFEST}/link`;

/**
 * Copies the paths {@link LIST} names (folders without their content) from {@link SOURCE_MOUNT}
 * into {@link MOUNT} in the carrier's own file system, owners and modes kept. Busybox's tar doesn't
 * give a link its owner back, so each link gets its source's.
 */
export const STAGE_SCRIPT = `set -e
set -o pipefail
mkdir ${MOUNT}
cd ${SOURCE_MOUNT}
tar -c -f - --no-recursion -T ${LIST} | tar -x -f - -C ${MOUNT} --numeric-owner
cd ${MOUNT}
find . -type l -exec sh -c 'for l do chown -h "$(stat -c %u:%g "${SOURCE_MOUNT}/$l")" "$l" || exit 1; done' sh {} +`;

/** Removes the paths {@link LIST} names, in its order, from {@link MOUNT}. */
export const REMOVE_SCRIPT = `set -e
cd ${MOUNT}
while IFS= read -r path; do rm -rf -- "$path"; done < ${LIST}`;

/** One path of a source, as the digest hashes it. */
export interface ManifestEntry {
  /** Relative to the source's root, `./`-prefixed as `find` prints it (`./a/b.txt`; `.` is the root). */
  path: string;
  /** `stat -c %F`: `regular file`, `regular empty file`, `directory`, `symbolic link`, … */
  type: string;
  /** Octal, `stat -c %a`. */
  mode: string;
  uid: number;
  gid: number;
  /** Bytes; 0 for a folder (its size depends on the file system). */
  size: number;
  /** A symbolic link's target. */
  target?: string;
  /** A regular file's SHA-256 (hex). */
  sha256?: string;
}

/**
 * What a carrier copies: a named Docker volume, or a folder on the server bound into a service
 * (`/srv/data/<app>/<service>` on a server OpsCrew deploys to over SSH).
 */
export type CarrierSource = { kind: "volume"; name: string } | { kind: "bind"; path: string };

/** A source's volume name or folder path: the left side of its bind, and its carriers' label. */
function located(source: CarrierSource): string {
  return source.kind === "volume" ? source.name : source.path;
}

/** A source in a message: `volume <name>` or `folder <path>`. */
function described(source: CarrierSource): string {
  return `${source.kind === "volume" ? "volume" : "folder"} ${located(source)}`;
}

/**
 * Refuses a folder a carrier must not bind: one whose path isn't absolute and plain (no `.`, `..`
 * or empty parts, no trailing slash, no `:`, which would end the bind's path), or isn't under one
 * of `roots`.
 */
function checkFolder(folder: string, roots: readonly string[]): void {
  const parts = folder.split("/");
  if (
    parts[0] !== "" ||
    folder.includes(":") ||
    parts.slice(1).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new OpsCrewError("INVALID_INPUT", `The folder ${folder} is not a plain absolute path.`, {
      hint: 'Give an absolute path without ".", "..", empty parts, a trailing slash or ":", then try again.',
    });
  }
  if (!roots.some((root) => folder.startsWith(root.endsWith("/") ? root : `${root}/`))) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The folder ${folder} is outside the folders OpsCrew may copy here${roots.length > 0 ? ` (${roots.join(", ")})` : ""}.`,
      {
        hint: "OpsCrew copies only the app's data folders; check the service's folder, then try again.",
      },
    );
  }
}

/** The refusal of a source a manifest can't list: a name in it holds a line break or isn't UTF-8. */
function unlistable(source: CarrierSource, why: string): OpsCrewError {
  return new OpsCrewError(
    "INVALID_INPUT",
    `The ${described(source)} holds a name ${why}, which OpsCrew can't compare path by path.`,
    { hint: "Copy it whole instead, or rename that file or folder, then try again." },
  );
}

/**
 * Refuses `paths` that aren't plain manifest paths inside the source (`./` and parts that are
 * neither empty, `.` nor `..`; the root `.` only when `root` allows it), without naming them: they
 * are the app's data.
 */
function checkPaths(paths: readonly string[], source: CarrierSource, root: boolean): void {
  for (const item of paths) {
    if (item.includes("\n")) throw unlistable(source, "with a line break");
    const parts = item.split("/");
    const plain =
      (item === "." && root) ||
      (parts[0] === "." &&
        parts.length > 1 &&
        parts.slice(1).every((part) => part !== "" && part !== "." && part !== ".."));
    if (!plain || item.includes("\0")) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `A path given for ${described(source)} is not a plain path inside it.`,
        { hint: "Give the paths its manifest lists, then try again." },
      );
    }
  }
}

/** How deep a manifest path is: 0 for the root `.`. */
const depth = (item: string) => item.split("/").length - 1;

/** `paths` as the archive that puts {@link LIST} into a carrier, a line each. */
function listArchive(paths: readonly string[]): Readable {
  const data = Buffer.from(paths.map((item) => `${item}\n`).join(""), "utf8");
  return tarStream([{ name: LIST.slice(1), type: "file", mode: 0o600, uid: 0, gid: 0, data }]);
}

/**
 * The manifest the carrier wrote ({@link MANIFEST_SCRIPT}), read from `files` (the archive of
 * {@link MANIFEST}), sorted by path.
 */
function parseManifest(files: readonly TarEntry[], source: CarrierSource): ManifestEntry[] {
  const garbled = () =>
    new OpsCrewError(
      "PROVIDER_ERROR",
      `The carrier container did not print a readable list of ${described(source)}.`,
      { hint: "Check that the carrier image is the one OpsCrew pins, then try again." },
    );
  const lines = (name: string): string[] => {
    const data = files.find((file) => file.name === `${MANIFEST.slice(1)}/${name}`)?.data;
    if (data === undefined) throw garbled();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw unlistable(source, "that isn't UTF-8");
    }
    const all = text.split("\n");
    if (all.pop() !== "") throw garbled();
    return all;
  };
  const entries = new Map<string, ManifestEntry>();
  for (const line of lines("stat")) {
    const fields = /^([a-z ]+) ([0-7]+) (\d+) (\d+) (\d+) (\.|\.\/.+)$/.exec(line);
    if (fields === null) throw garbled();
    const [, type = "", mode = "", uid, gid, size, at = ""] = fields;
    entries.set(at, {
      path: at,
      type,
      mode,
      uid: Number(uid),
      gid: Number(gid),
      size: type === "directory" ? 0 : Number(size),
    });
  }
  for (const line of lines("sum")) {
    const fields = /^([0-9a-f]{64}) {2}(\.\/.+)$/.exec(line);
    const entry = entries.get(fields?.[2] ?? "");
    if (fields === null || entry === undefined) throw garbled();
    entry.sha256 = fields[1];
  }
  const links = lines("link");
  if (links.length % 2 !== 0) throw garbled();
  for (let at = 0; at < links.length; at += 2) {
    const entry = entries.get(links[at] ?? "");
    if (entry === undefined) throw garbled();
    entry.target = links[at + 1];
  }
  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Removes the carriers left behind for `sources` on `docker`'s host, such as after a lost
 * connection. Call it before removing those volumes or folders: Docker refuses to remove a volume
 * in use. Other sources' carriers, which may belong to another app's move, stay.
 */
export async function sweepCarriers(docker: DockerClient, sources: readonly CarrierSource[]) {
  for (const source of sources) {
    for (const carrier of await docker.listContainers([`${CARRIER_LABEL}=${located(source)}`])) {
      await docker.removeContainer(carrier.id);
    }
  }
}

/** Reads, writes, hashes and measures volumes and folders through short-lived carrier containers. */
export interface VolumeCarrier {
  /**
   * The source as a tar stream, its files under `data/`, from a carrier that is created with the
   * source mounted read-only and never started. The carrier is removed before the stream ends,
   * or before it closes when it is destroyed early.
   */
  readVolume(source: CarrierSource): Promise<Readable>;
  /**
   * Replaces the source's content with `archive` (as {@link readVolume} streams it): a carrier
   * empties it (a folder itself stays, with its owner and mode) and exits, then the archive is
   * unpacked into the stopped carrier, owners and modes kept. On failure `archive` is destroyed,
   * and the call settles once it has closed.
   */
  writeVolume(source: CarrierSource, archive: Readable): Promise<void>;
  /** One SHA-256 (hex) over the source's paths, types, modes, owners, sizes and contents. */
  volumeDigest(source: CarrierSource): Promise<string>;
  /**
   * The source's size in bytes: a volume's from Docker's disk usage, a folder's (and a volume's
   * Docker can't tell) from the carrier's `du -sb`.
   */
  sourceSize(source: CarrierSource): Promise<number>;
  /**
   * Every path of the source with its facts, sorted by path, from a read-only carrier. A name with
   * a line break, or one that isn't UTF-8, is refused (`INVALID_INPUT`): such a source is copied
   * whole.
   */
  volumeManifest(source: CarrierSource): Promise<ManifestEntry[]>;
  /**
   * The source's `paths` (manifest paths) as a tar stream, files under `data/` as
   * {@link readVolume} streams them, from a read-only carrier. Folders are archived without their
   * content (`--no-recursion`): each changed path is listed itself. The root and the folders
   * above each path come too, with the source's owners and modes. The list reaches the carrier
   * as a file, never as arguments.
   */
  readPaths(source: CarrierSource, paths: readonly string[]): Promise<Readable>;
  /**
   * Unpacks `archive` (as {@link readPaths} streams it) over the source's content without emptying
   * it, owners and modes kept, and removes `remove` (manifest paths, deepest first) and their
   * content. The removal runs first, while every folder of a removed path is still the folder the
   * manifest listed, so a path an unpacked link replaced can't lead outside the source. On failure
   * `archive` is destroyed, and the call settles once it has closed.
   */
  updateVolume(source: CarrierSource, archive: Readable, remove: readonly string[]): Promise<void>;
}

/**
 * The carrier operations on `docker`'s host, with `image` as the carrier (a pinned busybox,
 * pulled when the host lacks it). A folder is bound only when it is under one of `allowedRoots`
 * (such as `/srv/data/`); with none, only volumes are. Each operation refuses a source that
 * doesn't exist and a folder that is a symbolic link, before touching anything, and removes its
 * carriers, also when it fails.
 */
export function volumeCarrier(
  docker: DockerClient,
  image: string,
  allowedRoots: readonly string[] = [],
): VolumeCarrier {
  /** How a carrier mounts `source` at {@link MOUNT}. */
  const mounted = (source: CarrierSource, readOnly: boolean): MountSpec => ({
    type: source.kind,
    source: located(source),
    target: MOUNT,
    readOnly,
  });

  function missing(source: CarrierSource): OpsCrewError {
    return new OpsCrewError("INVALID_INPUT", `There is no ${described(source)} on the server.`, {
      hint:
        source.kind === "volume"
          ? "Check the volume's name with `docker volume ls` on the server, then try again."
          : "Check the service's data folder on the server, then try again.",
    });
  }

  /**
   * A carrier for `source` with `mounts` (Docker's `Mounts`, so a folder that isn't there is
   * refused, never created) and `cmd`.
   */
  const carrierSpec = (source: CarrierSource, mounts: MountSpec[], cmd?: string[]) => ({
    image,
    ...(cmd === undefined ? {} : { cmd }),
    labels: { [CARRIER_LABEL]: located(source) },
    mounts,
    network: "none",
  });

  /** Docker's refusal of a missing folder (or of the parent the link check mounts) as {@link missing}. */
  function absentAsMissing(source: CarrierSource, error: unknown): unknown {
    const absent = /bind source path does not exist/.test(errorMessage(error));
    return error instanceof DockerApiError && absent ? missing(source) : error;
  }

  /** Creates a carrier ({@link carrierSpec}), pulling the image when the host lacks it. */
  async function create(
    source: CarrierSource,
    mounts: MountSpec[],
    cmd?: string[],
  ): Promise<string> {
    try {
      return await createPulled(docker, carrierSpec(source, mounts, cmd));
    } catch (error) {
      throw absentAsMissing(source, error);
    }
  }

  /**
   * Runs a carrier to its end ({@link runOneOff}) and returns its exit code and output. A failure
   * wins over the removal's: a carrier it could not remove is left for sweepCarriers.
   */
  async function run(
    source: CarrierSource,
    mounts: MountSpec[],
    cmd: string[],
  ): Promise<OneOffResult> {
    try {
      return await runOneOff(docker, carrierSpec(source, mounts, cmd));
    } catch (error) {
      throw absentAsMissing(source, error instanceof ContainerLeftError ? error.cause : error);
    }
  }

  function failed(act: string, source: CarrierSource, exitCode: number, stderr: string) {
    const said = stderr.trim().split("\n").at(-1)?.trim();
    return new OpsCrewError(
      "PROVIDER_ERROR",
      `The carrier container could not ${act} ${described(source)} (exit code ${exitCode}${said ? `: ${said}` : ""}).`,
      { hint: "Check the volume or folder and the server's disk, then try again." },
    );
  }

  /** A carrier's stdout, failing plainly unless it exited 0. */
  function succeeded(result: OneOffResult, act: string, source: CarrierSource): string {
    if (result.exitCode !== 0) throw failed(act, source, result.exitCode, result.stderr);
    return result.stdout;
  }

  /** The number the carrier printed first, or a plain failure saying it printed no `what`. */
  function printed(pattern: RegExp, stdout: string, what: string, source: CarrierSource) {
    const value = pattern.exec(stdout)?.[1];
    if (value === undefined) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `The carrier container did not print ${what} of ${described(source)}.`,
        { hint: "Check that the carrier image is the one OpsCrew pins, then try again." },
      );
    }
    return value;
  }

  /**
   * Refuses a source a carrier must not mount, before anything is touched: a missing volume (a
   * mount would create it, empty), and a folder outside the rules or that is a symbolic link. A
   * missing folder is refused by Docker when the carrier is created.
   */
  async function check(source: CarrierSource): Promise<void> {
    if (source.kind === "volume") {
      if (!(await docker.volumeExists(source.name))) throw missing(source);
      return;
    }
    checkFolder(source.path, allowedRoots);
    // Docker follows a link in a bind's source, so a linked folder would be read, emptied and
    // written wherever it points; no bind option refuses one. A carrier with the parent mounted
    // read-only looks at the folder itself (`test ! -L` exits 1 for a link).
    const parent: MountSpec = {
      type: "bind",
      source: path.posix.dirname(source.path),
      target: PARENT_MOUNT,
      readOnly: true,
    };
    const look = ["test", "!", "-L", `${PARENT_MOUNT}/${path.posix.basename(source.path)}`];
    const { exitCode, stderr } = await run(source, [parent], look);
    if (exitCode === 1) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The folder ${source.path} on the server is a symbolic link, which OpsCrew doesn't follow.`,
        { hint: "Bind the service to the folder the link points to, then try again." },
      );
    }
    if (exitCode !== 0) throw failed("look at", source, exitCode, stderr);
  }

  /**
   * Creates a carrier ({@link create}), puts `list` into it as {@link LIST} when given, and runs it
   * to its end. The carrier stays, for the caller to read from and remove; a step's failure removes
   * it.
   */
  async function ranKept(
    source: CarrierSource,
    mounts: MountSpec[],
    cmd: string[],
    list?: readonly string[],
  ): Promise<{ id: string } & OneOffResult> {
    const id = await create(source, mounts, cmd);
    try {
      if (list !== undefined) await docker.putArchive(id, "/", listArchive(list));
      await docker.startContainer(id);
      const exitCode = await docker.waitContainer(id);
      return { id, exitCode, ...(await docker.containerLogs(id)) };
    } catch (error) {
      await docker.removeContainer(id).catch(() => {});
      throw error;
    }
  }

  /**
   * Runs `work` on the carrier `id`, then removes it. A failure wins over the removal's: a carrier
   * left behind is for sweepCarriers.
   */
  async function thenRemoved<T>(id: string, work: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await work();
    } catch (error) {
      await docker.removeContainer(id).catch(() => {});
      throw error;
    }
    await docker.removeContainer(id);
    return result;
  }

  /**
   * The archive of {@link MOUNT} in the carrier `id`, streamed. The carrier is removed before the
   * stream ends, or before it closes when it is destroyed early; when the archive can't be read,
   * at once.
   */
  async function streamed(source: CarrierSource, id: string): Promise<Readable> {
    let archive: Readable;
    try {
      archive = await docker.getArchive(id, MOUNT);
    } catch (error) {
      await docker.removeContainer(id).catch(() => {});
      throw error;
    }
    let removal: Promise<void> | undefined;
    const remove = () => {
      removal ??= docker.removeContainer(id);
      return removal;
    };
    const out = new Transform({
      transform: (chunk, _encoding, callback) => callback(null, chunk),
      // The stream ends once the carrier is gone; a removal that fails fails the stream.
      flush: (callback) => {
        remove().then(() => callback(), callback);
      },
      // Destroyed early, the stream closes once the removal settled. A carrier it couldn't
      // remove is left for sweepCarriers.
      destroy: (error, callback) => {
        archive.destroy();
        remove().then(
          () => callback(error),
          () => callback(error),
        );
      },
    });
    archive.on("error", (error) => {
      out.destroy(
        new OpsCrewError(
          "PROVIDER_ERROR",
          `Reading ${described(source)} broke off: ${errorMessage(error).replace(/\.$/, "")}.`,
          { hint: "Check the connection to the server, then try again." },
        ),
      );
    });
    return archive.pipe(out);
  }

  /**
   * Prepares the source in a carrier mounted read-write (`cmd`, as `act`; `list`, which throws to
   * refuse, gives the paths put in as {@link LIST}), then unpacks `archive` into the stopped
   * carrier, owners and modes kept. On failure `archive` is destroyed, and this settles once it
   * has closed.
   */
  async function unpacked(
    source: CarrierSource,
    archive: Readable,
    act: string,
    cmd: string[],
    list?: () => readonly string[],
  ): Promise<void> {
    // The archive's failure surfaces through the upload, or is outrun by an earlier one; this
    // keeps one that comes while the source is being prepared from going unhandled.
    archive.on("error", () => {});
    try {
      const paths = list?.();
      await check(source);
      const ran = await ranKept(source, [mounted(source, false)], cmd, paths);
      await thenRemoved(ran.id, async () => {
        succeeded(ran, act, source);
        await docker.putArchive(ran.id, "/", archive);
      });
    } catch (error) {
      // A read carrier's archive closes once its carrier is removed: wait for that, so the
      // source's connection can be closed right after.
      if (!archive.closed) {
        const closed = new Promise((resolve) => archive.once("close", resolve));
        archive.destroy();
        await closed;
      }
      throw error;
    }
  }

  return {
    async readVolume(source) {
      await check(source);
      return streamed(source, await create(source, [mounted(source, true)]));
    },

    writeVolume: (source, archive) =>
      unpacked(source, archive, "empty", ["find", MOUNT, "-mindepth", "1", "-delete"]),

    async volumeDigest(source) {
      await check(source);
      const result = await run(source, [mounted(source, true)], ["sh", "-c", DIGEST_SCRIPT]);
      const stdout = succeeded(result, "hash", source);
      return printed(/^([0-9a-f]{64})\s/, stdout, "a hash", source);
    },

    async sourceSize(source) {
      if (source.kind === "volume") {
        const bytes = (await docker.volumeSizes()).get(source.name);
        if (bytes !== undefined) return bytes;
      }
      // A folder, or a volume whose size Docker can't tell (another volume driver's).
      await check(source);
      const result = await run(source, [mounted(source, true)], ["du", "-sb", MOUNT]);
      const stdout = succeeded(result, "measure", source);
      return Number(printed(/^(\d+)\s/, stdout, "a size", source));
    },

    async volumeManifest(source) {
      await check(source);
      // Read back as a file, not the carrier's output: a log driver may cap or rotate that.
      const ran = await ranKept(source, [mounted(source, true)], ["sh", "-c", MANIFEST_SCRIPT]);
      const files = await thenRemoved(ran.id, async () => {
        if (ran.exitCode === LINE_BREAK_EXIT) throw unlistable(source, "with a line break");
        succeeded(ran, "list", source);
        return parseTar(await buffer(await docker.getArchive(ran.id, MANIFEST)));
      });
      return parseManifest(files, source);
    },

    async readPaths(source, paths) {
      checkPaths(paths, source, true);
      // The root and every folder above a path, so the stage holds them with the source's owners
      // and modes rather than tar's defaults; sorted, each folder comes before what is in it.
      const listed = new Set(["."]);
      for (const item of paths) {
        const parts = item.split("/");
        for (let end = 2; end <= parts.length; end++) listed.add(parts.slice(0, end).join("/"));
      }
      await check(source);
      const mounts = [{ ...mounted(source, true), target: SOURCE_MOUNT }];
      const ran = await ranKept(source, mounts, ["sh", "-c", STAGE_SCRIPT], [...listed].sort());
      if (ran.exitCode !== 0) {
        await docker.removeContainer(ran.id).catch(() => {});
        throw failed("read paths of", source, ran.exitCode, ran.stderr);
      }
      return streamed(source, ran.id);
    },

    updateVolume: (source, archive, remove) =>
      unpacked(source, archive, "remove paths from", ["sh", "-c", REMOVE_SCRIPT], () => {
        checkPaths(remove, source, false);
        return [...remove].sort((a, b) => depth(b) - depth(a) || (a < b ? 1 : a > b ? -1 : 0));
      }),
  };
}

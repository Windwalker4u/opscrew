/**
 * The carrier against the local Docker, through `docker system dial-stdio` processes that core's
 * `NodeStreamRunner` starts: a volume of a few MB with owners, modes and a link is read, written
 * into a second volume that held other files, and the two digests match; the same for a folder
 * bound from the Docker host, and for a volume written into that folder; a full copy whose source
 * then changed is brought to the same digest by the delta of the two manifests. It pulls the pinned
 * busybox, so it runs only with OPSCREW_DOCKER_TESTS=1, and removes what it made (the image too,
 * when it wasn't there before).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { NodeStreamRunner } from "@opscrew/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { manifestDelta } from "./__fixtures__/delta";
import { volumeCarrier } from "./carrier";
import { type DockerClient, dockerClient } from "./client";
import { dialStdioTransport } from "./dial-stdio";

/** `IMAGES.busybox` in iac-templates' pins (this package doesn't depend on iac-templates). */
const BUSYBOX =
  "busybox:1.38.0@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4";
const BUSYBOX_BY_DIGEST = BUSYBOX.replace(/:[^:@]+@/, "@");

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason) console.warn(`[connector-docker] skipping the carrier against Docker: ${reason}`);

const SEED = `set -e
dd if=/dev/urandom of=/data/big.bin bs=1048576 count=4 2>/dev/null
mkdir -p /data/app/cache
echo "port=8080" > /data/app/config.txt
head -c 200000 /dev/urandom > /data/app/cache/blob
chown -R 1000:1001 /data/app
chmod 640 /data/app/config.txt
chown 999:999 /data/app/cache/blob
chmod 600 /data/app/cache/blob
ln -s app/config.txt /data/link
chown -h 1000:1000 /data/link
chmod 750 /data`;

/**
 * Before the copy: folder trees, a file and a long name that change type, and a file kept unchanged
 * in a folder that changes.
 */
const TRIMMED = `mkdir -p /data/trim/deep /data/was-dir/inner
echo t > /data/trim/deep/t
echo i > /data/was-dir/inner/i
echo f > /data/was-file
echo k > /data/app/cache/kept
head -c 300 /dev/urandom > "/data/$(printf 'l%.0s' $(seq 1 120))"`;

/**
 * The source's changes after the full copy: content of the same size, a mode, a folder's owner, a
 * new tree with spaces, leading dashes and a setuid bit, a link turned folder, a new link with its
 * own owner, a file turned folder, a folder turned file, a trimmed tree, and a name with a carriage
 * return.
 */
const CHANGES = `set -e
dd if=/dev/urandom of=/data/big.bin bs=1 count=16 seek=1000 conv=notrunc 2>/dev/null
chmod 600 /data/app/config.txt
chown 1002:1002 /data/app/cache
rm /data/app/cache/blob
mkdir -p "/data/-sub dir/-deeper"
echo n > "/data/-sub dir/ lead.txt"
echo m > "/data/-sub dir/-deeper/-m"
chown -R 33:33 "/data/-sub dir"
chmod 4755 "/data/-sub dir/ lead.txt"
rm /data/link
mkdir /data/link
ln -s big.bin "/data/-new link"
chown -h 7:7 "/data/-new link"
rm "/data/$(printf 'l%.0s' $(seq 1 120))"
mkdir "/data/$(printf 'l%.0s' $(seq 1 120))"
rm -rf /data/trim
rm -rf /data/was-dir
echo d > /data/was-dir
rm /data/was-file
mkdir /data/was-file
echo g > /data/was-file/g
echo i > "/data/app/Icon$(printf '\\r')"`;

const STALE = `set -e
echo old > /data/stale.txt
mkdir /data/old
chmod 700 /data`;

describe.skipIf(reason !== undefined)("the carrier against the local Docker", () => {
  const run = randomBytes(4).toString("hex");
  const runner = new NodeStreamRunner();
  const transports = [1, 2].map(() =>
    dialStdioTransport(() => runner.open("docker", ["system", "dial-stdio"])),
  );
  const [here, there] = transports.map(dockerClient) as [DockerClient, DockerClient];
  const helpers: string[] = [];
  let hadImage = false;

  /**
   * Runs `script` in a busybox with `bind` (`<volume or host folder>:<path>`) mounted, and fails
   * with its output if it fails.
   */
  async function shell(bind: string, script: string): Promise<void> {
    const [source = "", target = ""] = bind.split(":");
    const type = source.startsWith("/") ? "bind" : "volume";
    const id = await here.createContainer({
      image: BUSYBOX,
      cmd: ["sh", "-c", script],
      mounts: [{ type, source, target }],
      labels: { "opscrew.test": run },
      network: "none",
    });
    helpers.push(id);
    await here.startContainer(id);
    const exitCode = await here.waitContainer(id);
    expect({ exitCode, logs: await here.containerLogs(id) }).toMatchObject({ exitCode: 0 });
    await here.removeContainer(id);
  }

  beforeAll(async () => {
    hadImage = spawnSync("docker", ["image", "inspect", BUSYBOX_BY_DIGEST]).status === 0;
    await here.pullImage(BUSYBOX);
  }, 120_000);

  afterAll(async () => {
    for (const id of helpers) await here.removeContainer(id).catch(() => {});
    for (const transport of transports) await transport.close?.();
    if (!hadImage) spawnSync("docker", ["image", "rm", BUSYBOX_BY_DIGEST]);
  }, 60_000);

  it("copies a volume with owners, modes and a link into another, and the digests match", async () => {
    const source = { kind: "volume", name: `opscrew-test-${run}-source` } as const;
    const target = { kind: "volume", name: `opscrew-test-${run}-target` } as const;
    try {
      for (const { name } of [source, target]) await here.createVolume(name);
      await shell(`${source.name}:/data`, SEED);
      await shell(`${target.name}:/data`, STALE);

      const reader = volumeCarrier(here, BUSYBOX);
      const writer = volumeCarrier(there, BUSYBOX);
      const digest = await reader.volumeDigest(source);
      expect(await writer.volumeDigest(target)).not.toBe(digest);

      const started = Date.now();
      await writer.writeVolume(target, await reader.readVolume(source));
      const copied = await writer.volumeDigest(target);
      console.info(
        `[connector-docker] copied volume ${source.name} in ${Date.now() - started} ms; digests ${digest} and ${copied}`,
      );
      expect(copied).toBe(digest);

      const ours = (await here.listVolumes()).filter((v) =>
        v.name.startsWith(`opscrew-test-${run}-`),
      );
      expect(ours.map((v) => v.name).sort()).toEqual([source.name, target.name].sort());
      expect(await reader.sourceSize(source)).toBeGreaterThan(4 * 1024 * 1024);
      for (const { name } of [source, target]) {
        expect(await here.listContainers([`opscrew.carrier=${name}`])).toEqual([]);
      }

      await shell(`${target.name}:/data`, "chmod 644 /data/app/cache/blob");
      expect(await writer.volumeDigest(target)).not.toBe(digest);
    } finally {
      for (const { name } of [source, target]) await here.removeVolume(name).catch(() => {});
    }
  }, 300_000);

  it("brings a full copy to the source's digest by the delta after the source changed, grew and shrank", async () => {
    const source = { kind: "volume", name: `opscrew-test-${run}-delta-source` } as const;
    const target = { kind: "volume", name: `opscrew-test-${run}-delta-target` } as const;
    try {
      for (const { name } of [source, target]) await here.createVolume(name);
      await shell(`${source.name}:/data`, `${SEED}\n${TRIMMED}`);
      const reader = volumeCarrier(here, BUSYBOX);
      const writer = volumeCarrier(there, BUSYBOX);
      await writer.writeVolume(target, await reader.readVolume(source));
      expect(await writer.volumeDigest(target)).toBe(await reader.volumeDigest(source));

      await shell(`${source.name}:/data`, CHANGES);
      const digest = await reader.volumeDigest(source);
      expect(await writer.volumeDigest(target)).not.toBe(digest);

      const old = await reader.volumeManifest(source);
      expect(await reader.volumeManifest(source)).toEqual(old);
      const { copy, remove } = manifestDelta(old, await writer.volumeManifest(target));
      expect(remove.sort()).toEqual(["./app/cache/blob", "./trim", "./was-dir/inner"]);
      expect(copy).toContain("./-sub dir/ lead.txt");
      expect(copy).toContain("./app/Icon\r");
      expect(copy).not.toContain("./app/cache/kept");
      const started = Date.now();
      await writer.updateVolume(target, await reader.readPaths(source, copy), remove);
      const copied = await writer.volumeDigest(target);
      console.info(
        `[connector-docker] copied ${copy.length} paths and removed ${remove.length} in ${Date.now() - started} ms; digests ${digest} and ${copied}`,
      );
      expect(copied).toBe(digest);
      expect(await writer.volumeManifest(target)).toEqual(old);

      await shell(`${source.name}:/data`, `touch "/data/$(printf 'a\\nb')"`);
      await expect(reader.volumeManifest(source)).rejects.toThrow(
        `The volume ${source.name} holds a name with a line break, which OpsCrew can't compare path by path.`,
      );
      for (const { name } of [source, target]) {
        expect(await here.listContainers([`opscrew.carrier=${name}`])).toEqual([]);
      }
    } finally {
      for (const { name } of [source, target]) await here.removeVolume(name).catch(() => {});
    }
  }, 300_000);

  it("copies a folder bound from the host into another, and a volume into it, and the digests match", async () => {
    // The folders are on the Docker host (with Docker Desktop, in its Linux VM), so busybox
    // containers with the host's /tmp bound in make and remove them.
    const base = `opscrew-carrier-test-${run}`;
    const root = `/tmp/${base}/`;
    const source = { kind: "bind", path: `${root}source` } as const;
    const target = { kind: "bind", path: `${root}target` } as const;
    const volume = { kind: "volume", name: `opscrew-test-${run}-volume` } as const;
    try {
      await shell("/tmp:/host-tmp", `mkdir -p /host-tmp/${base}/source /host-tmp/${base}/target`);
      await shell(`${source.path}:/data`, SEED);
      await shell(`${target.path}:/data`, STALE);

      const reader = volumeCarrier(here, BUSYBOX, [root]);
      const writer = volumeCarrier(there, BUSYBOX, [root]);
      const digest = await reader.volumeDigest(source);
      expect(await writer.volumeDigest(target)).not.toBe(digest);

      const started = Date.now();
      await writer.writeVolume(target, await reader.readVolume(source));
      const copied = await writer.volumeDigest(target);
      console.info(
        `[connector-docker] copied folder ${source.path} in ${Date.now() - started} ms; digests ${digest} and ${copied}`,
      );
      expect(copied).toBe(digest);
      expect(await reader.sourceSize(source)).toBeGreaterThan(4 * 1024 * 1024);

      await here.createVolume(volume.name);
      await shell(`${volume.name}:/data`, SEED);
      await writer.writeVolume(target, await reader.readVolume(volume));
      expect(await writer.volumeDigest(target)).toBe(await reader.volumeDigest(volume));

      const missing = { kind: "bind", path: `${root}missing` } as const;
      await expect(reader.readVolume(missing)).rejects.toThrow(
        `There is no folder ${missing.path} on the server.`,
      );
      await shell("/tmp:/host-tmp", `test ! -e /host-tmp/${base}/missing`);

      const link = { kind: "bind", path: `${root}link` } as const;
      await shell("/tmp:/host-tmp", `ln -s source /host-tmp/${base}/link`);
      await expect(writer.writeVolume(link, await reader.readVolume(source))).rejects.toThrow(
        `The folder ${link.path} on the server is a symbolic link, which OpsCrew doesn't follow.`,
      );
      expect(await reader.volumeDigest(source)).toBe(digest);
      for (const { path } of [source, target, missing, link]) {
        expect(await here.listContainers([`opscrew.carrier=${path}`])).toEqual([]);
      }
    } finally {
      await shell("/tmp:/host-tmp", `rm -rf /host-tmp/${base}`).catch(() => {});
      await here.removeVolume(volume.name).catch(() => {});
    }
  }, 300_000);
});

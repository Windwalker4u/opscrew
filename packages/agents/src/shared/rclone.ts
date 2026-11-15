/**
 * rclone in a one-off container of the pinned image (ADR 0027), where an app's server or the
 * user's Portainer reaches its buckets: its configuration, with the buckets' keys, never on a
 * command line or in a container's `Env` or `Cmd`. Over SSH (as `deploy`) the configuration
 * arrives on standard input only and is written to a `/tmp` held in memory in the container; in
 * Portainer it is written into the created container through Docker's archive API before it
 * starts, and goes with the container, which is removed afterwards. A failure stops with the end of
 * rclone's output, redacted, naming the place in words instead of its address.
 */
import {
  ContainerLeftError,
  type DockerClient,
  runOneOff,
  tarStream,
} from "@opscrew/connector-docker";
import type { RemoteExec } from "@opscrew/contracts";
import {
  durationText,
  errorMessage,
  OpsCrewError,
  type Redactor,
  replaceNames,
} from "@opscrew/core";
import { IMAGES, type ProviderBucket } from "@opscrew/iac-templates";
import { z } from "zod";
import { r2Endpoint, STORAGE_ENDPOINTS, type StorageLogin } from "./app-env";

/** A bucket's size, from `rclone size --json`. */
export interface BucketSize {
  bytes: number;
  /** Its number of objects. */
  count: number;
}

/** One `[name]` section of rclone's configuration for a Hetzner or Spaces `bucket`, with `key`. */
export function s3Remote(
  name: string,
  bucket: Pick<ProviderBucket, "provider" | "region">,
  key: StorageLogin,
): string[] {
  const endpoint = STORAGE_ENDPOINTS[bucket.provider];
  if (endpoint === undefined) throw new Error(`No S3 endpoint is known for ${bucket.provider}.`);
  return [
    `[${name}]`,
    "type = s3",
    `provider = ${bucket.provider === "digitalocean" ? "DigitalOcean" : "Other"}`,
    `access_key_id = ${key.accessKeyId}`,
    `secret_access_key = ${key.secretAccessKey}`,
    `endpoint = ${endpoint(bucket.region)}`,
    ...(bucket.provider === "hetzner" ? [`region = ${bucket.region}`] : []),
    // The buckets exist: rclone never tries to create one.
    "no_check_bucket = true",
  ];
}

/**
 * One `[name]` section of rclone's configuration for the R2 buckets of the Cloudflare account
 * `accountId` (its own S3 endpoint), with `key`.
 */
export function r2Remote(name: string, accountId: string, key: StorageLogin): string[] {
  return [
    `[${name}]`,
    "type = s3",
    "provider = Cloudflare",
    `access_key_id = ${key.accessKeyId}`,
    `secret_access_key = ${key.secretAccessKey}`,
    `endpoint = ${r2Endpoint(accountId)}`,
    "region = auto",
    // The buckets exist, and a key limited to them may not create one.
    "no_check_bucket = true",
  ];
}

/** One run of rclone: what it does, its configuration and what a failure says. */
export interface RcloneRun {
  /** rclone's arguments after `--config <file>`: fixed words and validated bucket names only. */
  args: readonly string[];
  /** The configuration's lines, the keys among them. */
  config: readonly string[];
  /** How long it may run over SSH; Docker's API waits for the container to end. */
  timeoutMs: number;
  /** What it does, for a failure: `Copying the bucket shop-uploads`. */
  what: string;
  /** What to do after a failure. */
  hint: string;
}

/** Runs rclone where the buckets are reached and returns its output. */
export type RcloneRunner = (run: RcloneRun) => Promise<string>;

/** The end of rclone's output (its last 5 lines), or the exit code when it said nothing. */
function lastLines(stdout: string, stderr: string, exitCode: number): string {
  const said = (stderr || stdout).trim().split("\n").slice(-5).join("\n");
  return said || `exit code ${exitCode}`;
}

/** The plain stop after a failed run: redacted, `host` (when known) in `words`. */
function failed(
  redactor: Pick<Redactor, "redact">,
  run: RcloneRun,
  words: string,
  why: string,
  host?: string,
): OpsCrewError {
  const text = redactor.redact(`${run.what} failed on ${words}: ${why}`);
  return new OpsCrewError(
    "COMMAND_FAILED",
    host === undefined ? text : replaceNames(text, [host], words),
    { hint: run.hint },
  );
}

/**
 * The shell command of a one-off container of the pinned rclone image running `args`. Its
 * configuration arrives on standard input only: `sh` writes it to a file only this container can
 * read, in a `/tmp` held in memory (never on the server's disk), which goes with the container
 * (`--rm`). The image's entrypoint is rclone itself, so `sh` is named as the entrypoint.
 */
export function rcloneCommand(args: readonly string[]): string {
  return `docker run -i --rm --tmpfs /tmp:mode=0700 --entrypoint sh ${IMAGES.rclone.ref} -c 'umask 077; cat >/tmp/r.conf; exec rclone --config /tmp/r.conf ${args.join(" ")}'`;
}

/**
 * Runs rclone in a one-off container on the server `remote` reaches ({@link rcloneCommand}), with
 * its configuration on standard input only. `words` names the server in what a failure says.
 */
export function sshRclone(
  redactor: Pick<Redactor, "redact">,
  remote: RemoteExec,
  words: string,
): RcloneRunner {
  return async (run) => {
    const result = await remote.run(rcloneCommand(run.args), {
      input: `${run.config.join("\n")}\n`,
      timeoutMs: run.timeoutMs,
    });
    if (result.exitCode === 0 && result.timedOut !== true) return result.stdout;
    const why =
      result.timedOut === true
        ? `it did not finish within ${durationText(run.timeoutMs)}`
        : lastLines(result.stdout, result.stderr, result.exitCode);
    throw failed(redactor, run, words, why, remote.host);
  };
}

/** Where a container of {@link dockerRclone} finds its configuration (mode 0600, root's). */
const CONFIG = "/tmp/r.conf";

/** The label of every container {@link dockerRclone} runs; its value names whose it is. */
export const RCLONE_LABEL = "opscrew.rclone";

/**
 * Runs rclone in a one-off container through `docker` (Portainer's Docker proxy): its
 * configuration is written into the created container at {@link CONFIG} through the archive API
 * before it starts, and goes when the container is removed afterwards. On Docker's default network,
 * so it reaches the buckets. Each container is labelled {@link RCLONE_LABEL} with `owner`, and any
 * left by an earlier run with it (each holds the buckets' keys) is removed first. Docker's API only
 * waits for a container, so one that outlasts `timeoutMs` is stopped. `words` names the place in
 * what a failure says.
 */
export function dockerRclone(
  redactor: Pick<Redactor, "redact">,
  docker: DockerClient,
  words: string,
  owner: string,
): RcloneRunner {
  return async (run) => {
    for (const left of await docker.listContainers([`${RCLONE_LABEL}=${owner}`])) {
      await docker.removeContainer(left.id);
    }
    const file = {
      name: CONFIG.slice(1),
      type: "file",
      mode: 0o600,
      uid: 0,
      gid: 0,
      data: Buffer.from(`${run.config.join("\n")}\n`),
    } as const;
    let id: string | undefined;
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      // The wait then ends, and the container is removed as after any run.
      if (id !== undefined) docker.stopContainer(id, 0).catch(() => undefined);
    }, run.timeoutMs);
    // Once its output is read, rclone has ended: only the container's removal is left.
    let ended = false;
    const watched: DockerClient = {
      ...docker,
      containerLogs: async (container) => {
        const logs = await docker.containerLogs(container);
        ended = true;
        return logs;
      },
    };
    let result: Awaited<ReturnType<typeof runOneOff>>;
    try {
      result = await runOneOff(
        watched,
        {
          image: IMAGES.rclone.ref,
          cmd: ["--config", CONFIG, ...run.args],
          labels: { [RCLONE_LABEL]: owner },
        },
        async (created) => {
          id = created;
          // The time ran out before the container was there: it never starts, and is removed.
          if (late) throw new Error("the time ran out before the container started");
          await docker.putArchive(created, "/", tarStream([file]));
        },
      );
    } catch (error) {
      // A container left behind holds the buckets' keys: never silently.
      if (!(error instanceof ContainerLeftError)) {
        if (late) {
          throw failed(
            redactor,
            run,
            words,
            `it did not finish within ${durationText(run.timeoutMs)}`,
          );
        }
        throw error;
      }
      const short = error.id.slice(0, 12);
      const why = errorMessage(error.cause).replace(/\.?$/, ".");
      throw new OpsCrewError(
        "COMMAND_FAILED",
        redactor.redact(
          ended
            ? `${run.what} on ${words}: rclone ended, but its container ${short} could not be removed: ${why} It holds the buckets' keys.`
            : `${run.what} failed on ${words}: ${why} OpsCrew could not remove its one-off container ${short} either, which holds the buckets' keys.`,
        ),
        {
          hint: `Remove it on the Docker host with \`docker rm -f ${short}\` (OpsCrew also removes it before its next rclone run there). ${run.hint}`,
        },
      );
    } finally {
      clearTimeout(timer);
    }
    if (late) {
      throw failed(redactor, run, words, `it did not finish within ${durationText(run.timeoutMs)}`);
    }
    if (result.exitCode === 0) return result.stdout;
    throw failed(redactor, run, words, lastLines(result.stdout, result.stderr, result.exitCode));
  };
}

const RcloneSizeSchema = z.object({
  count: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
});

/**
 * The size and object count of `path` (`<remote>:<bucket>`) by `rclone size --json`, read with
 * `run`'s configuration; `bucket` and `command` name the bucket and what to run again in a stop.
 */
export async function rcloneSize(
  rclone: RcloneRunner,
  run: Omit<RcloneRun, "args"> & { path: string; bucket: string; command: string },
): Promise<BucketSize> {
  const { path, bucket, command, ...rest } = run;
  const out = await rclone({ ...rest, args: ["size", "--json", path] });
  try {
    const size = RcloneSizeSchema.parse(JSON.parse(out));
    return { bytes: size.bytes, count: size.count };
  } catch {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `rclone did not say the size of the bucket ${bucket}. Nothing was changed.`,
      { hint: `Run \`${command}\` again.` },
    );
  }
}

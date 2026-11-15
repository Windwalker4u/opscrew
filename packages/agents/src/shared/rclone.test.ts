import { Readable } from "node:stream";
import { dockerClient } from "@opscrew/connector-docker";
import { FakeDocker, parseTar } from "@opscrew/connector-docker/testing";
import type {
  CommandResult,
  DockerTransport,
  RemoteExec,
  RemoteRunOptions,
} from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import type { StorageLogin } from "./app-env";
import {
  dockerRclone,
  type RcloneRun,
  r2Remote,
  rcloneCommand,
  rcloneSize,
  s3Remote,
  sshRclone,
} from "./rclone";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const HOST = "203.0.113.10";

function key(name: string): StorageLogin {
  return {
    accessKeyId: fakeSecret("aws-access-key-id", name),
    secretAccessKey: fakeSecret("aws-secret-access-key", name),
  };
}

/** A redactor that knows `keys`, as `requireStorageKey` registers them. */
function redactorOf(...keys: StorageLogin[]): Redactor {
  const redactor = new Redactor();
  for (const k of keys) {
    redactor.addLiteral(k.accessKeyId, "storage-key");
    redactor.addLiteral(k.secretAccessKey, "storage-key");
  }
  return redactor;
}

/** A shell that answers each command with `answer` and records it. */
function fakeRemote(answer: (command: string) => CommandResult) {
  const runs: { command: string; options: RemoteRunOptions | undefined }[] = [];
  const remote: RemoteExec = {
    host: HOST,
    run: async (command, options) => {
      runs.push({ command, options });
      return answer(command);
    },
  };
  return { remote, runs };
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

function copyRun(config: string[]): RcloneRun {
  return {
    args: ["copy", "a:shop-uploads", "b:shop-uploads", "--checksum", "--metadata"],
    config,
    timeoutMs: 60_000,
    what: "Copying the bucket shop-uploads",
    hint: "Run `opscrew cloudflare move` again.",
  };
}

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpsCrewError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("rclone's remotes", () => {
  it("names R2's provider and the account's endpoint", () => {
    const k = key("r2");
    expect(r2Remote("a", ACCOUNT, k)).toEqual([
      "[a]",
      "type = s3",
      "provider = Cloudflare",
      `access_key_id = ${k.accessKeyId}`,
      `secret_access_key = ${k.secretAccessKey}`,
      `endpoint = https://${ACCOUNT}.r2.cloudflarestorage.com`,
      "region = auto",
      "no_check_bucket = true",
    ]);
  });

  it("keeps Hetzner's and Spaces' endpoints by region", () => {
    const k = key("s3");
    expect(s3Remote("old", { provider: "hetzner", region: "fsn1" }, k)).toContain(
      "endpoint = https://fsn1.your-objectstorage.com",
    );
    expect(s3Remote("new", { provider: "digitalocean", region: "fra1" }, k)).toContain(
      "provider = DigitalOcean",
    );
  });
});

describe("sshRclone", () => {
  it("runs the pinned image with the configuration on standard input only", async () => {
    const k = key("ssh");
    const { remote, runs } = fakeRemote(() => ok("done"));
    const out = await sshRclone(
      redactorOf(k),
      remote,
      "the app's server",
    )(copyRun(r2Remote("a", ACCOUNT, k)));
    expect(out).toBe("done");
    const [run] = runs;
    expect(run?.command).toBe(
      rcloneCommand(["copy", "a:shop-uploads", "b:shop-uploads", "--checksum", "--metadata"]),
    );
    expect(run?.command).toContain(
      `docker run -i --rm --tmpfs /tmp:mode=0700 --entrypoint sh ${IMAGES.rclone.ref} -c 'umask 077; cat >/tmp/r.conf; exec rclone --config /tmp/r.conf copy a:shop-uploads b:shop-uploads --checksum --metadata'`,
    );
    expect(run?.command).not.toContain(k.secretAccessKey);
    expect(run?.command).not.toContain(k.accessKeyId);
    expect(run?.options?.input).toContain(`secret_access_key = ${k.secretAccessKey}`);
    expect(run?.options?.timeoutMs).toBe(60_000);
  });

  it("stops with the end of rclone's output, redacted, the server in words", async () => {
    const k = key("ssh-fail");
    const { remote } = fakeRemote(() => ({
      exitCode: 1,
      stdout: "",
      stderr: `ERROR: denied for ${k.secretAccessKey} at ${HOST}`,
    }));
    const error = await caught(
      sshRclone(redactorOf(k), remote, "the app's server")(copyRun(r2Remote("a", ACCOUNT, k))),
    );
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe(
      "Copying the bucket shop-uploads failed on the app's server: ERROR: denied for [REDACTED:storage-key] at the app's server",
    );
    expect(error.hint).toBe("Run `opscrew cloudflare move` again.");
  });

  it("says when rclone ran out of time", async () => {
    const { remote } = fakeRemote(() => ({
      exitCode: 124,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    const error = await caught(
      sshRclone(new Redactor(), remote, "your server")(copyRun(r2Remote("a", ACCOUNT, key("t")))),
    );
    expect(error.message).toBe(
      "Copying the bucket shop-uploads failed on your server: it did not finish within 1 minute",
    );
  });
});

/**
 * A fake Docker host whose archive writes are kept (FakeDocker drops those outside a mount), each
 * with the container it went into, and whose rclone containers answer with `answer`.
 */
function rcloneDocker(answer: (cmd: readonly string[]) => { exitCode: number; stderr?: string }) {
  const fake = new FakeDocker();
  const archives: { container: string; files: { name: string; mode: number; data: string }[] }[] =
    [];
  fake.onStart = (container) =>
    container.image === IMAGES.rclone.ref ? answer(container.cmd) : undefined;
  const transport: DockerTransport = {
    async request(request) {
      const put = /^\/containers\/([^/]+)\/archive/.exec(request.path);
      if (request.method === "PUT" && put !== null && request.body instanceof Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        archives.push({
          container: put[1] ?? "",
          files: parseTar(body).map((entry) => ({
            name: entry.name,
            mode: entry.mode,
            data: entry.data?.toString("utf8") ?? "",
          })),
        });
        return fake.request({ ...request, body: Readable.from([body]) });
      }
      return fake.request(request);
    },
  };
  return { fake, archives, docker: dockerClient(transport) };
}

describe("dockerRclone", () => {
  it("writes the configuration through the archive API, never in the container's Env or Cmd, and removes the container", async () => {
    const k = key("docker");
    const seen: { env: string[]; cmd: string[] }[] = [];
    const { fake, archives, docker } = rcloneDocker(() => ({ exitCode: 0 }));
    const inner = fake.onStart;
    fake.onStart = (container) => {
      seen.push({ env: container.env, cmd: container.cmd });
      return inner?.(container);
    };
    await dockerRclone(redactorOf(k), docker, "your Portainer")(copyRun(r2Remote("b", ACCOUNT, k)));
    expect(seen).toEqual([
      {
        env: [],
        cmd: [
          "--config",
          "/tmp/r.conf",
          "copy",
          "a:shop-uploads",
          "b:shop-uploads",
          "--checksum",
          "--metadata",
        ],
      },
    ]);
    expect(archives).toHaveLength(1);
    const [file] = archives[0]?.files ?? [];
    expect(file?.name).toBe("tmp/r.conf");
    expect(file?.mode).toBe(0o600);
    expect(file?.data).toContain(`secret_access_key = ${k.secretAccessKey}`);
    expect(fake.containers.size).toBe(0);
    // The archive went in before the container started.
    const put = fake.calls.findIndex((call) => /^PUT \/containers\/[^/]+\/archive/.test(call));
    const start = fake.calls.findIndex((call) => /^POST \/containers\/[^/]+\/start/.test(call));
    expect(put).toBeGreaterThan(-1);
    expect(put).toBeLessThan(start);
  });

  it("stops with rclone's last words, redacted", async () => {
    const k = key("docker-fail");
    const { docker, fake } = rcloneDocker(() => ({
      exitCode: 1,
      stderr: `Failed to copy: AccessDenied for ${k.accessKeyId}`,
    }));
    const error = await caught(
      dockerRclone(redactorOf(k), docker, "your Portainer")(copyRun(r2Remote("a", ACCOUNT, k))),
    );
    expect(error.message).toBe(
      "Copying the bucket shop-uploads failed on your Portainer: Failed to copy: AccessDenied for [REDACTED:storage-key]",
    );
    expect(fake.containers.size).toBe(0);
  });

  it("says plainly that a container left behind holds the keys", async () => {
    const k = key("left");
    const { docker, fake } = rcloneDocker(() => ({ exitCode: 0 }));
    fake.fail("PUT", /\/archive/, 500, "disk full");
    fake.fail("DELETE", /^\/containers\//, 500, "busy");
    const error = await caught(
      dockerRclone(redactorOf(k), docker, "your Portainer")(copyRun(r2Remote("a", ACCOUNT, k))),
    );
    expect(error.message).toContain("Copying the bucket shop-uploads failed on your Portainer:");
    expect(error.message).toContain("which holds the buckets' keys.");
    expect(error.hint).toMatch(/^Remove it on the Docker host with `docker rm -f [0-9a-f]{12}`\. /);
  });
});

describe("rcloneSize", () => {
  it("reads rclone's size and count", async () => {
    const { remote, runs } = fakeRemote(() => ok('{"count":3,"bytes":33,"sizeless":0}'));
    const size = await rcloneSize(sshRclone(new Redactor(), remote, "your server"), {
      path: "a:shop-uploads",
      bucket: "shop-uploads",
      command: "opscrew cloudflare move",
      config: [],
      timeoutMs: 1000,
      what: "Measuring the bucket shop-uploads",
      hint: "",
    });
    expect(size).toEqual({ bytes: 33, count: 3 });
    expect(runs[0]?.command).toContain(
      "exec rclone --config /tmp/r.conf size --json a:shop-uploads'",
    );
  });

  it("stops when rclone says something else", async () => {
    const { remote } = fakeRemote(() => ok("not json"));
    const error = await caught(
      rcloneSize(sshRclone(new Redactor(), remote, "your server"), {
        path: "a:shop-uploads",
        bucket: "shop-uploads",
        command: "opscrew cloudflare move",
        config: [],
        timeoutMs: 1000,
        what: "Measuring the bucket shop-uploads",
        hint: "",
      }),
    );
    expect(error.message).toBe(
      "rclone did not say the size of the bucket shop-uploads. Nothing was changed.",
    );
    expect(error.hint).toBe("Run `opscrew cloudflare move` again.");
  });
});

import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProjectPaths, sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { ensureCheckKey, ensureReportKey, readReportKey } from "./key";

describe("ensureCheckKey", () => {
  it("generates the Ed25519 key once, at the first app's prod path, whatever environment runs", async () => {
    const staging = await createTestPhaseDeps({ environment: "staging" });
    const first = await ensureCheckKey(staging.paths, staging.redactor);
    const file = resolveProjectPaths(staging.paths.root, { env: staging.env }).files.checkKey;
    expect(file).not.toBe(staging.paths.files.checkKey);
    expect(first.created).toBe(true);
    expect(first.publicKeyOpenSsh).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{48}$/);
    expect(first.privateKeyOpenSsh).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/,
    );
    await expect(readFile(file, "utf8")).resolves.toBe(first.privateKeyOpenSsh);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    // prod reuses it; its private half is masked.
    const prod = await createTestPhaseDeps({ root: staging.paths.root, env: staging.env });
    const again = await ensureCheckKey(prod.paths, prod.redactor);
    expect(again).toEqual({ ...first, created: false });
    const line = first.privateKeyOpenSsh.split("\n")[1] as string;
    expect(prod.redactor.redact(`key: ${first.privateKeyOpenSsh}`)).not.toContain(line);
  });

  it("stops on a damaged key instead of making a new one", async () => {
    const deps = await createTestPhaseDeps();
    await ensureCheckKey(deps.paths, deps.redactor);
    await writeFile(deps.paths.files.checkKey, "not a key\n");
    await expect(ensureCheckKey(deps.paths, deps.redactor)).rejects.toThrow(
      /The scheduled check's key .* is damaged/,
    );
    await expect(readFile(deps.paths.files.checkKey, "utf8")).resolves.toBe("not a key\n");
  });
});

describe("ensureReportKey", () => {
  /** Randomness that records the sizes asked and gives `byte` repeated. */
  function random(byte: number) {
    const sizes: number[] = [];
    const next = (size: number) => {
      sizes.push(size);
      return Buffer.alloc(size, byte);
    };
    return { sizes, next };
  }
  const fileOf = (deps: { paths: { projectHomeDir: string } }) =>
    join(deps.paths.projectHomeDir, "uptime_report_key");

  it("makes 32 bytes once per environment, keeps them in OpsCrew's home and gives them again", async () => {
    const deps = await createTestPhaseDeps();
    const bytes = random(0xab);
    const first = await ensureReportKey(deps.paths, deps.redactor, bytes.next);
    const value = "ab".repeat(32);
    expect(bytes.sizes).toEqual([32]);
    expect(first).toEqual({ value, sha256: sha256Hex(value), created: true });
    await expect(readFile(fileOf(deps), "utf8")).resolves.toBe(`${value}\n`);
    if (process.platform !== "win32") expect((await stat(fileOf(deps))).mode & 0o777).toBe(0o600);

    // The next run gives the same key, with no randomness; it is masked.
    const later = random(0xcd);
    const again = await ensureReportKey(deps.paths, deps.redactor, later.next);
    expect(again).toEqual({ ...first, created: false });
    expect(later.sizes).toEqual([]);
    expect(await readReportKey(deps.paths, deps.redactor)).toEqual(again);
    expect(deps.redactor.redact(`key ${value}`)).not.toContain(value);

    // Another environment has its own.
    const staging = await createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      environment: "staging",
    });
    expect(await readReportKey(staging.paths, staging.redactor)).toBeUndefined();
    const own = await ensureReportKey(staging.paths, staging.redactor, random(0x01).next);
    expect(own.value).toBe("01".repeat(32));
  });

  it("gives a new key when its file was lost", async () => {
    const deps = await createTestPhaseDeps();
    await ensureReportKey(deps.paths, deps.redactor, random(0xab).next);
    await rm(fileOf(deps));
    expect(await readReportKey(deps.paths, deps.redactor)).toBeUndefined();
    const fresh = await ensureReportKey(deps.paths, deps.redactor, random(0x11).next);
    expect(fresh).toMatchObject({ value: "11".repeat(32), created: true });
  });

  it("stops on a damaged key instead of making a new one", async () => {
    const deps = await createTestPhaseDeps();
    await ensureReportKey(deps.paths, deps.redactor, random(0xab).next);
    await writeFile(fileOf(deps), "not a key\n");
    await expect(ensureReportKey(deps.paths, deps.redactor)).rejects.toThrow(
      /The uptime report key .* is damaged/,
    );
    await expect(readFile(fileOf(deps), "utf8")).resolves.toBe("not a key\n");
  });
});

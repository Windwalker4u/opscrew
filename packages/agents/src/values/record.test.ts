import { readFile, stat, writeFile } from "node:fs/promises";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { appEnvText } from "../shared/app-env";
import { createTestPhaseDeps } from "../testing/deps";
import { appValuesFile, readAppValues, recordAppEnvText, writeAppValues } from "./record";

const KEY = fakeSecret("stripe-live-key", "record");
const PEM = fakeSecret("private-key-pem", "record-pem");

describe("the record of the app's values (048)", () => {
  it("is written owner-only in the project's home and read back", async () => {
    const deps = await createTestPhaseDeps();
    await writeAppValues(deps, { app: { STRIPE_SECRET_KEY: KEY }, build: { VITE_A: "a" } });
    expect(await readAppValues(deps)).toEqual({
      app: { STRIPE_SECRET_KEY: KEY },
      build: { VITE_A: "a" },
    });
    if (process.platform !== "win32") {
      expect((await stat(appValuesFile(deps))).mode & 0o777).toBe(0o600);
    }
  });

  it("reads as none when missing or damaged", async () => {
    const deps = await createTestPhaseDeps();
    expect(await readAppValues(deps)).toBeUndefined();
    await writeAppValues(deps, { app: {}, build: {} });
    await writeFile(appValuesFile(deps), "{not json");
    expect(await readAppValues(deps)).toBeUndefined();
  });

  it("takes the app's values from an env text another flow stored, keeping the build values", async () => {
    const deps = await createTestPhaseDeps();
    await writeAppValues(deps, { app: { OLD: "x" }, build: { VITE_A: "a" } });
    await recordAppEnvText(deps, appEnvText({ STRIPE_SECRET_KEY: KEY, TLS_KEY: PEM }));
    expect(await readAppValues(deps)).toEqual({
      app: { STRIPE_SECRET_KEY: KEY, TLS_KEY: PEM },
      build: { VITE_A: "a" },
    });
  });

  it("writes no record from an env text when there is none", async () => {
    const deps = await createTestPhaseDeps();
    await recordAppEnvText(deps, appEnvText({ STRIPE_SECRET_KEY: KEY }));
    await expect(readFile(appValuesFile(deps), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

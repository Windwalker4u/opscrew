import { stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./temp-dir";

describe("tempDir", () => {
  let made = "";

  it("creates a folder with the prefix in the temp folder", async () => {
    made = await tempDir("opscrew-temp-dir-");
    expect(dirname(made)).toBe(tmpdir());
    expect(basename(made).startsWith("opscrew-temp-dir-")).toBe(true);
    await writeFile(join(made, "file.txt"), "kept until the test ends");
    expect((await stat(made)).isDirectory()).toBe(true);
  });

  it("removes it, with what it holds, after the test", async () => {
    await expect(stat(made)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

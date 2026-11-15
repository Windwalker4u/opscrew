import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moveFolder } from "./paths";

describe("moveFolder", () => {
  it("names the environment's move folder, and the paths in it", () => {
    const stateDir = join("repo", ".opscrew", "environments", "staging");
    expect(moveFolder({ stateDir })).toBe(join(stateDir, "cloudflare-move"));
    expect(moveFolder({ stateDir }, "a-removal", "cloudflare.json")).toBe(
      join(stateDir, "cloudflare-move", "a-removal", "cloudflare.json"),
    );
  });
});

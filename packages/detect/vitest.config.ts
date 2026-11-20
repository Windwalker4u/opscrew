import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // Detection reads real fixture trees from disk; Vitest's 5 s default timed out under load.
    testTimeout: 30_000,
  },
});

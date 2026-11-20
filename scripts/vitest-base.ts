import { fileURLToPath } from "node:url";
import type { ViteUserConfig } from "vitest/config";

/**
 * Test options every package's `vitest.config.ts` spreads into its `test` block: one temporary
 * folder per run, removed afterwards (see `scripts/vitest-global-setup.ts`), and outside CI at
 * most half the machine's CPUs per package. Locally several packages' suites run at once, and
 * often other checkouts' too; with Vitest's default (every CPU but one, per package) tests timed
 * out well past their generous limits (2026-11-20: 91% CPU on 12, a different set each run). A CI
 * runner runs one job, so it keeps the default.
 */
export const sharedTestOptions = {
  globalSetup: [fileURLToPath(new URL("./vitest-global-setup.ts", import.meta.url))],
  ...(process.env.CI ? {} : { maxWorkers: "50%" }),
} satisfies NonNullable<ViteUserConfig["test"]>;

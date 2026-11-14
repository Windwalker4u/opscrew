import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFixture } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import type { ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import { addApp } from "../apps";
import { createTestPhaseDeps } from "../testing";
import { runInterview } from "./run";

// Detection as it is, watched: the facts the interview's fallback detected.
vi.mock("@opscrew/detect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opscrew/detect")>();
  return { ...actual, detectProject: vi.fn(actual.detectProject) };
});

/** The detect fixture of the 0.2.8 report, with the Vite app `apps/pay`. */
const THREE_APPS = fileURLToPath(
  new URL("../../../detect/test/fixtures/monorepo-three-apps/", import.meta.url),
);

describe("the interview of a further app without its analysis", () => {
  it("detects the app's own folder only", async () => {
    const root = await mkdtemp(join(tmpdir(), "opscrew-interview-further-"));
    await materializeFixture(THREE_APPS, root);
    await addApp(root, "pay", "apps/pay");
    const deps = await createTestPhaseDeps({ root, app: "pay" });
    vi.mocked(detectProject).mockClear();
    await runInterview(deps, {
      answers: {
        provider: "cloudflare-workers",
        expectedMonthlyUsers: "<1k",
        budgetMonthly: { amount: 10, currency: "EUR" },
        uptime: "standard",
        dataCriticality: "none",
        domain: "pay.example.com",
        dnsProvider: "cloudflare",
      },
    });
    expect(vi.mocked(detectProject).mock.calls).toEqual([
      [root, { appDir: "apps/pay", rootFiles: false }],
    ]);
    const facts = (await vi.mocked(detectProject).mock.results[0]?.value) as ProjectFacts;
    expect(facts.envVars.map((variable) => variable.name)).toEqual([
      "VITE_BASE_PATH",
      "VITE_CHECKOUT_URL",
      "VITE_SHOP_ID",
    ]);
    expect(facts.services).toEqual([]);
  });
});

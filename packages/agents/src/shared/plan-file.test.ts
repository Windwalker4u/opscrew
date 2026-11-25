import type { RenderedFile } from "@opscrew/iac-templates";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { generatedByNote } from "../drift/infra";
import { createTestPhaseDeps, testPlan } from "../testing";
import { approveAndWriteRenderedFiles } from "./files";
import { writePlanIfChanged } from "./plan-file";

const FILE: RenderedFile = {
  path: "opscrew/runtime/compose.yaml",
  content: "a\n",
  kind: "runtime",
};

describe("deployment.generatedBy", () => {
  it("records the OpsCrew version that wrote the generated files, and keeps it through later writes", async () => {
    const deps = await createTestPhaseDeps({ version: "0.2.12-dev.abc1234" });
    const plan = testPlan();
    await writePlanIfChanged(deps, plan);

    await approveAndWriteRenderedFiles(deps, deps.paths.root, [FILE]);
    const read = () => readArtifact("plan", deps.paths.files.plan);
    expect((await read()).deployment.generatedBy).toBe("0.2.12-dev.abc1234");

    // A phase holding the plan it read before keeps the record when it writes it.
    await writePlanIfChanged(deps, {
      ...plan,
      deployment: { ...plan.deployment, lastApplyAt: "2026-11-25T08:00:00.000Z" },
    });
    expect((await read()).deployment).toMatchObject({
      generatedBy: "0.2.12-dev.abc1234",
      lastApplyAt: "2026-11-25T08:00:00.000Z",
    });

    // Nothing written, nothing recorded: the files are already as rendered.
    const later = await createTestPhaseDeps({ root: deps.paths.root, version: "0.2.13" });
    await approveAndWriteRenderedFiles(later, later.paths.root, [FILE]);
    expect((await read()).deployment.generatedBy).toBe("0.2.12-dev.abc1234");
  });

  it("moves forward after an upgrade, though the phase still holds the plan it read before", async () => {
    const deps = await createTestPhaseDeps({ version: "0.2.12" });
    const base = testPlan();
    const held = { ...base, deployment: { ...base.deployment, generatedBy: "0.2.11" } };
    await writePlanIfChanged(deps, held);

    await approveAndWriteRenderedFiles(deps, deps.paths.root, [FILE]);
    // The phase writes the copy it read before the files, which names 0.2.11.
    await writePlanIfChanged(deps, {
      ...held,
      deployment: { ...held.deployment, lastApplyAt: "2026-11-25T08:00:00.000Z" },
    });
    expect((await readArtifact("plan", deps.paths.files.plan)).deployment).toMatchObject({
      generatedBy: "0.2.12",
      lastApplyAt: "2026-11-25T08:00:00.000Z",
    });
  });

  it("is a note in drift's report, saying when it was a build between releases", () => {
    expect(generatedByNote(undefined)).toBeUndefined();
    expect(generatedByNote("0.2.12")).toBe(
      "The generated files were last written by OpsCrew 0.2.12.",
    );
    expect(generatedByNote("0.2.12-dev.abc1234")).toBe(
      "The generated files were last written by OpsCrew 0.2.12-dev.abc1234, a development build between two releases.",
    );
  });
});

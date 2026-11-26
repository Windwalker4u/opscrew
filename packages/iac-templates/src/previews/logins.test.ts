import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withPooler } from "../catalog/__fixtures__/plans";
import { withProcesses } from "../workflow/__fixtures__/plans";
import { envFor, IMAGE_NAME, previewPlan, REPOSITORY } from "./__fixtures__/plans";
import { previewSecret, previewTemplatePlan, renderPreviewRecipe } from "./index";

const DIR = "opscrew/environments/preview/previews";

/** The preview environment's plan with its PostgreSQL's own logins (047). */
function withLogins(plan: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    services: plan.services.map((s) =>
      s.kind === "postgres" ? { ...s, options: { logins: "separate" } } : s,
    ),
  });
}

describe("a preview's release with PostgreSQL's two logins (047)", () => {
  it("gets its release.db.env from the env templates, which its release reads after app.env", () => {
    const plan = withLogins(previewPlan());
    const release = `DATABASE_URL=postgresql://app_owner:${previewSecret("db-owner-password", "hex32")}@db:5432/app\n`;
    const files = renderPreviewRecipe(plan, {
      repository: REPOSITORY,
      imageName: IMAGE_NAME,
      env: { ...envFor(previewTemplatePlan(plan)), release },
    });
    const byPath = Object.fromEntries(
      files.map((file) => [file.path.slice(DIR.length + 1), file.content]),
    );
    expect(byPath["template/env/release.db.env"]).toBe(release);
    const compose = parse(byPath["template/compose.yaml"] as string);
    expect(compose.services.release.env_file).toEqual(["app.env", "release.db.env"]);
  });

  it("refuses a release template with a placeholder the server can't fill", () => {
    const plan = withLogins(previewPlan());
    expect(() =>
      renderPreviewRecipe(plan, {
        repository: REPOSITORY,
        imageName: IMAGE_NAME,
        env: { ...envFor(previewTemplatePlan(plan)), release: "DATABASE_URL=@SECRET:bad@\n" },
      }),
    ).toThrow("The preview env template release.db.env holds an @SECRET: placeholder");
  });
});

describe("a preview's workers beside PostgreSQL's pooler (050)", () => {
  it("get their worker.db.env from the env templates, which they read after app.env", () => {
    const plan = withProcesses(withPooler(previewPlan()), {
      workers: [{ name: "jobs", command: "php artisan queue:work" }],
    });
    const workers = `DATABASE_URL=postgresql://app_runtime:${previewSecret("db-runtime-password", "hex32")}@db:5432/app\n`;
    const files = renderPreviewRecipe(plan, {
      repository: REPOSITORY,
      imageName: IMAGE_NAME,
      env: { ...envFor(previewTemplatePlan(plan)), workers },
    });
    const byPath = Object.fromEntries(
      files.map((file) => [file.path.slice(DIR.length + 1), file.content]),
    );
    expect(byPath["template/env/worker.db.env"]).toBe(workers);
    const compose = parse(byPath["template/compose.yaml"] as string);
    expect(compose.services.jobs.env_file).toEqual(["app.env", "worker.db.env"]);
    expect(compose.services.app.env_file).toEqual(["app.env"]);
  });
});

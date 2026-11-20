/** Offline checks of the Docker pass's build helpers (`builders.ts`). */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ownPlan } from "@opscrew/agents/testing";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { removeSecretFiles, workflowBuild } from "./builders";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("removeSecretFiles", () => {
  it("removes the secret files .dockerignore lists, keeping .env.example, node_modules and .git", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opscrew-secret-files-"));
    temps.push(dir);
    const files = [
      ".env",
      ".env.local",
      ".env.example",
      "api/.env",
      "api/.env.example",
      "certs/server.pem",
      "certs/server.key",
      "src/main.go",
      "src/environment.go",
      "node_modules/pkg/.env",
      ".git/.env",
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), "x\n");
    }
    expect(await removeSecretFiles(dir)).toEqual([
      ".env",
      ".env.local",
      "api/.env",
      "certs/server.key",
      "certs/server.pem",
    ]);
    const left = files.filter((file) => existsSync(path.join(dir, file)));
    expect(left).toEqual([
      ".env.example",
      "api/.env.example",
      "src/main.go",
      "src/environment.go",
      "node_modules/pkg/.env",
      ".git/.env",
    ]);
  });
});

describe("workflowBuild", () => {
  it("hands Railpack a PHP app's extensions as one literal setting, in the prepare step and the secrets", () => {
    const plan = ownPlan();
    const build = workflowBuild(
      DeployPlanSchema.parse({
        ...plan,
        app: {
          ...plan.app,
          build: {
            builder: "railpack",
            chosen: "auto",
            reason: "A Laravel app: Railpack builds it.",
            runtime: { language: "php", version: "8.5" },
            probe: "php",
            phpExtensions: ["pcntl", "sockets"],
          },
        },
      }),
    );
    if (build.builder !== "railpack") throw new Error("Expected a Railpack build.");
    // The plan's list: the two every PHP image gets, Postgres's driver and the packages' two.
    const setting = "RAILPACK_PHP_EXTENSIONS=intl,pcntl,pdo_pgsql,sockets,zip";
    expect(build.prepareEnv).toContain(setting);
    expect(build.secrets).toContain(setting);
    // execFile passes each word as it is: no shell is there to expand or unquote one.
    expect([...build.prepareEnv, ...build.secrets].filter((word) => /[$"']/.test(word))).toEqual(
      [],
    );
  });
});

// A deploy on this computer that finds the app held by a credential rotation (025, T2507).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runProvision } from "../provision";
import { keepPendingRotation, pendingRotationFile } from "../rotate/values-pending";
import { FakeComputer, localPlan, localProject } from "./__fixtures__/computer";
import { heldByRotation } from "./apply";
import { appFolder } from "./services";

const HASH = "c".repeat(64);
const HELD = "OpsCrew changed nothing on the server: a credential rotation holds the app";

describe("applyLocal's build on this computer", () => {
  it("passes a variable marked as a build argument with --build-arg, as a client-exposed one", async () => {
    const computer = new FakeComputer();
    const base = localPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      app: {
        ...base.app,
        env: [
          ...base.app.env,
          { name: "NEXT_PUBLIC_SITE", secret: false, source: "user" },
          { name: "PLUGINS", secret: false, source: "user", buildArg: true },
        ],
      },
    });
    const { deps, root } = await localProject(plan, computer);
    await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
    await writeFile(
      join(root, "production.env"),
      "NEXT_PUBLIC_SITE=https://shop.example.com\nPLUGINS=alpha@1a2b3c4,beta@5d6e7f8\n",
    );
    deps.env.OPSCREW_APP_ENV_FILE = "production.env";
    await runProvision(deps, { services: { localhost: computer.services() } });
    const build = computer.scripts.find((s) => s.script.includes("docker build"))?.script ?? "";
    expect(build).toContain("--build-arg 'NEXT_PUBLIC_SITE=https://shop.example.com'");
    expect(build).toContain("--build-arg 'PLUGINS=alpha@1a2b3c4,beta@5d6e7f8'");
    expect(build).not.toContain("--secret");
    const appEnv = await readFile(join(appFolder(deps.paths, plan), "app.env"), "utf8");
    expect(appEnv).not.toContain("PLUGINS");
  });
});

describe("applyLocal while a credential rotation holds the app", () => {
  it("says so with the rotation's hash, never that it could not put a version back", async () => {
    const computer = new FakeComputer();
    computer.script = (script) =>
      script.includes("no-previous")
        ? { exitCode: 0, stdout: `held rotation ${HASH}\n`, stderr: "" }
        : script.includes("docker build")
          ? { exitCode: 0, stdout: "opscrew-local/shop:0123456789ab\n", stderr: "" }
          : script.includes("echo started >")
            ? { exitCode: 1, stdout: "", stderr: `::error::${HELD}\n` }
            : { exitCode: 0, stdout: "", stderr: "" };
    const { deps, root } = await localProject(localPlan(), computer);
    await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
    const failed = (await runProvision(deps, {
      services: { localhost: computer.services() },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )) as { message: string } | undefined;
    expect(failed?.message).toContain(HELD);
    expect(failed?.message).toContain(
      `A credential rotation holds the app here (the rotation of the plan ${HASH}), so OpsCrew changed nothing`,
    );
    // This computer has no pending rotation of it: the command without its credentials.
    expect(failed?.message).toContain(
      "finish it with `opscrew rotate` and the credentials it rotates",
    );
    expect(failed?.message).not.toContain("could not put the previous version back");
  });

  it("names the rotation's credentials when this computer has its values, and not when their file is damaged", async () => {
    const { deps } = await localProject(localPlan());
    const back = `held rotation ${HASH}`;
    await keepPendingRotation(deps, {
      target: "localhost",
      names: ["db", "cache"],
      services: {},
      hash: HASH,
      step: "started",
      done: 2,
    });
    const named = await heldByRotation(deps, back);
    expect(named).toContain("finish it with `opscrew rotate db cache`");
    expect(named).toContain("`opscrew rotate db cache --undo`");
    expect(await heldByRotation(deps, "held")).toBeUndefined();

    const file = pendingRotationFile(deps);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{ not json");
    expect(await heldByRotation(deps, back)).toContain(
      "finish it with `opscrew rotate` and the credentials it rotates",
    );
  });
});

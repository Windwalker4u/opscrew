/**
 * `snapshot.sh drill` on Docker (029 plan.md 19., research R15–R17, R29), on this computer's
 * layout: a stand-in app (busybox's httpd, with the plan's own `wget` health check) beside the
 * pinned PostgreSQL, a snapshot taken by the real `snapshot.sh`, then:
 * - a drill restores it into `<app>-drill`, the app becomes healthy, the copy holds as many tables
 *   as production, and the copy is removed;
 * - a drill with `--keep` leaves the copy running, whose app reaches no outside name, and
 *   `drill --remove` then leaves nothing of `<app>-drill`;
 * - production's containers, volume and rows are as they were.
 * It builds the stand-in and pulls the pinned images, so it runs only with OPSCREW_DOCKER_TESTS=1.
 * It removes its project, its volumes and the images it built or pulled, never anything else.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { docker, hasImage } from "../__fixtures__/docker";
import { testPlan } from "../__fixtures__/plans";
import { serviceSpec } from "../catalog";
import { DRILL_APPROVAL_FILE, drillApprovalLine, drillRecord, renderDrill } from "../drill";
import { onThisComputer } from "../edge/__fixtures__/localhost";
import { IMAGES } from "../pins";
import { previewSecret } from "../previews";
import { renderCompose } from "../runtime";
import { withBuild } from "./__fixtures__/plans";
import { skipReason } from "./__fixtures__/sh";
import { snapshotScript } from "./snapshot-script";
import { databaseCount, snapshotParts } from "./snapshots";

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the restore drill on Docker: ${reason}`);

const RUN = randomBytes(3).toString("hex");
const APP = `drill${RUN}`;
const DRILL = `${APP}-drill`;
const PROJECT = `opscrew-${APP}`;

/** `APP` on this computer with PostgreSQL `db`, its health check busybox's `wget`. */
function drillTestPlan(): DeployPlan {
  const built = withBuild(onThisComputer(testPlan()), "railpack", {
    language: "node",
    version: "22",
  });
  return DeployPlanSchema.parse({
    ...built,
    app: {
      ...built.app,
      name: APP,
      build: { ...built.app.build, probe: "wget" },
    },
  });
}

/** A value as one line of an env file. */
const line = ([name, value]: [string, string]) => `${name}=${value}\n`;

/** The images and folder this test made or pulled, removed at the end. */
const made: string[] = [];
let root: string | undefined;

/** Every object of the Compose project `project`, by its label. */
function objects(project: string): string[] {
  const label = `label=com.docker.compose.project=${project}`;
  return [
    docker(["ps", "-aq", "--filter", label]),
    docker(["volume", "ls", "-q", "--filter", label]),
    docker(["network", "ls", "-q", "--filter", label]),
  ]
    .join("\n")
    .split("\n")
    .filter(Boolean);
}

afterAll(() => {
  for (const project of [DRILL, PROJECT]) {
    for (const [kind, list] of [
      ["rm", ["ps", "-aq"]],
      ["volume", ["volume", "ls", "-q"]],
      ["network", ["network", "ls", "-q"]],
    ] as const) {
      const ids = spawnSync(
        "docker",
        [...list, "--filter", `label=com.docker.compose.project=${project}`],
        { encoding: "utf8" },
      )
        .stdout.split("\n")
        .filter(Boolean);
      if (ids.length === 0) continue;
      const remove = kind === "rm" ? ["rm", "-f"] : [kind, "rm"];
      spawnSync("docker", [...remove, ...ids], { encoding: "utf8" });
    }
  }
  for (const ref of made) spawnSync("docker", ["image", "rm", ref], { encoding: "utf8" });
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(reason !== undefined)("snapshot.sh drill on Docker", { timeout: 1_800_000 }, () => {
  it("restores into <app>-drill, healthy with production's tables and no internet, then leaves nothing of it", () => {
    const plan = drillTestPlan();
    const postgres = IMAGES.postgres.ref;
    if (!hasImage(postgres)) made.push(postgres);
    root = mkdtempSync(join(tmpdir(), "opscrew-drill-docker-")).replaceAll("\\", "/");
    const apps = `${root}/apps`;
    const dir = `${apps}/${APP}`;
    const env = {
      ...process.env,
      MSYS_NO_PATHCONV: "1",
      MSYS2_ARG_CONV_EXCL: "*",
      OPSCREW_APPS_DIR: apps,
      OPSCREW_EDGE_DIR: `${root}/edge`,
    };

    // The stand-in app: busybox's httpd answering the plan's health route on its port.
    const context = `${root}/image`;
    mkdirSync(context, { recursive: true });
    writeFileSync(
      join(context, "Dockerfile"),
      [
        `FROM ${IMAGES.busybox.ref}`,
        `RUN mkdir -p /www${plan.app.healthPath.replace(/\/[^/]*$/, "")} && echo ok > /www${plan.app.healthPath}`,
        `CMD ["httpd", "-f", "-p", "${plan.app.port}", "-h", "/www"]`,
        "",
      ].join("\n"),
    );
    const build = `opscrew-drill-test:${RUN}`;
    docker(["build", "-q", "-t", build, context], { env });
    made.push(build);
    const id = docker(["image", "inspect", "--format", "{{.Id}}", build]).replace(/^sha256:/, "");
    // The local deploy's tag: opscrew-local/<app>:<first 12 digits of the image ID>.
    const image = `opscrew-local/${APP}:${id.slice(0, 12)}`;
    docker(["tag", build, image]);
    made.unshift(image);

    // Production: the app and PostgreSQL as this computer renders them, with rows.
    const rendered = parse(renderCompose(plan).content);
    const db = rendered.services.db;
    const service = plan.services.find((each) => each.name === "db");
    if (service === undefined) throw new Error("the plan has no db");
    const password = randomBytes(16).toString("hex");
    const values = serviceSpec("postgres").environment({
      plan,
      service,
      secretRef: () => password,
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compose.yaml"),
      stringify({
        name: PROJECT,
        services: {
          app: {
            image,
            environment: { PORT: String(plan.app.port) },
            healthcheck: rendered.services.app.healthcheck,
            networks: ["internal"],
          },
          db: { ...db, networks: ["internal"] },
        },
        networks: { internal: {} },
        volumes: rendered.volumes,
      }),
    );
    writeFileSync(join(dir, "db.env"), Object.entries(values).map(line).join(""));
    writeFileSync(join(dir, ".env"), `APP_IMAGE=${image}\n`);
    writeFileSync(join(dir, "snapshot.sh"), `${snapshotScript(plan).join("\n")}\n`);
    const compose = (args: string[]) => docker(["compose", ...args], { cwd: dir, env });
    compose(["up", "-d", "--wait"]);
    const psql = (sql: string) =>
      compose(["exec", "-T", "db", "psql", "-X", "-q", "-At", "-U", "app", "-d", "app", "-c", sql]);
    psql(
      "CREATE TABLE orders (id int); INSERT INTO orders SELECT generate_series(1, 50); CREATE TABLE users (name text); INSERT INTO users VALUES ('a'), ('b')",
    );
    const part = snapshotParts(plan).find((each) => each.name === "db");
    const count = databaseCount(part as NonNullable<typeof part>) ?? "";
    const tables = Number(compose(["exec", "-T", "db", "sh", "-c", count]));
    expect(tables).toBe(2);
    const before = {
      containers: compose(["ps", "-q"]).split("\n").sort(),
      volumes: docker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${PROJECT}`,
      ]),
    };

    const snap = (args: string[], input = "") => {
      const result = spawnSync("sh", [`${dir}/snapshot.sh`, ...args], {
        cwd: dir,
        env,
        input,
        encoding: "utf8",
        timeout: 1_800_000,
      });
      const record = result.stdout
        .split("\n")
        .find((each) => each.startsWith("drill-record "))
        ?.slice("drill-record ".length);
      return {
        status: result.status,
        stdout: result.stdout,
        output: `${result.stdout}${result.stderr}`,
        record: record === undefined ? undefined : drillRecord(record),
      };
    };
    const taken = snap(["take", "manual"]);
    expect(taken.status, taken.output).toBe(0);
    const snapshot = taken.stdout.trim();

    // The copy's files, as opscrew restore --drill sends them: new passwords made on the machine.
    const templates = serviceSpec("postgres").environment({
      plan,
      service,
      secretRef: (name) => previewSecret(`db-${name}`, "hex32"),
    });
    const files = renderDrill(
      plan,
      { id: snapshot, parts: ["db"] },
      { image, env: { app: "", services: { db: Object.entries(templates).map(line).join("") } } },
    );
    const prefix = `.drill/${snapshot}/`;
    const input = [
      `image ${image}`,
      ...files.map(
        (file) =>
          `file ${file.path.slice(prefix.length)} ${Buffer.from(file.content).toString("base64")}`,
      ),
      "",
    ].join("\n");
    const approve = (action: "drill" | "keep" | "remove") =>
      writeFileSync(
        join(dir, DRILL_APPROVAL_FILE),
        `${drillApprovalLine({
          ...(action === "remove" ? {} : { id: snapshot }),
          action,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        })}\n`,
      );

    // 1. A drill: healthy, production's table count, and removed.
    approve("drill");
    const drilled = snap(["drill", snapshot], input);
    expect(drilled.status, drilled.output).toBe(0);
    expect(drilled.record).toMatchObject({
      result: "healthy",
      id: snapshot,
      tables: [{ service: "db", count: tables }],
      removal: "removed",
    });
    expect(drilled.record?.health?.state).toBe("healthy");
    expect(objects(DRILL)).toEqual([]);

    // 2. With --keep the copy runs on, with no way out; --remove then leaves nothing of it.
    approve("keep");
    const kept = snap(["drill", snapshot, "--keep"], input);
    expect(kept.record, kept.output).toMatchObject({ result: "healthy", removal: "kept" });
    const app = docker([
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${DRILL}`,
      "--filter",
      "label=com.docker.compose.service=app",
    ]);
    expect(app).not.toBe("");
    expect(docker(["network", "inspect", "--format", "{{.Internal}}", `${DRILL}_internal`])).toBe(
      "true",
    );
    const out = spawnSync(
      "docker",
      ["exec", app, "wget", "-T", "5", "-q", "-O", "/dev/null", "http://example.com"],
      { encoding: "utf8", env },
    );
    expect(out.status, `${out.stdout}${out.stderr}`).not.toBe(0);
    // The copy holds production's rows, under its own new password.
    const copied = docker(
      [
        "compose",
        "-p",
        DRILL,
        "-f",
        `${dir}/${prefix}compose.yaml`,
        "exec",
        "-T",
        "db",
        "psql",
        "-X",
        "-q",
        "-At",
        "-U",
        "app",
        "-d",
        "app",
        "-c",
        "SELECT count(*) FROM orders",
      ],
      { cwd: dir, env },
    );
    expect(copied).toBe("50");
    approve("remove");
    const removed = snap(["drill", "--remove"]);
    expect(removed.status, removed.output).toBe(0);
    expect(removed.stdout).toContain("drill-removal removed");
    expect(objects(DRILL)).toEqual([]);
    expect(docker(["ps", "-aq", "--filter", `name=${DRILL}`])).toBe("");
    expect(docker(["volume", "ls", "-q", "--filter", `name=${DRILL}`])).toBe("");

    // Production as it was: the same running containers, volume and rows.
    expect(compose(["ps", "-q"]).split("\n").sort()).toEqual(before.containers);
    expect(
      docker(["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`]),
    ).toBe(before.volumes);
    expect(psql("SELECT count(*) FROM orders")).toBe("50");
    compose(["down", "-v"]);
  });
});

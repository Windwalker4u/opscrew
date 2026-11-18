// Feature 029, restore drills by hand (T2933; plan.md 19., research R15–R19, R26, R27):
// `opscrew restore --drill` on servers and this computer.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DRILL_VALUES_FILE, IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FakeComputer, localPlan, localProject } from "../localhost/__fixtures__/computer";
import { appFolder } from "../localhost/services";
import { SERVER_IPV4, testPlan } from "../testing";
import { FakeSnapshotServer, SH_AVAILABLE } from "./__fixtures__/server";
import {
  everythingShown,
  RUNNING,
  type SnapshotWorld,
  snapshotWorld,
  stagingPlan,
} from "./__fixtures__/world";
import { drillSnapshot } from "./drill";

const ID = "20261118T120000Z";
const OLDER = "20261111T120000Z";
const OTHER = "b".repeat(64);
const NAME = "shop-staging-drill";

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

/** `shop` in staging on a Hetzner server with PostgreSQL `db` and the stop-only Kafka. */
function plan(): DeployPlan {
  return stagingPlan([
    { kind: "postgres", name: "db" },
    { kind: "kafka", name: "kafka" },
  ]);
}

const DB = { name: "db", kind: "postgres", file: "db.dump", size: 100, image: IMAGES.postgres.ref };
const KAFKA = {
  name: "kafka",
  kind: "kafka",
  file: "kafka.tar",
  size: 200,
  image: IMAGES.kafka.ref,
};

/** Stores the record of `id` on the app's server, taken `taken` while `version` ran. */
async function store(
  world: SnapshotWorld,
  o: { id?: string; taken?: string; version?: string; services?: object[] } = {},
): Promise<void> {
  const id = o.id ?? ID;
  const record = {
    id,
    kind: "scheduled",
    taken: o.taken ?? "2026-11-18T12:00:00Z",
    version: o.version ?? `sha256:${OTHER}`,
    services: o.services ?? [DB, KAFKA],
  };
  await world.servers.app?.write(`.snapshots/${id}/about.json`, `${JSON.stringify(record)}\n`);
}

/** The values of `.env.preview` and of prod's `.env` in the repository: never shown or sent. */
const PREVIEW = fakeSecret("stripe-live-key", "preview");
const PROD = fakeSecret("stripe-live-key", "prod");

async function values(world: SnapshotWorld): Promise<void> {
  await writeFile(join(world.deps.paths.root, ".env.preview"), `STRIPE_SECRET_KEY=${PREVIEW}\n`);
  await writeFile(join(world.deps.paths.root, ".env"), `STRIPE_SECRET_KEY=${PROD}\n`);
}

/** What the machine's drill got on stdin: its image and each file, decoded. */
async function sent(server: FakeSnapshotServer | undefined) {
  const text = (await server?.read("drill.in")) ?? "";
  const files: Record<string, string> = {};
  let image = "";
  for (const line of text.split("\n").filter(Boolean)) {
    const [word, a = "", b = ""] = line.split(" ");
    if (word === "image") image = a;
    if (word === "file") files[a] = Buffer.from(b, "base64").toString("utf8");
  }
  return { image, files };
}

/** The app's container runs {@link RUNNING} on the app's server, as Docker's labels find it. */
async function running(world: SnapshotWorld): Promise<void> {
  await world.servers.app?.write(
    "images/app",
    `ghcr.io/acme/shop@sha256:${RUNNING} sha256:${"c".repeat(64)}`,
  );
}

/** The `snapshot.sh` calls of the app's server. */
const calls = async (world: SnapshotWorld) => (await world.servers.app?.calls()) ?? [];

describe.skipIf(!SH_AVAILABLE)("opscrew restore --drill on a server", () => {
  it("drills the latest snapshot in <app>-drill after a destroy-grade approval of its plan, and says what it proves", async () => {
    const world = await snapshotWorld(plan());
    await values(world);
    await store(world, { id: OLDER, taken: "2026-11-11T12:00:00Z" });
    await store(world);
    const report = await drillSnapshot(world.deps, undefined, { services: world.services });

    expect(report).toMatchObject({
      id: ID,
      where: "on the app's server",
      outcome: "healthy",
      parts: [{ name: "db", size: 100, seconds: 12 }],
      health: { state: "healthy", seconds: 31 },
      tables: [{ service: "db", count: 42 }],
      removal: "removed",
      ownLogins: ["kafka"],
    });
    expect(report.summary).toBe(
      `The snapshot ${ID} restored, and the app became healthy on it in 31 seconds, with no internet and without your production .env.`,
    );
    expect(report.proves).toContain(`a throwaway ${NAME} Compose project on the server`);
    const [request] = world.handler.requests;
    expect(request).toMatchObject({
      kind: "remote-exec",
      title: `Run a restore drill of the snapshot ${ID} of staging on the app's server`,
      allowDestroy: true,
      confirmPhrase: NAME,
    });
    const details = request?.details ?? "";
    expect(request?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(details).toContain(`Drill hash: ${request?.planHash}`);
    for (const said of [
      `Snapshot: ${ID}, version sha256:bbbbbbbbbbbb: db (PostgreSQL) and kafka (Apache Kafka), read in place and read-only.`,
      `Project: ${NAME}, in /srv/apps/shop-staging/.drill/${ID}/ (compose.yaml, app.env, db.env, kafka.env and values.env).`,
      `It creates and removes: the project's containers and network, the volume ${NAME}_kafka_data, the volume ${NAME}_kafka_secrets, the volume ${NAME}_kafka_config and the folder /srv/data/${NAME}/db.`,
      "Network: one network with no internet (internal), no published port, no hostname, record or site;",
      `Image: ghcr.io/acme/shop@sha256:${OTHER}, the snapshot's version.`,
      "Health check: the app has none, so it must still run after 60 seconds; then db must answer and hold at least one table.",
      "The copy runs with no internet and without your production `.env`. The app may need some values to start; add them to `.env.preview` with test values.",
      "Values from .env.preview (names only): STRIPE_SECRET_KEY.",
      "kafka is restored from a copy of its files, which keeps production's logins, so the copy can't sign in to it.",
      `Typing ${NAME} approves it.`,
    ]) {
      expect(details).toContain(said);
    }
    expect(details).toMatch(/Memory: the app 512 MB, db \d+ MB and kafka \d+ MB \(\d+ MB in all\)/);

    // The read, then the drill of exactly that snapshot after its one-time approval.
    expect(await calls(world)).toEqual(["list", `drill ${ID}`]);
    const expiry = Math.floor(world.deps.clock.now().getTime() / 1000) + 1800;
    expect((await world.servers.app?.read("approval.drill"))?.trim()).toBe(
      `${ID} drill ${expiry} -`,
    );
    // The copy's files and the preview values came on stdin: no .env, no port, no internet.
    const { image, files } = await sent(world.servers.app);
    expect(image).toBe(`ghcr.io/acme/shop@sha256:${OTHER}`);
    expect(Object.keys(files).sort()).toEqual(
      ["app.env", "compose.yaml", "db.env", "kafka.env", DRILL_VALUES_FILE].sort(),
    );
    const compose = parse(files["compose.yaml"] ?? "");
    expect(compose.name).toBe(NAME);
    expect(compose.networks).toEqual({ internal: { internal: true } });
    expect(files["compose.yaml"]).not.toMatch(/^\s*ports:/m);
    expect(files["db.env"]).toMatch(/^POSTGRES_PASSWORD=@SECRET:db-password:hex32@$/m);
    expect(files[DRILL_VALUES_FILE]).toBe(`STRIPE_SECRET_KEY=${PREVIEW}\n`);
    expect(JSON.stringify(files)).not.toContain(PROD);
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "remote-exec",
        action: "run a restore drill",
        target: "server app",
        decision: "approved",
        detail: `${ID}: db, kafka: healthy`,
      }),
    );
    const text = world.deps.reporter.text();
    expect(text).toContain("Restored db (PostgreSQL), 100 bytes, in 12 seconds");
    expect(text).toContain("Db holds 42 tables");
    expect(text).toContain(`What it proves: ${report.proves}.`);
  });

  it("drills the id given, --only and --keep carried to the machine, each its own hash", async () => {
    const world = await snapshotWorld(plan());
    await store(world, { id: OLDER, taken: "2026-11-11T12:00:00Z" });
    await store(world);
    await drillSnapshot(world.deps, OLDER, { services: world.services });
    await drillSnapshot(world.deps, OLDER, { services: world.services, only: "db", keep: true });
    expect((await calls(world)).filter((call) => call.startsWith("drill"))).toEqual([
      `drill ${OLDER}`,
      `drill ${OLDER} --only db --keep`,
    ]);
    expect((await world.servers.app?.read("approval.drill"))?.trim()).toMatch(
      new RegExp(`^${OLDER} keep \\d+ db$`),
    );
    const [all, one] = world.handler.requests;
    expect(one?.planHash).not.toBe(all?.planHash);
    expect(one?.details).toContain(
      `Snapshot: ${OLDER}, version sha256:bbbbbbbbbbbb: db (PostgreSQL),`,
    );
    expect(one?.details).toContain(
      "with --keep they stay until `opscrew restore --drill --remove`",
    );
    expect(Object.keys((await sent(world.servers.app)).files)).not.toContain("kafka.env");
  });

  it("tells the three outcomes apart, a skip never a failure, and names a failed removal", async () => {
    const world = await snapshotWorld(plan());
    await store(world);
    const outcome = async (line: string) => {
      await world.servers.app?.write("drill.out", `drill-record ${line}\n`);
      await world.servers.app?.write("drill.exit", "2");
      return drillSnapshot(world.deps, ID, { services: world.services });
    };
    const start = `2026-11-18T14:06:10Z manual`;
    const bad = await outcome(
      `${start} not-restored id=${ID} version=bbbbbbbbbbbb start=2026-11-18T14:02:00Z parts=- health=- tables=- removal=removed cleaned=no reason=db`,
    );
    expect(bad.outcome).toBe("not-restored");
    expect(bad.summary).toBe(
      `The snapshot ${ID} did not restore: db did not restore. The backup is bad: take a new snapshot now with \`opscrew snapshot\`.`,
    );
    const sick = await outcome(
      `${start} unhealthy id=${ID} version=bbbbbbbbbbbb start=2026-11-18T14:02:00Z parts=db:100:12,kafka:200:4 health=unhealthy:300 tables=db:42 removal=failed cleaned=no reason=-`,
    );
    expect(sick.summary).toBe(
      `The snapshot ${ID} restored, but the app did not become healthy on it (still unhealthy after 300 seconds) with no internet and without your production values. The backup itself is fine: add the app's test values to .env.preview, or accept this result. kafka keeps production's logins in the copy, so the copy can't sign in to it.`,
    );
    expect(world.deps.reporter.text()).toContain(
      "OpsCrew could not remove every part of the copy on the app's server: run `opscrew restore --drill --remove`.",
    );
    const skipped = await outcome(
      `${start} skipped id=${ID} version=- start=2026-11-18T14:02:00Z parts=- health=- tables=- removal=- cleaned=no reason=locked`,
    );
    expect(skipped).toMatchObject({ outcome: "skipped", reason: "locked" });
    expect(skipped.summary).toContain(
      "The drill was skipped: a deploy, a snapshot or a restore was running.",
    );
    const gone = await outcome(
      `${start} failed id=${ID} version=bbbbbbbbbbbb start=2026-11-18T14:02:00Z parts=- health=- tables=- removal=removed cleaned=no reason=gone`,
    );
    expect(gone.summary).toContain("That snapshot's version of the app is gone");
    expect(gone.summary).toContain(`opscrew restore --drill ${ID} --allow-other-version`);
    const empty = await outcome(
      `${start} not-restored id=${ID} version=- start=2026-11-18T14:02:00Z parts=db:100:1 health=healthy:3 tables=db:0 removal=removed cleaned=no reason=db`,
    );
    expect(empty.summary).toContain("db holds no table once restored. The backup is bad");
  });

  it("refuses, before any change: no snapshot, a kept copy, an older script, a wrong --only, no version", async () => {
    const world = await snapshotWorld(plan());
    const none = await failure(drillSnapshot(world.deps, undefined, { services: world.services }));
    expect(none.message).toBe(
      "There is no snapshot on the app's server yet, so there is nothing to drill. Nothing was changed.",
    );
    await store(world);
    expect(
      (await failure(drillSnapshot(world.deps, OLDER, { services: world.services }))).message,
    ).toContain(`There is no snapshot ${OLDER} on the app's server.`);
    const wrong = await failure(
      drillSnapshot(world.deps, ID, { services: world.services, only: "nope" }),
    );
    expect(wrong.code).toBe("INVALID_INPUT");
    expect(
      (await failure(drillSnapshot(world.deps, "../x", { services: world.services }))).code,
    ).toBe("INVALID_INPUT");

    await world.servers.app?.write(".drill/20261101T000000Z/kept", "");
    const kept = await failure(drillSnapshot(world.deps, ID, { services: world.services }));
    expect(kept.message).toContain(
      "A kept copy of the snapshot 20261101T000000Z is still on the app's server",
    );
    expect(kept.hint).toContain("opscrew restore --drill --remove");

    const old = await snapshotWorld(plan());
    await store(old);
    const script = (await old.servers.app?.read("snapshot.sh")) ?? "";
    await old.servers.app?.write("snapshot.sh", script.replace("# snapshot_cmd_drill\n", ""));
    const before = await failure(drillSnapshot(old.deps, ID, { services: old.services }));
    expect(before.message).toContain("is from before restore drills");

    const unknown = await snapshotWorld(plan());
    await store(unknown, { version: "" });
    const versionless = await failure(
      drillSnapshot(unknown.deps, ID, { services: unknown.services }),
    );
    expect(versionless.message).toContain(`The snapshot ${ID} records no version`);
    expect(versionless.hint).toContain("--allow-other-version");
    // Today's version, the running app container's image, runs on it instead; none runs: refused.
    const idle = await failure(
      drillSnapshot(unknown.deps, ID, { services: unknown.services, allowOtherVersion: true }),
    );
    expect(idle.message).toBe(
      `No container of the app runs with an image OpsCrew can pin, so there is no version of today's to run the copy of the snapshot ${ID} with. Nothing was changed.`,
    );
    expect(unknown.handler.requests).toEqual([]);
    await running(unknown);
    await drillSnapshot(unknown.deps, ID, { services: unknown.services, allowOtherVersion: true });
    expect((await sent(unknown.servers.app)).image).toBe(`ghcr.io/acme/shop@sha256:${RUNNING}`);
    expect(unknown.handler.requests[0]?.details).toContain(
      "the version that runs now (--allow-other-version)",
    );

    for (const each of [world, old]) {
      expect(each.handler.requests).toEqual([]);
      expect((await calls(each)).filter((call) => call.startsWith("drill"))).toEqual([]);
    }
  });

  it("says the drill pulls a version the server doesn't hold", async () => {
    const world = await snapshotWorld(plan());
    await store(world);
    await world.servers.app?.write("images/missing", "");
    await drillSnapshot(world.deps, ID, { services: world.services });
    expect(world.handler.requests[0]?.details).toContain(
      "it is not on the app's server, so the drill pulls it first with the machine's own login.",
    );
  });

  it("asks again and changes nothing when the approval is refused", async () => {
    const world = await snapshotWorld(plan(), { answer: () => false });
    await store(world);
    const refused = await failure(drillSnapshot(world.deps, ID, { services: world.services }));
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(refused.message).toContain(`The drill of the snapshot ${ID} did not run`);
    expect(refused.hint).toContain(
      `--confirm ${NAME} --approve ${world.handler.requests[0]?.planHash}`,
    );
    expect(await calls(world)).toEqual(["list"]);
  });

  it("removes a kept copy with --remove after its own approval, and says when there is none", async () => {
    const world = await snapshotWorld(plan());
    const none = await drillSnapshot(world.deps, undefined, {
      services: world.services,
      remove: true,
    });
    expect(none.outcome).toBe("none");
    expect(world.handler.requests).toEqual([]);

    await world.servers.app?.write(`.drill/${ID}/kept`, "");
    const removed = await drillSnapshot(world.deps, undefined, {
      services: world.services,
      remove: true,
    });
    expect(removed).toMatchObject({ outcome: "removed", id: ID, removal: "removed" });
    expect(world.handler.requests[0]).toMatchObject({
      title: "Remove the restore drill's copy of staging on the app's server",
      allowDestroy: true,
      confirmPhrase: NAME,
    });
    expect(world.handler.requests[0]?.details).toContain(`/srv/data/${NAME}/`);
    expect((await calls(world)).at(-1)).toBe("drill --remove");
    expect((await world.servers.app?.read("approval.drill"))?.trim()).toMatch(/^- remove \d+ -$/);
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        action: "remove a restore drill's copy",
        detail: `${ID}: removed`,
      }),
    );
  });

  it("never names production's containers, volumes or .env, and shows no value or address", async () => {
    const world = await snapshotWorld(plan());
    await values(world);
    world.deps.redactor.addLiteral(PROD, "user-value");
    await store(world);
    await drillSnapshot(world.deps, ID, { services: world.services, keep: true });
    await running(world);
    await drillSnapshot(world.deps, ID, { services: world.services, allowOtherVersion: true });
    expect((await sent(world.servers.app)).image).toBe(`ghcr.io/acme/shop@sha256:${RUNNING}`);
    await world.servers.app?.write(`.drill/${ID}/kept`, "");
    await drillSnapshot(world.deps, undefined, { services: world.services, remove: true });
    const commands = world.servers.app?.commands ?? [];
    expect(commands.length).toBeGreaterThan(3);
    expect(commands.some((command) => command.includes("com.docker.compose.service=app"))).toBe(
      true,
    );
    for (const command of commands) {
      expect(command).not.toMatch(/(^|[\s/'"=;])\.env\b/);
      // No `docker compose` in the app's folder, which would read its .env.
      expect(command).not.toMatch(/docker compose (?!-p \S+-drill )/);
      expect(command).not.toMatch(
        /-p shop-staging(\s|$)|shop-staging_|\/srv\/data\/shop-staging\//,
      );
      expect(command).not.toContain(PREVIEW);
      expect(command).not.toContain(PROD);
    }
    const shown = everythingShown(world);
    for (const secret of [PREVIEW, PROD, SERVER_IPV4]) expect(shown).not.toContain(secret);
  });

  it("refuses targets without snapshots, and reaches Portainer's and hosting accounts' own drills", async () => {
    const hosting = (panel: string) =>
      stagingPlan([], {
        fields: {
          target: { provider: "hosting", panel, app: "php", webRoot: "public" },
          dns: { provider: "none", domain: "app.example.com", proxied: false, www: false },
          security: { ...testPlan().security, httpAllowedFrom: "any" },
        },
      });
    const sftp = await snapshotWorld(hosting("sftp"));
    expect(
      (await failure(drillSnapshot(sftp.deps, undefined, { services: sftp.services }))).message,
    ).toContain("is on an SFTP host, where no agent of OpsCrew's runs to take snapshots");
    const panel = await snapshotWorld(hosting("cpanel"));
    expect(
      (await failure(drillSnapshot(panel.deps, undefined, { services: panel.services }))).code,
    ).toBe("PHASE_PRECONDITION");
  });
});

describe.skipIf(!SH_AVAILABLE)("opscrew restore --drill on this computer", () => {
  it("drills through the local executor with the build the snapshot recorded, and refuses one that is gone", async () => {
    const local = localPlan();
    const built = DeployPlanSchema.parse({
      ...local,
      target: { ...local.target, image: "local-build" },
      deploy: { ...local.deploy, snapshots: true },
    });
    const computer = new FakeComputer();
    const { deps } = await localProject(built, computer);
    const folder = appFolder(deps.paths, built);
    const server = await FakeSnapshotServer.create(folder);
    await server.write(
      `.snapshots/${ID}/about.json`,
      `${JSON.stringify({ id: ID, kind: "manual", taken: "2026-11-18T12:00:00Z", version: `sha256:${OTHER}`, services: [DB] })}\n`,
    );
    computer.script = (text) => server.sh(text, computer.scripts.at(-1)?.input);
    const services = { localhost: computer.services() };
    const report = await drillSnapshot(deps, ID, { services });
    expect(report).toMatchObject({ outcome: "healthy", where: "on this computer" });
    expect(report.proves).toContain("on this computer");
    expect((await sent(server)).image).toBe(
      `opscrew-local/${built.app.name}:${OTHER.slice(0, 12)}`,
    );

    // Today's build, by the image ID of the app's running container.
    const today = "fedcba987654".padEnd(64, "0");
    await server.write(
      "images/app",
      `opscrew-local/${built.app.name}:fedcba987654 sha256:${today}`,
    );
    await drillSnapshot(deps, ID, { services, allowOtherVersion: true });
    expect((await sent(server)).image).toBe(`opscrew-local/${built.app.name}:fedcba987654`);

    await server.write("images/missing", "");
    const gone = await failure(drillSnapshot(deps, ID, { services }));
    expect(gone.message).toContain("That snapshot's version of the app is gone from this computer");
    expect(gone.hint).toContain("--allow-other-version");
  });
});

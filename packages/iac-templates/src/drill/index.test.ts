import { OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testPlan } from "../__fixtures__/plans";
import { withServices } from "../catalog/__fixtures__/plans";
import { onThisComputer } from "../edge/__fixtures__/localhost";
import { renderCompose } from "../runtime";
import {
  NIGHTLY,
  splitPlan,
  withBuild,
  withProcesses,
  withSqlite,
} from "../workflow/__fixtures__/plans";
import {
  DRILL_VALUES_FILE,
  type DrillOptions,
  drillDir,
  drillImageOk,
  drillPlan,
  drillProject,
  localBuildImage,
  renderDrill,
} from "./index";

const ID = "20261118T120000Z";
const DIGEST = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;

/**
 * `shop` on Node with PostgreSQL `db`, Redis `cache`, MySQL `orders` (whose settings file the
 * copy keeps), a worker, a cron job and a release command.
 */
const shop = DeployPlanSchema.parse({
  ...withProcesses(
    withBuild(
      withServices([
        { kind: "postgres", name: "db" },
        { kind: "redis", name: "cache" },
        { kind: "mysql", name: "orders" },
      ]),
      "railpack",
      { language: "node", version: "22" },
    ),
    { workers: [{ name: "worker", command: "node worker.js" }], cron: [NIGHTLY] },
  ),
});
const withRelease = DeployPlanSchema.parse({
  ...shop,
  app: { ...shop.app, releaseCommand: "npx prisma migrate deploy" },
});

/** The drill's env files: placeholders for generated values, and the app's plain settings. */
const ENV: DrillOptions["env"] = {
  app: "NODE_ENV=production\nDATABASE_URL=postgres://app:@SECRET:db-password:hex32@@db:5432/app\n",
  services: {
    db: "POSTGRES_PASSWORD=@SECRET:db-password:hex32@\n",
    cache: "REDIS_PASSWORD=@SECRET:cache-password:hex32@\n",
    orders: "MYSQL_ROOT_PASSWORD=@SECRET:orders-root:hex32@\n",
  },
};

/** The drill of `parts` (PostgreSQL and Redis by default) by path under its folder. */
function drill(
  o: Partial<DrillOptions> = {},
  parts: readonly string[] = ["db", "cache"],
  plan = withRelease,
): Record<string, string> {
  const files = renderDrill(plan, { id: ID, parts }, { image: DIGEST, env: ENV, ...o });
  const dir = `.drill/${ID}/`;
  for (const file of files) {
    expect(file.path.startsWith(dir)).toBe(true);
    expect(file.kind).toBe("runtime");
  }
  return Object.fromEntries(files.map((file) => [file.path.slice(dir.length), file.content]));
}

// biome-ignore lint/suspicious/noExplicitAny: a parsed Compose document.
const compose = (files: Record<string, string>): any => parse(files["compose.yaml"] ?? "");

describe("renderDrill", () => {
  it("renders the project <app>-drill: the app and the snapshot's services only", () => {
    const files = drill();
    expect(Object.keys(files).sort()).toEqual(["app.env", "cache.env", "compose.yaml", "db.env"]);
    const document = compose(files);
    expect(document.name).toBe("shop-drill");
    expect(Object.keys(document.services)).toEqual(["app", "db", "cache"]);
  });

  it("runs the app at its pinned digest with its health check and limit, after its services", () => {
    const app = compose(drill()).services.app;
    const prod = parse(renderCompose(withRelease).content).services.app;
    expect(app.image).toBe(DIGEST);
    expect(app.healthcheck).toEqual(prod.healthcheck);
    expect(app.healthcheck.test[0]).toBe("CMD");
    expect(app.mem_limit).toBe(prod.mem_limit);
    expect(app.depends_on).toEqual({
      db: { condition: "service_healthy" },
      cache: { condition: "service_healthy" },
    });
  });

  it("keeps the services' pinned images, health checks and limits, their data apart from the app's", () => {
    const { services } = compose(drill());
    const prod = parse(renderCompose(withRelease).content).services;
    for (const name of ["db", "cache"]) {
      expect(services[name].image).toBe(prod[name].image);
      expect(services[name].healthcheck).toEqual(prod[name].healthcheck);
      expect(services[name].mem_limit).toBe(prod[name].mem_limit);
      expect(services[name].env_file).toEqual([`${name}.env`]);
    }
    expect(services.db.volumes.join(" ")).toContain("/srv/data/shop-drill/db");
    expect(services.db.volumes.join(" ")).not.toMatch(/\/srv\/data\/shop\//);
  });

  it("starts no workers, cron, release command or host-settings container", () => {
    const text = drill()["compose.yaml"] ?? "";
    expect(Object.keys(compose(drill()).services)).not.toContain("worker");
    expect(text).not.toContain("cron");
    expect(text).not.toContain("prisma");
    expect(text).not.toContain("sysctl");
    const search = withBuild(withServices([{ kind: "opensearch", name: "search" }]), "railpack", {
      language: "node",
      version: "22",
    });
    expect(renderCompose(search).content).toContain("sysctl");
    const files = renderDrill(
      search,
      { id: ID, parts: ["search"] },
      { image: DIGEST, env: { app: "", services: { search: "" } } },
    );
    const document = parse(files[0]?.content ?? "");
    expect(Object.keys(document.services)).toEqual(["app", "search"]);
    expect(document.services.search.depends_on).toBeUndefined();
  });

  it("has one network with no internet and no published port, and no proxy", () => {
    const document = compose(drill());
    expect(document.networks).toEqual({ internal: { internal: true } });
    for (const service of Object.values(document.services) as { networks: string[] }[]) {
      expect(service.networks).toEqual(["internal"]);
    }
    const text = drill()["compose.yaml"] ?? "";
    expect(text).not.toMatch(/^\s*ports:/m);
    expect(text).not.toContain("opscrew-edge");
    expect(text).not.toContain("caddy");
  });

  it("reads none of the app's .env: no value of it, and the image named in the file", () => {
    const files = drill();
    const app = compose(files).services.app;
    expect(app.env_file).toEqual(["app.env"]);
    expect(files["app.env"]).toBe(ENV.app);
    expect(files["db.env"]).toBe(ENV.services.db);
    expect(Object.keys(files)).not.toContain(".env");
    expect(JSON.stringify(compose(files))).not.toMatch(/["\s/]\.env\b|APP_IMAGE|\.\.\//);
  });

  it("reads .env.preview's values first when there are some, never writing them", () => {
    const files = drill({ previewValues: true });
    expect(compose(files).services.app.env_file).toEqual([DRILL_VALUES_FILE, "app.env"]);
    expect(Object.keys(files)).not.toContain(DRILL_VALUES_FILE);
  });

  it("keeps a service's settings file in its folder", () => {
    const files = drill({}, ["db", "orders"]);
    expect(Object.keys(files)).toContain("services/orders/my.cnf");
    expect(compose(files).services.orders.volumes).toContain(
      "./services/orders/my.cnf:/etc/mysql/conf.d/opscrew.cnf:ro",
    );
  });

  it("puts a service of an extra server beside the app, unpublished", () => {
    const plan = withBuild(splitPlan(), "railpack", { language: "node", version: "22" });
    const files = renderDrill(
      plan,
      { id: ID, parts: ["db"] },
      { image: DIGEST, env: { app: "", services: { db: "" } } },
    );
    const text = files.find((file) => file.path.endsWith("compose.yaml"))?.content ?? "";
    const document = parse(text);
    expect(Object.keys(document.services)).toEqual(["app", "db"]);
    expect(text).not.toMatch(/^\s*ports:/m);
    expect(text).not.toContain("10.200.4.");
  });

  it("keeps the app's SQLite volume, the drill's own", () => {
    const plan = withSqlite(
      withBuild(testPlan({ postgres: false }), "railpack", { language: "node", version: "22" }),
    );
    const files = renderDrill(
      plan,
      { id: ID, parts: ["sqlite"] },
      { image: DIGEST, env: { app: "", services: {} } },
    );
    const document = parse(files[0]?.content ?? "");
    expect(document.volumes).toEqual({ sqlite: {} });
    expect(document.services.app.volumes[0]).toMatch(/^sqlite:/);
  });

  it("is the same compose file for the same inputs (snapshot)", () => {
    expect(drill()["compose.yaml"]).toMatchSnapshot();
  });

  it("refuses an image without its digest, a bad id, an unknown part or a missing env file", () => {
    const run =
      (o: Partial<DrillOptions>, id = ID, parts: readonly string[] = ["db"]) =>
      () =>
        renderDrill(withRelease, { id, parts }, { image: DIGEST, env: ENV, ...o });
    expect(run({ image: "ghcr.io/acme/shop:latest" })).toThrow(OpsCrewError);
    expect(run({}, "../x")).toThrow(/not a snapshot's id/);
    expect(run({}, ID, ["nope"])).toThrow(/holds nope/);
    expect(run({ env: { app: "", services: {} } })).toThrow(/none for the service db/);
  });

  it("refuses a target that is neither a server nor this computer", () => {
    const plan = { ...withRelease, target: { ...withRelease.target, provider: "portainer" } };
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: a target the plan's type doesn't allow here.
      renderDrill(plan as any, { id: ID, parts: ["db"] }, { image: DIGEST, env: ENV }),
    ).toThrow(/runs on a server, OpsCrew's or your own, or this computer/);
  });

  it("never restarts a container by itself, so a kept copy stays down after a reboot", () => {
    const text = drill()["compose.yaml"] ?? "";
    const { services } = compose(drill());
    for (const name of ["app", "db", "cache"]) expect(services[name].restart, name).toBe("no");
    expect(text).not.toContain("unless-stopped");
    expect(text.match(/^ {4}restart: "no"$/gm)).toHaveLength(3);
  });

  it("runs on this computer, a local build's tag never pulled, its services in the project's volumes", () => {
    const local = onThisComputer(shop);
    const image = localBuildImage(local, "b".repeat(64));
    expect(image).toBe("opscrew-local/shop:bbbbbbbbbbbb");
    const files = renderDrill(local, { id: ID, parts: ["db"] }, { image, env: ENV });
    const document = parse(files.find((file) => file.path.endsWith("compose.yaml"))?.content ?? "");
    expect(document.name).toBe("shop-drill");
    expect(document.services.app.image).toBe(image);
    expect(document.services.app.pull_policy).toBe("never");
    expect(document.services.db.volumes).toEqual(["db_data:/var/lib/postgresql/data"]);
    expect(document.networks).toEqual({ internal: { internal: true } });
    // An image pinned by its digest runs there too, and is pulled when missing.
    const pinned = renderDrill(local, { id: ID, parts: ["db"] }, { image: DIGEST, env: ENV });
    expect(parse(pinned[0]?.content ?? "").services.app.pull_policy).toBe("missing");
    expect(drillImageOk(local, "opscrew-local/other:bbbbbbbbbbbb")).toBe(false);
    expect(drillImageOk(withRelease, image)).toBe(false);
    expect(() => renderDrill(withRelease, { id: ID, parts: ["db"] }, { image, env: ENV })).toThrow(
      /not pinned by its digest/,
    );
  });
});

describe("drillPlan and drillProject", () => {
  it("names the project, its file and its log in the drill's folder", () => {
    expect(drillDir(ID)).toBe(`.drill/${ID}`);
    expect(drillProject(shop, ID)).toEqual({
      name: "shop-drill",
      file: `.drill/${ID}/compose.yaml`,
      log: `.drill/${ID}/restore.log`,
    });
  });

  it("keeps the snapshot's services on the drill's server, without workers, cron or release", () => {
    const plan = drillPlan(
      withBuild(splitPlan(), "railpack", { language: "node", version: "22" }),
      {
        id: ID,
        parts: ["db", "cache"],
      },
    );
    expect(plan.app.name).toBe("shop-drill");
    expect(plan.services.map((s) => [s.name, s.server])).toEqual([
      ["db", undefined],
      ["cache", undefined],
    ]);
    expect(plan.servers).toBeUndefined();
    expect(plan.network).toBeUndefined();
    expect(drillPlan(withRelease, { id: ID, parts: [] }).processes).toEqual({
      workers: [],
      cron: [],
    });
    expect(drillPlan(withRelease, { id: ID, parts: [] }).app.releaseCommand).toBeUndefined();
  });
});

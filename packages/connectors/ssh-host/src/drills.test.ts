// Feature 029: the scheduled restore drills' host step (T2944): the copy's recipe, its values and
// the deploy user's hourly line, approved by the plan's hash; their removal and the teardown's.
import { randomBytes } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import { canonicalJson, sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  desiredFor,
  everythingButStdin,
  planFor,
  provision,
  rejection,
  removeApp,
  SH_AVAILABLE,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { hostPlanHash } from "./hash";
import { DRILLS_SNIPPET, inspectHost } from "./inspect";
import { parseDrills } from "./parse";
import { planHost, planTeardown } from "./plan";
import { buildScript } from "./shell";
import { drillCronLine, stepScripts } from "./steps";
import type { DesiredHost, HostPlan, HostStep } from "./types";

const APP = "shop";
const DIR = `/srv/apps/${APP}`;
const RECIPE = `${DIR}/.drill-recipe`;
const SNAPSHOT_LINE = `0 * * * * sh ${DIR}/snapshot.sh take scheduled > /dev/null 2>&1 # opscrew-snapshots ${APP}`;

/** A recipe as `drillRecipe` would render it (stand-in texts, placeholders kept). */
const FILES = {
  "compose.yaml": `name: ${APP}-drill\nservices:\n  app:\n    image: ghcr.io/acme/shop@sha256:${"0".repeat(64)}\n    env_file: [values.env, app.env]\n    networks: [internal]\nnetworks:\n  internal:\n    internal: true\n`,
  "app.env": "DB_HOST=db\nDB_PASSWORD=@SECRET:db-password:hex32@\n",
  "db.env": "POSTGRES_PASSWORD=@SECRET:db-password:hex32@\n",
  "services/db/postgresql.conf": "max_connections = 20\n",
  schedule: "weekly\n",
};

/** What a fresh server's inspection reads (for a step's plan alone). */
const FRESH = await inspectHost(new FakeHost());

/** `.env.preview`'s values, made at runtime. */
function previewValues(): string {
  return `API_KEY=${randomBytes(16).toString("hex")}\nMODE=drill\n`;
}

function drillsDesired(
  fake: FakeHost,
  values: string,
  files: Record<string, string> = FILES,
): DesiredHost {
  return desiredFor(fake, { drills: { files, valuesSha256: sha256Hex(values) } });
}

function drillsOf(plan: HostPlan): HostStep {
  const step = plan.steps.find((item) => item.id === "drills");
  if (step === undefined) throw new Error("no drills step");
  return step;
}

/** A server the user owns with "shop" set up, its drills scheduled with `values`. */
async function drilledServer(values: string): Promise<FakeHost> {
  const fake = new FakeHost();
  await provision(fake, drillsDesired(fake, values), { secrets: { previewValues: values } });
  return fake;
}

describe("the drills step in the host plan", () => {
  it("installs the recipe, values and hourly line after the app's folders, deleting data and naming every bound", async () => {
    const fake = new FakeHost();
    const values = previewValues();
    const plan = await planFor(fake, drillsDesired(fake, values));
    const ids = plan.steps.map((item) => item.id);
    expect(ids.indexOf("drills")).toBeGreaterThan(ids.indexOf("app-record"));
    expect(plan.deleteData).toBe(true);
    const step = drillsOf(plan);
    expect(step).toMatchObject({ state: "change", scope: "app" });
    expect(step.params).toMatchObject({
      app: APP,
      valuesSha256: sha256Hex(values),
      "file:compose.yaml": FILES["compose.yaml"],
      "file:services/db/postgresql.conf": FILES["services/db/postgresql.conf"],
      "file:schedule": "weekly\n",
    });
    expect(step.title).toBe(
      'Run a restore drill of "shop" once a week on this server: its latest scheduled snapshot restored into a copy with no internet, checked, then removed',
    );
    const text = step.reason ?? "";
    for (const words of [
      `"sh ${DIR}/snapshot.sh drill scheduled" at minute 30 of every hour`,
      "3 hours after the scheduled snapshot's, once a week",
      `${RECIPE}, and the values of .env.preview to its values.env`,
      "this plan holds only their SHA-256",
      `only its own things (the Compose project ${APP}-drill, ${DIR}/.drill and /srv/data/${APP}-drill)`,
      "only the latest scheduled snapshot, never an older one or the copy off the server",
      "no internet and no published port, and the app's .env never read",
      "it removes what it made, and at its next start what a crashed run left",
      "never more often than once a day",
      "never beside a deploy, a snapshot or a restore",
      "1 GiB and 10% of the disk, or the memory is short of the copy's limits",
      "at most 30 minutes",
      ".snapshots/drills.log, which opscrew status shows",
      `approved with the typed name ${APP}-drill`,
      "anything with root on this server, the docker group included",
      "can go beyond these bounds",
      "Changing a bound is a new plan and a new approval.",
    ]) {
      expect(text, words).toContain(words);
    }
    // No value of .env.preview anywhere in the plan, only their SHA-256.
    const secret = values.split("\n")[0]?.split("=")[1] ?? "";
    expect(canonicalJson(plan)).not.toContain(secret);
    // Daily drills say so.
    const daily = await planFor(
      fake,
      drillsDesired(fake, values, { ...FILES, schedule: "daily\n" }),
    );
    expect(drillsOf(daily).title).toContain("once a day");
  });

  it("refuses a recipe without its compose file or schedule, with values.env, odd paths or a file over 64 KiB", () => {
    const fake = new FakeHost();
    const { "compose.yaml": _, ...noCompose } = FILES;
    for (const files of [
      noCompose,
      { ...FILES, schedule: "hourly\n" },
      { ...FILES, "values.env": "A=1\n" },
      { ...FILES, "../x": "x\n" },
      { ...FILES, ".hidden": "x\n" },
      { ...FILES, "big.yaml": "x".repeat(64 * 1024 + 1) },
    ]) {
      expect(() => planHost(FRESH, drillsDesired(fake, "", files), "opscrew provision")).toThrow(
        /settings for this server are not valid/,
      );
    }
  });

  it("runs as deploy after cron is installed, gets the values first on stdin, and is in place on the next plan", async () => {
    const fake = new FakeHost();
    fake.cron = false;
    const values = previewValues();
    const desired = drillsDesired(fake, values);
    const plan = await planFor(fake, desired);
    fake.calls.length = 0;
    // Without the values the apply refuses before anything runs.
    const missing = await rejection(applyApproved(fake, plan));
    expect(missing.message).toContain("needs the preview values");
    expect(fake.calls).toHaveLength(0);

    const result = await applyApproved(fake, plan, { secrets: { previewValues: values } });
    expect(result.applied).toContain("drills");
    const calls = fake.calls.filter((call) => call.name.startsWith("drills"));
    expect(calls.map((call) => [call.name, call.asUser ?? "root"])).toEqual([
      ["drills.check", "deploy"],
      ["drills.cron.apply", "root"],
      ["drills.apply", "deploy"],
      ["drills.verify", "deploy"],
    ]);
    const input = calls.find((call) => call.name === "drills.apply")?.input ?? "";
    expect(input.split("\n")[0]).toBe(Buffer.from(values).toString("base64"));
    for (const [path, text] of Object.entries(FILES)) {
      expect(fake.files.get(`${RECIPE}/${path}`)).toBe(text);
    }
    expect(fake.files.get(`${RECIPE}/values.env`)).toBe(values);
    expect(fake.fileModes.get(`${RECIPE}/values.env`)).toBe("600");
    expect(fake.crontab).toEqual([drillCronLine(APP)]);
    expect(drillCronLine(APP)).toBe(
      `30 * * * * sh ${DIR}/snapshot.sh drill scheduled > /dev/null 2>&1 # opscrew-drill ${APP}`,
    );
    // No value in the plan's hash input, the commands or the host record.
    const secret = values.split("\n")[0]?.split("=")[1] ?? "";
    expect(everythingButStdin(fake, plan)).not.toContain(secret);

    // Inspection reads the recipe, the values' hash and mode, and the line.
    const facts = await inspectHost(fake);
    expect(facts.drills).toEqual([
      {
        app: APP,
        recipe: true,
        files: Object.fromEntries(
          Object.entries(FILES).map(([path, text]) => [path, sha256Hex(text)]),
        ),
        values: { mode: "600", sha256: sha256Hex(values) },
        cron: [drillCronLine(APP)],
        left: false,
      },
    ]);
    const again = planHost(facts, desired, "opscrew provision");
    expect(drillsOf(again).state).toBe("in-place");
    expect(again.steps.every((item) => item.state === "in-place")).toBe(true);
    expect(again.deleteData).toBeUndefined();
  });

  it("sees a change: new values, another recipe file, a stale file, a mode or a missing line", async () => {
    const values = previewValues();
    const fake = await drilledServer(values);
    const state = async (desired = drillsDesired(fake, values)) =>
      drillsOf(planHost(await inspectHost(fake), desired, "opscrew provision")).state;
    expect(await state()).toBe("in-place");
    expect(await state(drillsDesired(fake, previewValues()))).toBe("change");
    expect(await state(drillsDesired(fake, values, { ...FILES, schedule: "daily\n" }))).toBe(
      "change",
    );
    fake.files.set(`${RECIPE}/old.env`, "X=1\n");
    expect(await state()).toBe("change");
    fake.files.delete(`${RECIPE}/old.env`);
    fake.fileModes.set(`${RECIPE}/values.env`, "644");
    expect(await state()).toBe("change");
    fake.fileModes.set(`${RECIPE}/values.env`, "600");
    fake.crontab = [SNAPSHOT_LINE];
    expect(await state()).toBe("change");

    // Applying the change puts it back, the snapshot line kept, the stale file gone.
    fake.files.set(`${RECIPE}/old.env`, "X=1\n");
    const next = previewValues();
    await provision(fake, drillsDesired(fake, next), { secrets: { previewValues: next } });
    expect(fake.crontab).toEqual([SNAPSHOT_LINE, drillCronLine(APP)]);
    expect(fake.files.has(`${RECIPE}/old.env`)).toBe(false);
    expect(fake.files.get(`${RECIPE}/values.env`)).toBe(next);
    expect(await state(drillsDesired(fake, next))).toBe("in-place");
  });

  it("changes nothing when the values supplied are not the ones the plan names, and redacts them", async () => {
    const fake = new FakeHost();
    const values = previewValues();
    const plan = await planFor(fake, drillsDesired(fake, values));
    const other = previewValues();
    const refused = await rejection(
      applyApproved(fake, plan, { secrets: { previewValues: other } }),
    );
    expect(refused.message).toContain("are not the ones this plan names");
    expect(fake.files.has(`${RECIPE}/values.env`)).toBe(false);
    expect(fake.files.has(`${RECIPE}/compose.yaml`)).toBe(false);

    const value = randomBytes(12).toString("hex");
    const fresh = new FakeHost();
    const printed = `API_KEY=${value}\n`;
    const again = await planFor(fresh, drillsDesired(fresh, printed));
    fresh.failScripts.set("drills.apply", `the server printed ${value} back`);
    const failed = await rejection(
      applyApproved(fresh, again, { secrets: { previewValues: printed } }),
    );
    expect(failed.message).toContain("the server printed");
    expect(failed.message).not.toContain(value);
  });

  it("is refused by the apply in a plan that does not delete data, before anything runs", async () => {
    const fake = new FakeHost();
    const values = previewValues();
    const plan = await planFor(fake, drillsDesired(fake, values));
    fake.calls.length = 0;
    const { deleteData: _, ...sneaky } = plan;
    const refused = await rejection(
      applyApproved(fake, sneaky, { secrets: { previewValues: values } }),
    );
    expect(refused.code).toBe("INVALID_INPUT");
    expect(refused.message).toContain("deleteData");
    expect(fake.calls).toEqual([]);
    expect(hostPlanHash(sneaky)).not.toBe(hostPlanHash(plan));
  });
});

describe("the drills' removal", () => {
  it("off: removes the line, the recipe, its values and a drill's leftovers; the snapshot line and the app stay", async () => {
    const values = previewValues();
    const fake = await drilledServer(values);
    fake.crontab = [SNAPSHOT_LINE, ...(fake.crontab ?? [])];
    // A crashed drill's copy: its folder, its data and its project's container and volume.
    fake.files.set(`${DIR}/.drill/20261118T030000Z/compose.yaml`, "name: shop-drill\n");
    fake.dirs.set("/srv/data/shop-drill", {
      owner: "root",
      group: "root",
      mode: "755",
      entries: 1,
    });
    fake.containers.push({ name: "shop-drill-app-1", project: "shop-drill", ports: "" });
    fake.volumes.set("shop-drill", 1);
    const facts = await inspectHost(fake);
    expect(facts.drills[0]?.left).toBe(true);

    const plan = planHost(facts, desiredFor(fake), "opscrew provision");
    expect(plan.deleteData).toBe(true);
    const step = drillsOf(plan);
    expect(step).toMatchObject({ state: "change", params: { app: APP, remove: true } });
    expect(step.title).toBe(
      'Remove the scheduled restore drills of "shop": their hourly line, their recipe and values, and any copy a drill left',
    );
    expect(step.reason).toContain("a copy kept with --keep included");
    expect(step.reason).toContain("The app's own containers, data and snapshots stay.");
    fake.calls.length = 0;
    await applyApproved(fake, plan);
    expect(
      fake.calls.filter((call) => call.name.startsWith("drills")).map((call) => call.name),
    ).toEqual(["drills.remove.check", "drills.remove.apply", "drills.remove.verify"]);
    expect(fake.crontab).toEqual([SNAPSHOT_LINE]);
    expect([...fake.files.keys()].some((path) => path.startsWith(`${DIR}/.drill`))).toBe(false);
    expect(fake.dirs.has("/srv/data/shop-drill")).toBe(false);
    expect(fake.containers.some((container) => container.project === "shop-drill")).toBe(false);
    expect(fake.volumes.has("shop-drill")).toBe(false);
    expect(fake.dirs.has(DIR)).toBe(true);

    const after = await inspectHost(fake);
    expect(after.drills).toEqual([]);
    const again = planHost(after, desiredFor(fake), "opscrew provision");
    expect(again.steps.some((item) => item.id === "drills")).toBe(false);
    expect(again.deleteData).toBeUndefined();
  });

  it("leaves a manual drill's copy alone while no schedule was ever there", async () => {
    const fake = new FakeHost();
    await provision(fake);
    fake.files.set(`${DIR}/.drill/20261118T030000Z/kept`, "");
    const plan = planHost(await inspectHost(fake), desiredFor(fake), "opscrew provision");
    expect(plan.steps.some((item) => item.id === "drills")).toBe(false);
  });

  it("destroy's teardown removes the drills before the app, with any leftovers, keeping data or not", async () => {
    for (const deleteData of [true, false]) {
      const values = previewValues();
      const fake = await drilledServer(values);
      fake.crontab = [SNAPSHOT_LINE, ...(fake.crontab ?? [])];
      fake.containers.push({ name: "shop-drill-db-1", project: "shop-drill", ports: "" });
      const facts = await inspectHost(fake);
      const plan = planTeardown(
        facts,
        { deleteData, app: APP, projectId: "shop-0123456789ab" },
        "opscrew destroy",
      );
      const ids = plan.steps.map((item) => item.id);
      expect(ids.indexOf("drills")).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf("drills")).toBeLessThan(ids.indexOf("app-dirs"));
      await removeApp(fake, APP, deleteData);
      expect(fake.crontab).toEqual([]);
      expect([...fake.files.keys()].some((path) => path.startsWith(RECIPE))).toBe(false);
      expect(fake.containers.some((container) => container.project === "shop-drill")).toBe(false);
    }
    // Only leftovers, no schedule: they go too.
    const fake = new FakeHost();
    await provision(fake);
    fake.volumes.set("shop-drill", 2);
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: false, app: APP, projectId: "shop-0123456789ab" },
      "opscrew destroy",
    );
    expect(plan.steps.find((item) => item.id === "drills")?.params).toEqual({
      app: APP,
      remove: true,
    });
    await removeApp(fake, APP, false);
    expect(fake.volumes.has("shop-drill")).toBe(false);
  });
});

describe.skipIf(!SH_AVAILABLE)("the drills step's scripts in a real shell", () => {
  /** A harness with the deploy user, a crontab kept in its state, Docker and systemd stubbed. */
  function harness(): ShellHarness {
    const h = new ShellHarness();
    h.stub("getent", `echo "deploy:x:1000:1000::${h.root}/home/deploy:/bin/sh"`, { log: false });
    h.stub("id", `case "$1" in -un) echo deploy ;; *) echo 1000 ;; esac`, { log: false });
    h.stub(
      "crontab",
      `case "$*" in
  *-l*) if [ -f "$S/crontab" ]; then cat "$S/crontab"; else echo "no crontab for deploy" >&2; exit 1; fi ;;
  *-) cat > "$S/crontab" ;;
esac`,
    );
    h.stub("systemctl", 'case "$1" in is-active) exit 0 ;; *) exit 0 ;; esac', { log: false });
    h.stub(
      "docker",
      `case "$1 $2" in
  "ps -aq") cat "$S/containers" 2>/dev/null || true ;;
  "rm -f") : > "$S/containers" ;;
  "network ls") cat "$S/networks" 2>/dev/null || true ;;
  "network rm") : > "$S/networks" ;;
  "volume ls") cat "$S/volumes" 2>/dev/null || true ;;
  "volume rm") : > "$S/volumes" ;;
  *) exit 0 ;;
esac`,
    );
    // Git Bash keeps no Unix modes; elsewhere the real stat reads the mode chmod set.
    if (process.platform === "win32") h.stub("stat", "echo 600", { log: false });
    return h;
  }
  const rooted = (h: ShellHarness, text: string) => text.replaceAll("/srv/", `${h.root}/srv/`);
  const b64 = (text: string) => Buffer.from(text).toString("base64");

  /** The drills step's plan alone, for `values` (on) or its removal (off). */
  function drillsPlan(values: string, off = false): HostPlan {
    const fake = new FakeHost();
    const desired = off ? desiredFor(fake) : drillsDesired(fake, values);
    const step: HostStep = off
      ? {
          id: "drills",
          title: "drills",
          state: "change",
          scope: "app",
          params: { app: APP, remove: true },
        }
      : drillsOf(planHost(FRESH, desired, "opscrew provision"));
    return {
      schemaVersion: 1,
      purpose: "setup",
      app: APP,
      steps: [step],
      findings: [],
      deleteData: true,
    };
  }

  it("writes the recipe and values, replaces only the app's line, and removes an earlier file", () => {
    const values = previewValues();
    const plan = drillsPlan(values);
    const [step] = plan.steps;
    if (step === undefined) throw new Error("no step");
    const scripts = stepScripts(plan, step);
    const h = harness();
    try {
      h.write(`${DIR}/compose.yaml`, "services: {}\n");
      h.write(`${RECIPE}/old.env`, "X=1\n");
      h.write(
        "/state/crontab",
        `${rooted(h, SNAPSHOT_LINE)}\n0 * * * * old line # opscrew-drill ${APP}\n5 * * * * x # opscrew-drill ${APP}-admin\n`,
      );
      expect(h.run(scripts.check).stdout).toContain("state=change");
      const applied = h.run(scripts.apply, `${b64(values)}\n${scripts.payload ?? ""}`);
      expect(applied.status, applied.stderr).toBe(0);
      for (const [path, text] of Object.entries(FILES))
        expect(h.read(`${RECIPE}/${path}`)).toBe(text);
      expect(h.read(`${RECIPE}/values.env`)).toBe(values);
      expect(h.exists(`${RECIPE}/old.env`)).toBe(false);
      if (process.platform !== "win32") {
        const mode = (path: string) => statSync(h.native(path)).mode & 0o777;
        expect(
          ["values.env", "app.env", "compose.yaml"].map((f) => mode(`${RECIPE}/${f}`)),
        ).toEqual([0o600, 0o600, 0o644]);
      }
      expect(h.read("/state/crontab")).toBe(
        `${rooted(h, SNAPSHOT_LINE)}\n5 * * * * x # opscrew-drill ${APP}-admin\n${rooted(h, drillCronLine(APP))}\n`,
      );
      expect(h.run(scripts.verify).status).toBe(0);
      expect(h.run(scripts.check).stdout).toContain("state=in-place");
      // Other values on the server are a change.
      h.write(`${RECIPE}/values.env`, previewValues());
      expect(h.run(scripts.check).stdout).toContain("state=change");
    } finally {
      h.dispose();
    }
  });

  it("changes nothing when the values supplied are not the ones the plan names", () => {
    const plan = drillsPlan(previewValues());
    const [step] = plan.steps;
    if (step === undefined) throw new Error("no step");
    const scripts = stepScripts(plan, step);
    const h = harness();
    try {
      h.write(`${DIR}/compose.yaml`, "services: {}\n");
      for (const values of [previewValues(), ""]) {
        const refused = h.run(scripts.apply, `${b64(values)}\n${scripts.payload ?? ""}`);
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain("are not the ones this plan names");
        expect(h.exists(RECIPE)).toBe(false);
        expect(h.exists("/state/crontab")).toBe(false);
      }
      // No values at all, when the plan names none: an empty values file.
      const none = drillsPlan("");
      const [only] = none.steps;
      if (only === undefined) throw new Error("no step");
      const empty = stepScripts(none, only);
      const applied = h.run(empty.apply, `\n${empty.payload ?? ""}`);
      expect(applied.status, applied.stderr).toBe(0);
      expect(h.read(`${RECIPE}/values.env`)).toBe("");
    } finally {
      h.dispose();
    }
  });

  it("removal: the line, the recipe, .drill, the copy's data and its project; repeatable", () => {
    const plan = drillsPlan("", true);
    const [step] = plan.steps;
    if (step === undefined) throw new Error("no step");
    const scripts = stepScripts(plan, step);
    const h = harness();
    try {
      h.write(`${DIR}/compose.yaml`, "services: {}\n");
      h.write(`${RECIPE}/compose.yaml`, FILES["compose.yaml"]);
      h.write(`${RECIPE}/values.env`, previewValues());
      h.write(`${DIR}/.drill/20261118T030000Z/compose.yaml`, "x\n");
      h.write("/srv/data/shop-drill/db/PG_VERSION", "17\n");
      h.write("/state/containers", "c0ffee\n");
      h.write("/state/volumes", "shop-drill_db\n");
      h.write("/state/crontab", `${rooted(h, SNAPSHOT_LINE)}\n${rooted(h, drillCronLine(APP))}\n`);
      expect(h.run(scripts.check).stdout).toContain("state=change");
      const removed = h.run(scripts.apply);
      expect(removed.status, removed.stderr).toBe(0);
      expect(h.read("/state/crontab")).toBe(`${rooted(h, SNAPSHOT_LINE)}\n`);
      for (const path of [RECIPE, `${DIR}/.drill`, "/srv/data/shop-drill"]) {
        expect(h.exists(path), path).toBe(false);
      }
      expect(h.read("/state/containers")).toBe("");
      expect(h.read("/state/volumes")).toBe("");
      expect(h.read(`${DIR}/compose.yaml`)).toBe("services: {}\n");
      expect(h.calls()).toContain("docker volume rm shop-drill_db");
      expect(h.run(scripts.verify).status).toBe(0);
      expect(h.run(scripts.check).stdout).toContain("state=in-place");
      expect(h.run(scripts.apply).status).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("inspection's snippet lists the lines, each recipe's files and values, and leftovers", () => {
    const h = harness();
    try {
      for (const [path, text] of Object.entries(FILES)) h.write(`${RECIPE}/${path}`, text);
      h.write(`${RECIPE}/values.env`, "A=1\n");
      chmodSync(h.native(`${RECIPE}/values.env`), 0o600);
      h.write(`${RECIPE}/.opscrew.tmp`, "x\n");
      h.write("/srv/apps/blog/.drill/x/kept", "");
      h.write("/srv/apps/news/compose.yaml", "x\n");
      h.write(
        "/state/crontab",
        `${rooted(h, SNAPSHOT_LINE)}\n${rooted(h, drillCronLine(APP))}\n0 * * * * y # opscrew-drill gone\n`,
      );
      const run = h.run(buildScript("drills.inspect", {}, DRILLS_SNIPPET, { tolerant: true }));
      expect(run.status, run.stderr).toBe(0);
      const facts = parseDrills(run.stdout.replaceAll(`${h.root}/srv/`, "/srv/"));
      expect(facts).toEqual([
        { app: "blog", recipe: false, files: {}, values: null, cron: [], left: true },
        {
          app: "gone",
          recipe: false,
          files: {},
          values: null,
          cron: ["0 * * * * y # opscrew-drill gone"],
          left: false,
        },
        {
          app: APP,
          recipe: true,
          files: Object.fromEntries(
            Object.entries(FILES).map(([path, text]) => [path, sha256Hex(text)]),
          ),
          values: { mode: "600", sha256: sha256Hex("A=1\n") },
          cron: [drillCronLine(APP)],
          left: false,
        },
      ]);
    } finally {
      h.dispose();
    }
  });
});

import { findExecutable, OpsCrewError } from "@opscrew/core";
import { DEPLOY_PAUSED_VARIABLE, IMAGES } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import {
  appSettingsForB,
  bucketWindow,
  emptyBuckets,
  firstCopies,
  lastBackupsCopy,
  measureBuckets,
  recoverWindow,
  type WindowOptions,
} from "./buckets";
import {
  APP_BUCKET,
  asScript,
  BACKUPS_BUCKET,
  type BucketWorld,
  bucketWorld,
} from "./buckets.fakes";
import { markWindow, readAppProgress, recordWindowStop } from "./progress";
import { FINISH_COMMAND, MOVE_COMMAND } from "./texts";

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpsCrewError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

/** The objects of a bucket in an account, by name. */
function objectsOf(w: BucketWorld, account: string, bucket: string): Record<string, string> {
  return Object.fromEntries(w.r2.objects(account, bucket));
}

/** rclone's runs as `<verb> <first bucket path>`. */
function verbs(w: BucketWorld): string[] {
  return w.r2.runs.map((run) => `${run.verb} ${run.args.find((arg) => /^[ab]:/.test(arg))}`);
}

/**
 * The window's options: step 1's two parts and its undo, each noted in the trail (step 1's with
 * whether the deploys were paused then); `fail` names the part that fails.
 */
function stepOne(w: BucketWorld, fail?: "secrets" | "deploy"): WindowOptions {
  const part = (name: "secrets" | "deploy") => async () => {
    w.trail.push(`${name}${w.paused().deploys ? " (deploys paused)" : ""}`);
    if (fail === name) throw new OpsCrewError("COMMAND_FAILED", `The ${name} step failed.`);
  };
  return {
    pointAtB: { secrets: part("secrets"), deploy: part("deploy") },
    backToA: async () => {
      w.trail.push("back to A");
    },
  };
}

/** The window's record in the app's file. */
async function windowOf(w: BucketWorld) {
  return (await readAppProgress(w.deps.paths)).window;
}

const TARGETS = ["cloud", "portainer"] as const;

describe.skipIf(!findExecutable("git"))("the move's R2 buckets", () => {
  describe("measureBuckets", () => {
    it("measures A's buckets on the app's server with A's keys only", async () => {
      const w = await bucketWorld("cloud");
      const sizes = await measureBuckets(w.session, w.environment);
      expect(sizes).toEqual([
        { environment: "prod", root: "storage", bucket: APP_BUCKET, bytes: 7, count: 3 },
        { environment: "prod", root: "backups", bucket: BACKUPS_BUCKET, bytes: 6, count: 2 },
      ]);
      const configs = w.r2.runs.map((run) => run.config).join("\n");
      expect(configs).toContain(w.keys.a.storage.secretAccessKey);
      expect(configs).not.toContain(w.keys.b.storage.secretAccessKey);
      expect(configs).not.toContain(w.keys.b.backups.secretAccessKey);
      expect(w.leaks()).toBe(false);
    });

    it("has nothing to measure without a bucket on R2", async () => {
      const w = await bucketWorld("cloud", { none: true });
      expect(await measureBuckets(w.session, w.environment)).toEqual([]);
      expect(w.r2.runs).toEqual([]);
    });
  });

  describe("firstCopies", () => {
    for (const target of TARGETS) {
      it(`copies both buckets after one approval listing them (${target})`, async () => {
        const w = await bucketWorld(target);
        expect(await firstCopies(w.session, w.environment)).toBeUndefined();
        const asked = w.handler.requests.filter((r) => r.kind === "remote-exec");
        expect(asked).toHaveLength(1);
        const [approval] = asked;
        expect(approval?.title).toBe(
          "Copy the R2 buckets of shop (prod) to the new Cloudflare account",
        );
        expect(approval?.planHash).toMatch(/^[0-9a-f]{64}$/);
        expect(approval?.details).toContain(
          "shop-uploads (the app's files): 7 bytes in 3 objects, about 4 minutes",
        );
        expect(approval?.details).toContain(
          "shop-backups (the snapshots' copies): 6 bytes in 2 objects, about 4 minutes",
        );
        expect(approval?.details).toContain("Nothing in the current account changes");
        expect(w.r2.runs.map((run) => run.verb)).toEqual(["size", "size", "copy", "copy"]);
        expect(
          w.r2.runs.every((run) => run.where === (target === "cloud" ? "ssh" : "docker")),
        ).toBe(true);
        const copy = w.r2.runs.find((run) => run.verb === "copy");
        expect(copy?.args).toEqual([
          "copy",
          `a:${APP_BUCKET}`,
          `b:${APP_BUCKET}`,
          "--checksum",
          "--metadata",
        ]);
        expect(objectsOf(w, w.fresh, APP_BUCKET)).toEqual(objectsOf(w, w.old, APP_BUCKET));
        expect(objectsOf(w, w.fresh, BACKUPS_BUCKET)).toEqual(objectsOf(w, w.old, BACKUPS_BUCKET));
        // A's buckets don't change.
        expect(Object.keys(objectsOf(w, w.old, APP_BUCKET))).toEqual(["a.png", "b.png", "c.pdf"]);
        const audited = w.deps.audit.entries.filter((e) => e.action === "copy bucket");
        expect(audited.map((e) => [e.phase, e.target, e.decision])).toEqual([
          ["cloudflare-move", "shop", "approved"],
          ["cloudflare-move", "shop", "approved"],
        ]);
        if (target === "portainer") {
          // The keys went in through the archive API only.
          expect(w.containers.map((c) => c.env)).toEqual([[], [], [], []]);
          expect(w.containers[2]?.cmd.slice(0, 2)).toEqual(["--config", "/tmp/r.conf"]);
          expect(w.docker.containers.size).toBe(4);
        } else {
          expect(w.commands.every((c) => c.command.includes(IMAGES.rclone.ref))).toBe(true);
          expect(w.commands[2]?.input).toContain(w.keys.b.storage.secretAccessKey);
        }
        expect(w.leaks()).toBe(false);
      });
    }

    it("stops a script with the step's hash, then copies with --approve", async () => {
      const w = await bucketWorld("cloud");
      const script = asScript(w);
      const stop = await firstCopies(script, w.environment);
      const hash = stop?.pendingPlanHash ?? "";
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stop?.next).toEqual([
        `Review the step above, then run \`${MOVE_COMMAND} --approve ${hash}\` to copy them and continue.`,
      ]);
      expect(w.deps.reporter.text()).toContain(
        "shop-uploads (the app's files): 7 bytes in 3 objects",
      );
      expect((await readAppProgress(w.deps.paths)).pending).toMatchObject({
        action: "copy",
        environment: "prod",
        planHash: hash,
      });
      expect(w.r2.runs.map((run) => run.verb)).toEqual(["size", "size"]);
      expect(w.handler.requests).toEqual([]);
      expect(objectsOf(w, w.fresh, APP_BUCKET)).toEqual({});

      expect(await firstCopies(asScript(w, hash), w.environment)).toBeUndefined();
      expect(w.handler.requests.map((r) => r.planHash)).toEqual([hash]);
      expect(objectsOf(w, w.fresh, APP_BUCKET)).toEqual(objectsOf(w, w.old, APP_BUCKET));
      expect((await readAppProgress(w.deps.paths)).pending).toBeUndefined();
    });

    it("an interrupted copy stops plainly, redacted, and the next run copies what is missing", async () => {
      const w = await bucketWorld("cloud");
      let failures = 1;
      w.r2.fail = (verb) =>
        verb === "copy" && failures-- > 0
          ? {
              exitCode: 1,
              stdout: "",
              stderr: `ERROR: lost the connection with ${w.keys.b.storage.secretAccessKey}`,
            }
          : undefined;
      const error = await caught(firstCopies(w.session, w.environment));
      expect(error.code).toBe("COMMAND_FAILED");
      expect(error.message).toBe(
        "Copying the bucket shop-uploads to the new Cloudflare account failed on the app's server: ERROR: lost the connection with [REDACTED:storage-key]",
      );
      expect(error.hint).toContain("it copies what is missing");
      expect(await firstCopies(w.session, w.environment)).toBeUndefined();
      expect(objectsOf(w, w.fresh, APP_BUCKET)).toEqual(objectsOf(w, w.old, APP_BUCKET));
      expect(w.leaks(error.message, error.hint ?? "")).toBe(false);
    });

    it("a refused approval copies nothing", async () => {
      const w = await bucketWorld("cloud");
      w.answers.approve = () => false;
      const error = await caught(firstCopies(w.session, w.environment));
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toContain("Nothing was changed.");
      expect(w.r2.runs.map((run) => run.verb)).toEqual(["size", "size"]);
    });

    it("a script without B's keys stops before anything runs", async () => {
      const w = await bucketWorld("cloud");
      delete w.deps.env.OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID;
      delete w.deps.env.OPSCREW_NEW_OFFSITE_SECRET_ACCESS_KEY;
      const error = await caught(firstCopies(asScript(w), w.environment));
      expect(error.code).toBe("CREDENTIALS_MISSING");
      expect(error.hint).toContain("OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID");
      expect(w.r2.runs).toEqual([]);
    });
  });

  describe("lastBackupsCopy", () => {
    it("copies only the snapshots' copies, what A gained since the first copy", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      await firstCopies(w.session, w.environment);
      w.r2.objects(w.old, BACKUPS_BUCKET).set("backups/3/db.age", "three");
      w.r2.runs.length = 0;
      expect(await lastBackupsCopy(w.session, w.environment)).toBeUndefined();
      expect(verbs(w)).toEqual([`size a:${BACKUPS_BUCKET}`, `copy a:${BACKUPS_BUCKET}`]);
      expect(Object.keys(objectsOf(w, w.fresh, BACKUPS_BUCKET))).toContain("backups/3/db.age");
      const last = w.handler.requests.at(-1);
      expect(last?.title).toBe(
        "Copy the snapshots' copies of shop (prod) made since the first copy to the new Cloudflare account",
      );
      expect(last?.details).toContain("3 objects, about 1 minutes");
      expect(w.leaks()).toBe(false);
    });

    it("has nothing to copy without the snapshots' copies on R2", async () => {
      const w = await bucketWorld("cloud", { appOnly: true });
      expect(await lastBackupsCopy(w.session, w.environment)).toBeUndefined();
      expect(w.r2.runs).toEqual([]);
      expect(w.handler.requests).toEqual([]);
    });
  });

  describe("appSettingsForB", () => {
    it("gives B's keys with B's endpoint, the names kept", async () => {
      const w = await bucketWorld("cloud");
      const endpoint = `https://${w.fresh}.r2.cloudflarestorage.com`;
      expect(await appSettingsForB(w.session, w.environment)).toEqual({
        storage: { ...w.keys.b.storage, endpoint },
        backups: { ...w.keys.b.backups, endpoint },
      });
    });
  });

  describe("bucketWindow", () => {
    for (const target of TARGETS) {
      it(`stops the app, syncs its bucket, writes B's settings while deploys are paused, then deploys (${target})`, async () => {
        const w = await bucketWorld(target, { command: FINISH_COMMAND });
        await firstCopies(w.session, w.environment);
        // Since the first copy, A's app wrote one file and deleted another.
        const a = w.r2.objects(w.old, APP_BUCKET);
        a.set("d.png", "dddd");
        a.delete("b.png");
        w.trail.length = 0;
        w.r2.runs.length = 0;
        w.handler.requests.length = 0;
        expect(await bucketWindow(w.session, w.environment, stepOne(w))).toBeUndefined();
        expect(w.trail).toEqual([
          "rclone size",
          "stop app",
          "stop worker",
          "rclone sync",
          "secrets (deploys paused)",
          "deploy",
        ]);
        // One approval: the window's, which covers the scheduled check's pause and resume.
        expect(w.handler.requests.map((r) => r.kind)).toEqual(["remote-exec"]);
        const [window] = w.handler.requests;
        expect(window?.title).toMatch(/^Maintenance window: stop shop \(prod\) on /);
        expect(window?.title).toContain("(about ");
        expect(window?.details).toContain("pause the app's deploys");
        expect(window?.details).toContain("pause the scheduled check");
        // The sync ran with the deploys and the check paused; both run again afterwards.
        expect(w.r2.runs.find((run) => run.verb === "sync")?.paused).toEqual({
          deploys: true,
          check: true,
        });
        expect(w.paused()).toEqual({ deploys: false, check: false });
        expect(objectsOf(w, w.fresh, APP_BUCKET)).toEqual(objectsOf(w, w.old, APP_BUCKET));
        expect(await windowOf(w)).toEqual({
          environment: "prod",
          stoppedAt: expect.any(String),
          pointingAt: expect.any(String),
          endedAt: expect.any(String),
        });
        const actions = w.deps.audit.entries
          .filter((e) => e.phase === "cloudflare-move" && e.action === "window")
          .map((e) => e.detail);
        expect(actions).toEqual([
          expect.stringContaining("maintenance window started"),
          expect.stringContaining("maintenance window ended"),
        ]);
        expect(w.leaks()).toBe(false);
      });
    }

    it("a run after a window that ended deletes nothing in B: only step 1 runs again", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      await firstCopies(w.session, w.environment);
      await bucketWindow(w.session, w.environment, stepOne(w));
      // The app on B wrote a file; A's bucket no longer changes.
      w.r2.objects(w.fresh, APP_BUCKET).set("new.png", "written on B");
      w.trail.length = 0;
      const asked = w.handler.requests.length;
      expect(await bucketWindow(w.session, w.environment, stepOne(w))).toBeUndefined();
      expect(w.trail).toEqual(["secrets", "deploy"]);
      expect(w.handler.requests).toHaveLength(asked);
      expect(objectsOf(w, w.fresh, APP_BUCKET)["new.png"]).toBe("written on B");
      // The finish's recovery leaves an ended window alone.
      await recoverWindow(w.session, w.environment, stepOne(w).backToA);
      expect(w.trail).toEqual(["secrets", "deploy"]);
    });

    it("a run that died while pointing the app at B goes forward, never syncing again", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      await firstCopies(w.session, w.environment);
      // The earlier run synced, began pointing at B, then died with the deploys paused.
      await recordWindowStop(w.deps, "prod");
      await markWindow(w.deps, "pointingAt");
      w.github.variables.set(
        DEPLOY_PAUSED_VARIABLE,
        JSON.stringify({ "shop/prod": { reason: "move", since: "2026-11-21T09:00:00.000Z" } }),
      );
      w.r2.objects(w.fresh, APP_BUCKET).set("new.png", "written on B");
      w.trail.length = 0;
      // recoverWindow doesn't take it back to A.
      await recoverWindow(w.session, w.environment, stepOne(w).backToA);
      expect(w.trail).toEqual([]);
      expect(await bucketWindow(w.session, w.environment, stepOne(w))).toBeUndefined();
      expect(w.trail).toEqual(["secrets (deploys paused)", "deploy"]);
      expect(w.deps.reporter.text()).toContain("OpsCrew goes on pointing it there");
      expect(objectsOf(w, w.fresh, APP_BUCKET)["new.png"]).toBe("written on B");
      expect((await windowOf(w))?.endedAt).toEqual(expect.any(String));
      expect(w.paused().deploys).toBe(false);
    });

    it("going forward that fails again keeps the record, to go on next time", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      await recordWindowStop(w.deps, "prod");
      await markWindow(w.deps, "pointingAt");
      const error = await caught(bucketWindow(w.session, w.environment, stepOne(w, "deploy")));
      expect(error.message).toBe(
        "Pointing shop (prod) at the new Cloudflare account failed again: The deploy step failed. Its bucket's files are in the new account; OpsCrew goes on from here, never back.",
      );
      expect(w.trail).toEqual(["secrets", "deploy"]);
      expect(await windowOf(w)).toMatchObject({ pointingAt: expect.any(String) });
      expect((await windowOf(w))?.endedAt).toBeUndefined();
    });

    const failures = [
      { at: "the stop", fail: (w: BucketWorld) => w.failNextStop() },
      { at: "the sync", fail: (w: BucketWorld) => syncFails(w) },
      { at: "B's secrets", part: "secrets" as const },
      { at: "the deploy", part: "deploy" as const },
    ];
    for (const target of TARGETS) {
      for (const failure of failures) {
        it(`a window failing at ${failure.at} puts A's settings back and starts the app on A (${target})`, async () => {
          const w = await bucketWorld(target, { command: FINISH_COMMAND });
          await firstCopies(w.session, w.environment);
          w.trail.length = 0;
          failure.fail?.(w);
          const error = await caught(
            bucketWindow(w.session, w.environment, stepOne(w, failure.part)),
          );
          expect(error.message).toMatch(/^The maintenance window failed: /);
          expect(error.message).toContain(
            "Shop (prod) runs again on the current Cloudflare account's bucket, and nothing else changed.",
          );
          expect(error.hint).toContain(`Then run \`${FINISH_COMMAND}\` again`);
          expect(w.trail.slice(-3)).toEqual(["back to A", "start app", "start worker"]);
          expect(await windowOf(w)).toBeUndefined();
          expect(w.paused()).toEqual({ deploys: false, check: false });
          expect(
            w.deps.audit.entries.some((e) => e.action === "window" && e.decision === "refused"),
          ).toBe(true);
          expect(w.leaks(error.message, error.hint ?? "")).toBe(false);
        });
      }
    }

    it("refuses in Portainer when the stack runs no app container", async () => {
      const w = await bucketWorld("portainer", { command: FINISH_COMMAND });
      w.docker.containers.delete("opscrew-shop-app".padEnd(64, "0"));
      const error = await caught(bucketWindow(w.session, w.environment, stepOne(w)));
      expect(error.message).toContain(
        "Your Portainer runs no app container of the stack opscrew-shop, so OpsCrew can't stop shop (prod) for the window",
      );
      expect(w.trail).not.toContain("stop worker");
      expect(w.trail).not.toContain("rclone sync");
    });

    it("a deploy that still runs keeps the window from starting, the app untouched", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      w.github.workflowRuns = [
        { status: "in_progress", htmlUrl: "https://github.com/acme/shop/actions/runs/1" },
      ] as typeof w.github.workflowRuns;
      const error = await caught(bucketWindow(w.session, w.environment, stepOne(w)));
      expect(error.message).toContain("the maintenance window did not start");
      expect(w.trail).toEqual(["rclone size"]);
      expect(await windowOf(w)).toBeUndefined();
      expect(w.paused()).toEqual({ deploys: false, check: false });
    });

    it("a run that finds the app stopped before pointing at B starts it on A first, then repeats the window", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      await firstCopies(w.session, w.environment);
      // The earlier run died during the window, its deploy pause left behind.
      await recordWindowStop(w.deps, "prod");
      w.github.variables.set(
        DEPLOY_PAUSED_VARIABLE,
        JSON.stringify({ "shop/prod": { reason: "move", since: "2026-11-21T09:00:00.000Z" } }),
      );
      w.trail.length = 0;
      expect(await bucketWindow(w.session, w.environment, stepOne(w))).toBeUndefined();
      expect(w.trail).toEqual([
        "back to A",
        "start app",
        "start worker",
        "rclone size",
        "stop app",
        "stop worker",
        "rclone sync",
        "secrets (deploys paused)",
        "deploy",
      ]);
      expect(w.deps.reporter.text()).toContain(
        "An earlier run stopped shop (prod) for the maintenance window",
      );
      expect((await windowOf(w))?.endedAt).toEqual(expect.any(String));
    });

    it("refuses while another environment's window has not ended, and not once it has", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      await recordWindowStop(w.deps, "staging");
      const error = await caught(bucketWindow(w.session, w.environment, stepOne(w)));
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toMatch(
        /^The maintenance window of staging began at .+ and has not ended, so OpsCrew does not start shop \(prod\)'s\. Nothing was changed\.$/,
      );
      expect(error.hint).toBe(`Finish staging first: run \`${FINISH_COMMAND}\` again.`);
      expect(w.trail).toEqual([]);
      await markWindow(w.deps, "endedAt");
      expect(await bucketWindow(w.session, w.environment, stepOne(w))).toBeUndefined();
      expect(w.trail).toContain("rclone sync");
    });

    it("recoverWindow does nothing when no window was left", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      await recoverWindow(w.session, w.environment, stepOne(w).backToA);
      expect(w.trail).toEqual([]);
    });

    it("keeps the window's stop when the app can't be started again", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      syncFails(w);
      const options: WindowOptions = {
        ...stepOne(w),
        backToA: async () => {
          throw new OpsCrewError("COMMAND_FAILED", "GitHub refused the secrets.");
        },
      };
      const error = await caught(bucketWindow(w.session, w.environment, options));
      expect(error.message).toBe(
        "OpsCrew could not start shop (prod) again on the current Cloudflare account's settings: GitHub refused the secrets. Your app is offline until it runs again.",
      );
      expect(error.hint).toContain("run `docker compose up -d` in /srv/apps/shop");
      expect((await windowOf(w))?.environment).toBe("prod");
    });

    it("a script without --allow-downtime stops before anything changes", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      const stop = await bucketWindow(asScript(w), w.environment, stepOne(w));
      expect(stop?.next.at(-1)).toBe(
        `Run \`${FINISH_COMMAND} --allow-downtime\` when that is acceptable.`,
      );
      expect(stop?.next[0]).toMatch(
        /^The finish stops shop \(prod\) on the app's server for about \d+ minutes while the last changes of its bucket shop-uploads are copied/,
      );
      expect(w.trail).toEqual(["rclone size"]);
      expect(w.handler.requests).toEqual([]);

      const scripted = await bucketWindow(asScript(w), w.environment, {
        ...stepOne(w),
        allowDowntime: true,
      });
      expect(scripted).toBeUndefined();
      expect(w.trail).toContain("deploy");
    });

    it("a refused window changes nothing", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND });
      w.answers.approve = (request) => !request.title.startsWith("Maintenance window");
      const error = await caught(bucketWindow(w.session, w.environment, stepOne(w)));
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toContain("Nothing was changed");
      expect(w.trail).toEqual(["rclone size"]);
    });

    it("without an app bucket on R2, step 1 runs as it is", async () => {
      const w = await bucketWorld("cloud", { none: true, command: FINISH_COMMAND });
      expect(await bucketWindow(w.session, w.environment, stepOne(w))).toBeUndefined();
      expect(w.trail).toEqual(["secrets", "deploy"]);
      expect(w.handler.requests).toEqual([]);
    });
  });

  describe("emptyBuckets", () => {
    for (const target of TARGETS) {
      it(`at the finish empties each of A's buckets after its name is typed, checked against B's right before (${target})`, async () => {
        const w = await bucketWorld(target, { command: FINISH_COMMAND, step: "adopted" });
        await firstCopies(w.session, w.environment);
        w.r2.runs.length = 0;
        let checked = -1;
        w.answers.approve = () => {
          checked = w.r2.runs.filter((run) => run.verb === "check").length;
          return true;
        };
        expect(await emptyBuckets(w.session, w.environment, "a")).toBeUndefined();
        expect(verbs(w)).toEqual([
          `size a:${APP_BUCKET}`,
          `check a:${APP_BUCKET}`,
          `delete a:${APP_BUCKET}`,
          `size a:${BACKUPS_BUCKET}`,
          `check a:${BACKUPS_BUCKET}`,
          `delete a:${BACKUPS_BUCKET}`,
        ]);
        // The check runs after each approval, right before its deletion.
        expect(checked).toBe(1);
        expect(w.r2.runs.find((run) => run.verb === "check")?.args).toEqual([
          "check",
          `a:${APP_BUCKET}`,
          `b:${APP_BUCKET}`,
          "--one-way",
          "--checksum",
        ]);
        const deletions = w.handler.requests.filter((r) => r.allowDestroy === true);
        expect(deletions.map((r) => [r.kind, r.confirmPhrase])).toEqual([
          ["remote-exec", APP_BUCKET],
          ["remote-exec", BACKUPS_BUCKET],
        ]);
        expect(deletions[0]?.title).toBe(
          "Empty the bucket shop-uploads in the current Cloudflare account Old",
        );
        expect(deletions[0]?.details).toContain("This cannot be undone.");
        expect(deletions[0]?.details).toContain("same size, and checksum where R2 has one");
        expect(objectsOf(w, w.old, APP_BUCKET)).toEqual({});
        expect(objectsOf(w, w.old, BACKUPS_BUCKET)).toEqual({});
        expect(Object.keys(objectsOf(w, w.fresh, APP_BUCKET))).toEqual(["a.png", "b.png", "c.pdf"]);
        expect(w.deps.audit.entries.filter((e) => e.action === "bucket emptied")).toHaveLength(2);
        // A run after the emptying asks nothing again.
        const asked = w.handler.requests.length;
        expect(await emptyBuckets(w.session, w.environment, "a")).toBeUndefined();
        expect(w.handler.requests).toHaveLength(asked);
        expect(w.leaks()).toBe(false);
      });
    }

    it("a file written to A between the approval and the deletion stops the deletion", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND, step: "adopted" });
      await firstCopies(w.session, w.environment);
      w.answers.approve = (request) => {
        if (request.title.startsWith("Empty the bucket")) {
          w.r2.objects(w.old, APP_BUCKET).set("late.png", "written after the approval");
        }
        return true;
      };
      const error = await caught(emptyBuckets(w.session, w.environment, "a"));
      expect(error.code).toBe("COMMAND_FAILED");
      expect(error.message).toContain(
        "Checking that the new Cloudflare account's bucket shop-uploads holds every file of the current one's failed on the app's server: ERROR : late.png: file not in the destination",
      );
      expect(error.hint).toContain("Nothing was deleted");
      expect(w.r2.runs.some((run) => run.verb === "delete")).toBe(false);
      expect(Object.keys(objectsOf(w, w.old, APP_BUCKET))).toContain("late.png");
    });

    it("refuses A's buckets before the finish adopted the app, and B's after", async () => {
      const before = await bucketWorld("cloud", { command: FINISH_COMMAND, step: "prepared" });
      const early = await caught(emptyBuckets(before.session, before.environment, "a"));
      expect(early.code).toBe("PHASE_PRECONDITION");
      expect(early.message).toBe(
        "Shop (prod) still uses its buckets in the current Cloudflare account Old: OpsCrew empties them only once the finish has moved the app to the new account. Nothing was changed.",
      );
      expect(before.r2.runs).toEqual([]);

      const after = await bucketWorld("cloud", { command: ABORT, step: "adopted" });
      const late = await caught(emptyBuckets(after.session, after.environment, "b"));
      expect(late.code).toBe("PHASE_PRECONDITION");
      expect(late.message).toContain("uses its buckets in the new Cloudflare account New");
      expect(after.r2.runs).toEqual([]);
    });

    it("at an abort empties B's buckets without a check; A's are never read", async () => {
      const w = await bucketWorld("portainer", { command: ABORT });
      await firstCopies(w.session, w.environment);
      w.r2.runs.length = 0;
      expect(await emptyBuckets(w.session, w.environment, "b")).toBeUndefined();
      expect(verbs(w)).toEqual([
        `size b:${APP_BUCKET}`,
        `delete b:${APP_BUCKET}`,
        `size b:${BACKUPS_BUCKET}`,
        `delete b:${BACKUPS_BUCKET}`,
      ]);
      expect(w.r2.runs.map((run) => run.config).join("\n")).not.toContain(
        w.keys.a.storage.accessKeyId,
      );
      expect(objectsOf(w, w.fresh, APP_BUCKET)).toEqual({});
      expect(Object.keys(objectsOf(w, w.old, APP_BUCKET))).toEqual(["a.png", "b.png", "c.pdf"]);
      const deletions = w.handler.requests.filter((r) => r.allowDestroy === true);
      expect(deletions.map((r) => r.confirmPhrase)).toEqual([APP_BUCKET, BACKUPS_BUCKET]);
      expect(w.leaks()).toBe(false);
    });

    it("an abort before any copy skips B's empty buckets", async () => {
      const w = await bucketWorld("cloud", { command: ABORT });
      expect(await emptyBuckets(w.session, w.environment, "b")).toBeUndefined();
      expect(w.handler.requests).toEqual([]);
      expect(w.deps.reporter.text()).toContain(
        "The bucket shop-uploads in the new Cloudflare account New is empty.",
      );
    });

    it("a script empties one bucket per run, with --confirm and --approve", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND, step: "adopted" });
      await firstCopies(w.session, w.environment);
      const first = await emptyBuckets(asScript(w), w.environment, "a");
      const hash = first?.pendingPlanHash ?? "";
      expect(first?.next).toEqual([
        `Review the step above, then run \`${FINISH_COMMAND} --confirm ${APP_BUCKET} --approve ${hash}\` to empty it and continue.`,
      ]);
      expect((await readAppProgress(w.deps.paths)).pending).toMatchObject({
        action: "a-empty",
        environment: "prod",
        root: "storage",
      });
      expect(Object.keys(objectsOf(w, w.old, APP_BUCKET))).toHaveLength(3);
      const second = await emptyBuckets(asScript(w, hash), w.environment, "a");
      expect(objectsOf(w, w.old, APP_BUCKET)).toEqual({});
      expect(second?.next[0]).toContain(`--confirm ${BACKUPS_BUCKET} --approve`);
      expect((await readAppProgress(w.deps.paths)).pending).toMatchObject({ root: "backups" });
      const third = await emptyBuckets(asScript(w, second?.pendingPlanHash), w.environment, "a");
      expect(third).toBeUndefined();
      expect(objectsOf(w, w.old, BACKUPS_BUCKET)).toEqual({});
      expect((await readAppProgress(w.deps.paths)).pending).toBeUndefined();
    });

    it("a refused typed name deletes nothing", async () => {
      const w = await bucketWorld("cloud", { command: FINISH_COMMAND, step: "adopted" });
      await firstCopies(w.session, w.environment);
      w.answers.approve = (request) => !request.title.startsWith("Empty the bucket");
      const error = await caught(emptyBuckets(w.session, w.environment, "a"));
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toBe(
        "The bucket shop-uploads in the current Cloudflare account Old was not emptied. Nothing was deleted.",
      );
      expect(w.r2.runs.some((run) => run.verb === "check" || run.verb === "delete")).toBe(false);
      expect(Object.keys(objectsOf(w, w.old, APP_BUCKET))).toHaveLength(3);
    });
  });
});

const ABORT = `${MOVE_COMMAND} --abort`;

/** Makes the window's sync fail, its output naming A's key. */
function syncFails(w: BucketWorld): void {
  w.r2.fail = (verb) =>
    verb === "sync"
      ? { exitCode: 1, stdout: "", stderr: `ERROR: denied for ${w.keys.a.storage.secretAccessKey}` }
      : undefined;
}

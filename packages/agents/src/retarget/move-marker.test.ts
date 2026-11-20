import { readFile } from "node:fs/promises";
import { findExecutable } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  BUILT_IMAGE,
  type MoveHarness,
  moveHarness,
  OLD_IPV4,
  OLD_IPV6,
  STRIPE,
  TOKENS,
} from "../testing";
import {
  caught,
  drive,
  everythingPrinted,
  expectGated,
  moveOnDisk as move,
  run,
  trail,
} from "./__fixtures__/assert";
import { abortRetarget } from "./abort";

/** The digest of the image the deploy before the copy left on the new server, shortened. */
const DEPLOYED = `sha256:${"e".repeat(12)}`;

/** How often the fakes saw `op` on `host`. */
const ops = (h: MoveHarness, host: string, op: string) =>
  h.events.filter((e) => e.type === "remote" && e.host === host && e.op === op).length;

/** Every text a run showed, audited, asked for or set, with the deploy key: none holds a secret. */
async function expectNoLeak(h: MoveHarness, extra: readonly string[] = []): Promise<void> {
  const key = (await readFile(h.paths.files.deployKey, "utf8")).trim();
  const text = [
    everythingPrinted(h),
    JSON.stringify(h.handler.requests),
    JSON.stringify(h.github.runs),
    ...extra,
  ].join("\n");
  for (const secret of [STRIPE, key, ...Object.values(TOKENS)]) {
    expect(text).not.toContain(secret);
  }
  // The window's approval and the deploy's inputs name the sides in words, never their addresses.
  const window = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
  for (const address of [OLD_IPV4, OLD_IPV6, h.newServer.ipv4, h.newServer.ipv6]) {
    expect(`${window?.title}\n${window?.details}\n${JSON.stringify(h.github.runs)}`).not.toContain(
      address,
    );
  }
}

describe.skipIf(!findExecutable("git"))(
  "FR-3027: the app starts on a move's new server only after its data is there",
  () => {
    it("resumes a move stopped at the deploy step by a release command that failed on the empty database", async () => {
      // The PHP app's state: an earlier OpsCrew put no marker on the new server, so its deploy ran
      // the release command (the framework's migrate, which needs its tables) on the empty database.
      const h = await moveHarness({ release: true });
      h.hosts.releaseNeedsData = true;
      const n = h.newServer.ipv4;
      h.hosts.fail = (_ip, op) =>
        op === "mark waiting" ? { exitCode: 0, stdout: "", stderr: "" } : undefined;
      const stopped = await caught(run(h));
      expect(stopped.message).toContain("The deploy workflow did not succeed (failure)");
      expect((await move(h))?.step).toBe("created");
      expect(h.hosts.host(n)).toMatchObject({ app: false, db: "empty", outcome: "started" });
      expect(h.hosts.host(n).image).toBeUndefined();
      expect(h.github.secrets.get("OPSCREW_HOST")).toBe(n);
      const secrets = h.events.filter((e) => e.type === "secret").length;

      // `opscrew retarget` again: the marker first, then the deploy brings up only the image and
      // the services, whose check passes, and the window deploys that image on the copied data.
      h.hosts.fail = undefined;
      const mark = h.events.length;
      const result = await run(h);
      expect(result).toMatchObject({ step: "switched", done: true });
      const lines = trail(h.events.slice(mark));
      expect(lines.slice(0, 3)).toEqual([`${n} mark waiting`, "dispatch main", `${n} stop caddy`]);
      expect(lines).toContain(`dispatch main ${DEPLOYED}`);
      expect(lines.indexOf(`dispatch main ${DEPLOYED}`)).toBeGreaterThan(
        lines.indexOf(`${n} restore`),
      );
      expect(h.reporter.text()).toContain("The GitHub deploy secrets already point to");
      expect(h.events.filter((e) => e.type === "secret")).toHaveLength(secrets);
      expect(ops(h, n, "services up?")).toBe(1);
      expect(h.hosts.host(n)).toMatchObject({
        app: true,
        waiting: false,
        db: "orders before the move (migrated)",
        image: BUILT_IMAGE,
        outcome: "finished",
      });
      expect(h.github.runs.map((r) => r.inputs?.digest)).toEqual([
        undefined,
        undefined,
        BUILT_IMAGE.slice(BUILT_IMAGE.indexOf("@") + 1),
      ]);
      expectGated(h.events);
      await expectNoLeak(h, [stopped.message, stopped.hint ?? ""]);
    });

    it("a script stops before the window with the new server waiting for the data, and --abort removes it", async () => {
      const h = await moveHarness({ interactive: false, release: true });
      const n = h.newServer.ipv4;
      // Without --allow-downtime a script stops right before the window.
      const stopped = await drive(h);
      expect(stopped.step).toBe("deployed");
      expect(stopped.next.join(" ")).toContain("--allow-downtime");
      expect(h.hosts.host(n)).toMatchObject({ app: false, waiting: true, db: "empty" });
      expect(ops(h, n, "release")).toBe(0);
      expect(ops(h, n, "health")).toBe(0);
      // The deploy secrets pointed there after the marker: a push deploys only the services too.
      const marked = h.events.findIndex((e) => e.type === "remote" && e.op === "mark waiting");
      expect(marked).toBeLessThan(h.events.findIndex((e) => e.type === "secret"));
      h.hosts.deploy(n);
      expect(h.hosts.host(n)).toMatchObject({ app: false, outcome: `waiting ${BUILT_IMAGE}` });

      // --abort deletes the new server, and the marker in its app's folder with it.
      h.deps.interactive = true;
      h.handler.answer = () => true;
      const mark = h.events.length;
      const aborted = await abortRetarget(h.deps, { services: h.services, confirm: h.confirm });
      expect(aborted).toMatchObject({ step: "aborted", done: true });
      const lines = trail(h.events.slice(mark));
      expect(lines.filter((line) => line.startsWith("apply"))).toEqual([
        "apply deletes=4",
        "apply moves=3",
      ]);
      expect(lines.some((line) => line.endsWith("waiting"))).toBe(false);
      expect(h.engine.state.servers.server?.ipv4).toBe(OLD_IPV4);
      expect(h.github.secrets.get("OPSCREW_HOST")).toBe(OLD_IPV4);
      expect(h.hosts.host(OLD_IPV4)).toMatchObject({ app: true, db: "orders before the move" });
      expectGated(h.events, true);
      await expectNoLeak(h);
    });
  },
);

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
        marker: undefined,
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

    it("no deploy run of the move checks the app from outside, which still leads to the old side", async () => {
      const h = await moveHarness({ release: true });
      const checked: string[] = [];
      const check = h.github.checkFromOutside;
      h.github.checkFromOutside = (host) => {
        checked.push(host);
        return check(host);
      };
      // The runs wait for a required reviewer: the move says where to approve them.
      h.github.reviewer = true;
      expect(await run(h)).toMatchObject({ step: "switched", done: true });
      // The deploy before the copy left only the services; the window's started the app on its
      // copied data and left the check to the move, over SSH.
      expect(checked).toEqual([]);
      expect(h.github.runs).toHaveLength(2);
      expect(h.reporter.text()).toContain(
        "The deploy run waits in GitHub for a required reviewer: approve it at https://github.com/acme/shop/actions/runs/99.",
      );
    });

    it("a deploy before the window that checked the app from outside would check the old app, which still serves", async () => {
      const h = await moveHarness({ release: true });
      const n = h.newServer.ipv4;
      // As if the move took the marker away instead of saying the data is copied.
      h.hosts.fail = (ip, op) => {
        if (ip !== n || op !== "mark copied") return undefined;
        h.hosts.host(n).marker = undefined;
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const reached: (string | undefined)[] = [];
      const check = h.github.checkFromOutside;
      h.github.checkFromOutside = (host) => {
        reached.push(h.engine.dnsServer()?.ipv4);
        return check(host);
      };
      expect(await run(h)).toMatchObject({ step: "switched", done: true });
      // Its check went through the domain to the old side: it says nothing of the new one, which
      // the move checks over SSH instead.
      expect(reached).toEqual([OLD_IPV4]);
    });

    it("a script stops at the window once the app answers on the new server on the data copied while the old one serves, and --abort removes it", async () => {
      const h = await moveHarness({ interactive: false, release: true });
      const n = h.newServer.ipv4;
      // Without --allow-downtime a script stops right before the window, the data copied while the
      // old app serves and the app checked on it there.
      const stopped = await drive(h);
      expect(stopped.step).toBe("deployed");
      expect(stopped.next.join(" ")).toContain("--allow-downtime");
      // The deploy secrets pointed there after the marker: a push deployed only the services.
      expect(
        h.events.findIndex((e) => e.type === "remote" && e.op === "mark waiting"),
      ).toBeLessThan(h.events.findIndex((e) => e.type === "secret"));
      // It answered there, then stopped again, held for the window by the marker.
      expect(h.hosts.host(n)).toMatchObject({
        app: false,
        marker: "waiting",
        db: "orders before the move (migrated)",
      });
      expect(ops(h, n, "health")).toBeGreaterThan(0);
      expect(h.hosts.host(OLD_IPV4)).toMatchObject({ app: true, db: "orders before the move" });

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

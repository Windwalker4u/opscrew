import { dockerClient } from "@opscrew/connector-docker";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { MOVE_WAITING } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { writeRenderedFiles } from "../shared";
import { OLD_IPV4 } from "../testing";
import { trail } from "./__fixtures__/assert";
import { NEW_IPV4, type PairHarness, pairHarness } from "./__fixtures__/pairs";
import { renderFiles } from "./session";
import type { RetargetResult } from "./types";
import { maintenanceWindow } from "./window";

/** The window's approval request, when it was asked for. */
const windowRequest = (h: PairHarness) =>
  h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));

/** GitHub's branch holds the deploy files, with an earlier OpsCrew's workflow (no marker check). */
async function earlierWorkflowOnGitHub(h: PairHarness): Promise<void> {
  const files = (await renderFiles(h.session))
    .filter((file) => file.kind !== "infra")
    .map((file) =>
      file.path === h.plan.cicd.workflowPath
        ? {
            ...file,
            content: file.content
              .split("\n")
              .filter((line) => !line.includes(MOVE_WAITING))
              .join("\n"),
          }
        : file,
    );
  await writeRenderedFiles(h.root, files);
  await h.git(h.root, "add", ...files.map((file) => file.path));
  await h.git(h.root, "commit", "-m", "an earlier OpsCrew's deploy files");
  await h.git(h.root, "push", h.bare, "HEAD:refs/heads/main");
}

describe.skipIf(!findExecutable("git"))("FR-3027: the window on a server the move holds", () => {
  it("stops before any change while GitHub's workflow doesn't know the marker, with its pull request", async () => {
    const h = await pairHarness("hetzner", "digitalocean");
    await earlierWorkflowOnGitHub(h);
    const stop = (await maintenanceWindow(h.session, { allowDowntime: true })) as RetargetResult;
    expect(stop).toMatchObject({ step: "deployed", done: false });
    expect(stop.next.join(" ")).toContain(
      "The deploy workflow on main is an earlier OpsCrew's, which would run the release command and start the app on the new Droplet on DigitalOcean before the move copies its data there.",
    );
    expect(stop.next.join(" ")).toContain("opscrew retarget");
    expect(h.handler.requests.some((r) => r.kind === "pull-request")).toBe(true);
    // Nothing asked or changed on the servers: the old app serves on.
    expect(windowRequest(h)).toBeUndefined();
    const onServers = (line: string) => line.startsWith(OLD_IPV4) || line.startsWith(NEW_IPV4);
    expect(trail(h.events).filter(onServers)).toEqual([]);
    expect(h.hosts.host(OLD_IPV4)).toMatchObject({ app: true, db: "orders before the move" });
    expect(h.session.plan.retarget?.oldAppStoppedAt).toBeUndefined();
    expect(`${stop.next.join(" ")}\n${JSON.stringify(h.handler.requests)}`).not.toContain(NEW_IPV4);

    // Merged on GitHub: the window runs and starts the app on its copied data.
    await h.git(h.root, "push", h.bare, "HEAD:refs/heads/main");
    expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
    expect(h.hosts.host(NEW_IPV4)).toMatchObject({
      app: true,
      marker: undefined,
      db: "orders before the move",
    });
  });

  it("with nothing to copy after all, starts the app on the new server without a window", async () => {
    const h = await pairHarness("hetzner", "digitalocean");
    // The database starts empty there, and nothing else holds data.
    const move = h.session.plan.retarget;
    if (move === undefined) throw new Error("no move");
    h.session.plan = { ...h.session.plan, retarget: { ...move, empty: ["db"] } };
    expect(h.hosts.host(NEW_IPV4)).toMatchObject({ app: false, marker: "waiting" });
    expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
    // No window, no pause: the old side serves while the new one starts with its deploy.
    expect(windowRequest(h)).toBeUndefined();
    expect(h.audit.entries.some((e) => e.action.startsWith("pause the deploys of"))).toBe(false);
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    expect(trail(h.events)).toEqual([
      `${NEW_IPV4} mark copied`,
      `dispatch main sha256:${"e".repeat(12)}`,
      `${NEW_IPV4} stop caddy`,
      `${NEW_IPV4} remove marker`,
    ]);
    expect(h.hosts.host(NEW_IPV4)).toMatchObject({ app: true, caddy: false, marker: undefined });
    expect(h.reporter.text()).toContain("There is no data to copy after all");
  });

  it("with nothing to copy, starts the app while the marker holds it, whatever a later run recorded", async () => {
    const h = await pairHarness("hetzner", "digitalocean");
    const move = h.session.plan.retarget;
    if (move === undefined) throw new Error("no move");
    h.session.plan = { ...h.session.plan, retarget: { ...move, empty: ["db"] } };
    // A push deploy failed after the move's own deploy: its outcome says started.
    h.hosts.host(NEW_IPV4).outcome = "started";
    expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
    expect(h.hosts.host(NEW_IPV4)).toMatchObject({ app: true, marker: undefined });
  });

  it("with nothing to copy, a failed start leaves the new server waiting for its data again", async () => {
    const h = await pairHarness("hetzner", "digitalocean");
    const move = h.session.plan.retarget;
    if (move === undefined) throw new Error("no move");
    h.session.plan = { ...h.session.plan, retarget: { ...move, empty: ["db"] } };
    h.github.conclusion = "failure";
    // The failed run started the edge there.
    h.hosts.host(NEW_IPV4).caddy = true;
    const error = await maintenanceWindow(h.session, { allowDowntime: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain("The deploy workflow did not succeed");
    expect(h.hosts.host(NEW_IPV4)).toMatchObject({ marker: "waiting", caddy: false });
    expect(trail(h.events).slice(-2)).toEqual([
      `${NEW_IPV4} mark waiting`,
      `${NEW_IPV4} stop caddy`,
    ]);
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
  });

  it("keeps the new server's web server stopped until the switch, unless other apps share it", async () => {
    const alone = await pairHarness("hetzner", "own", { cache: true });
    expect(await maintenanceWindow(alone.session, { allowDowntime: true })).toBe("done");
    expect(windowRequest(alone)?.details).toContain(
      "and the app started there on that copy and answered",
    );
    // The deploy on the data copied while the old app serves started it; it stops again then.
    const lines = trail(alone.events);
    expect(lines.indexOf(`${NEW_IPV4} stop caddy`)).toBeGreaterThan(
      lines.indexOf(`${NEW_IPV4} mark copied`),
    );
    expect(lines.indexOf(`${NEW_IPV4} stop caddy`)).toBeLessThan(
      lines.indexOf("approve remote-exec"),
    );
    expect(alone.hosts.host(NEW_IPV4).caddy).toBe(false);

    const shared = await pairHarness("hetzner", "own", { cache: true });
    // Another app on the user's server serves through the same edge.
    shared.hosts.docker(NEW_IPV4).images.add("ghcr.io/acme/blog:1");
    await dockerClient(shared.hosts.docker(NEW_IPV4)).createContainer({
      image: "ghcr.io/acme/blog:1",
      labels: {
        "com.docker.compose.project": "blog",
        "com.docker.compose.project.working_dir": "/srv/apps/blog",
      },
    });
    expect(await maintenanceWindow(shared.session, { allowDowntime: true })).toBe("done");
    expect(trail(shared.events)).not.toContain(`${NEW_IPV4} stop caddy`);
    expect(shared.reporter.text()).toContain("keeps running: other apps there use it too.");
  });
});

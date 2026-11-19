import { rm } from "node:fs/promises";
import type { HostFacts } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createdServerFacts,
  freshFacts,
  SERVER_IPV4,
  secondAppRecord,
  sharedServerProject,
  testPlan,
} from "../testing";
import { otherAppsMemory, otherAppsOnServer, requireNoOtherApps } from "./guard";

/**
 * The first app's deps and plan (its repository, provisioned on a server OpsCrew created), with a
 * server whose inspection reports `facts` (or throws `fails`); the hosts reached and the inspections'
 * options are kept.
 */
async function firstAppOnServer(o: { facts?: HostFacts; fails?: Error } = {}) {
  const project = await sharedServerProject();
  const deps = { ...project.deps, paths: project.first };
  const plan = await readArtifact("plan", project.first.files.plan);
  const hosts: string[] = [];
  const inspections: { rootImage?: string }[] = [];
  const services = {
    remote: (host: string): RemoteExec => {
      hosts.push(host);
      return {
        host,
        run: async () => {
          throw new Error("the fake inspection should have handled this");
        },
      };
    },
    inspect: async (_remote: RemoteExec, options: { rootImage?: string }) => {
      inspections.push(options);
      if (o.fails !== undefined) throw o.fails;
      return o.facts ?? createdServerFacts();
    },
  };
  /** Everything the fakes saw: nothing of the address or the deploy key leaves. */
  const said = (...more: unknown[]) =>
    [deps.reporter.text(), JSON.stringify(deps.audit.entries), ...more.map(String)].join("\n");
  return { project, deps, plan, services, hosts, inspections, said };
}

/** What `requireNoOtherApps` threw, or `undefined`. */
async function refusal(promise: Promise<void>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error as { code: string; message: string; hint?: string },
  );
}

describe("otherAppsOnServer", () => {
  it("reads the other apps' records, active and with their data kept, as root through Docker", async () => {
    const records = [secondAppRecord(), secondAppRecord({ app: "archive", state: "data-kept" })];
    const t = await firstAppOnServer({ facts: createdServerFacts(records) });
    const found = await otherAppsOnServer(t.deps, t.plan, { services: t.services });
    expect(found).toEqual({ reached: true, apps: records });
    expect(t.hosts).toEqual([SERVER_IPV4]);
    expect(t.inspections).toEqual([{ rootImage: IMAGES.caddy.ref }]);
    expect(t.deps.audit.entries.at(-1)).toMatchObject({
      kind: "remote-exec",
      action: "inspect host (read-only)",
      target: "server",
    });
    expect(t.said()).not.toContain(SERVER_IPV4);
    expect(t.said()).not.toContain(t.project.firstKey);
  });

  it("finds none without a deployment, without connecting", async () => {
    const t = await firstAppOnServer();
    const plan: DeployPlan = testPlan({ domain: "shop.example.com" });
    expect(await otherAppsOnServer(t.deps, plan, { services: t.services })).toEqual({
      reached: true,
      apps: [],
    });
    expect(t.hosts).toEqual([]);
  });

  it("did not reach the server when SSH fails, its login can't read the records, or no login is here", async () => {
    const down = await firstAppOnServer({
      fails: new Error(`ssh: connect to host ${SERVER_IPV4}`),
    });
    const unreached = await otherAppsOnServer(down.deps, down.plan, { services: down.services });
    expect(unreached).toEqual({ reached: false, reason: "it could not be reached over SSH" });
    expect(down.said()).not.toContain(SERVER_IPV4);

    const partial = await firstAppOnServer({
      facts: freshFacts({ user: "deploy", privilege: "none" }),
    });
    expect(
      await otherAppsOnServer(partial.deps, partial.plan, { services: partial.services }),
    ).toEqual({
      reached: false,
      reason: "its deploy login could not read the apps' records there",
    });

    const away = await firstAppOnServer();
    await rm(away.project.first.files.deployKey);
    expect(await otherAppsOnServer(away.deps, away.plan, { services: away.services })).toEqual({
      reached: false,
      reason: "this computer has no deploy login to it",
    });
    expect(away.hosts).toEqual([]);
  });
});

describe("requireNoOtherApps", () => {
  const again = "opscrew destroy";

  it("refuses while another app runs on the server, naming it and its repository", async () => {
    const t = await firstAppOnServer({ facts: createdServerFacts([secondAppRecord()]) });
    const error = await refusal(
      requireNoOtherApps(t.deps, t.plan, "destroying the server", again, { services: t.services }),
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        'The server also runs "inventory" (from github.com/example/inventory), and destroying the server would break it. Nothing was changed.',
    });
    expect(error?.hint).toBe(
      "Run `opscrew destroy` in its repository first, or `opscrew retarget` there to move it to a server of its own; then run `opscrew destroy` again.",
    );
    expect(t.said(error?.message, error?.hint)).not.toContain(SERVER_IPV4);
  });

  it("refuses while another app's data is kept there, saying how to delete it or to lose it", async () => {
    const t = await firstAppOnServer({
      facts: createdServerFacts([secondAppRecord({ state: "data-kept" })]),
    });
    const error = await refusal(
      requireNoOtherApps(t.deps, t.plan, "destroying the server", again, { services: t.services }),
    );
    expect(error?.message).toContain(
      'The server also keeps the data of "inventory" (from github.com/example/inventory)',
    );
    expect(error?.hint).toContain(
      '`opscrew destroy --delete-data` in the repository of "inventory"',
    );
    expect(error?.hint).toContain("`opscrew destroy --skip-other-apps-check`");
  });

  it("goes on when the server holds no other app", async () => {
    const t = await firstAppOnServer();
    await requireNoOtherApps(t.deps, t.plan, "destroying the server", again, {
      services: t.services,
    });
    expect(t.inspections).toHaveLength(1);
  });

  it("refuses when the server can't be looked at, unless the check is skipped", async () => {
    const t = await firstAppOnServer({ fails: new Error("unreachable") });
    const error = await refusal(
      requireNoOtherApps(t.deps, t.plan, "destroying the server", again, { services: t.services }),
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "OpsCrew couldn't look at the server for other apps (it could not be reached over SSH), and destroying the server would break any that run there. Nothing was changed.",
    });
    expect(error?.hint).toContain("`opscrew destroy --skip-other-apps-check`");

    const skipped = await firstAppOnServer({ fails: new Error("unreachable") });
    await requireNoOtherApps(skipped.deps, skipped.plan, "destroying the server", again, {
      skip: true,
      services: skipped.services,
    });
    expect(skipped.inspections).toEqual([]);
    expect(skipped.deps.reporter.text()).toContain("--skip-other-apps-check");
  });
});

describe("otherAppsMemory", () => {
  it("gives the memory limits of the active records", () => {
    const facts = createdServerFacts([
      secondAppRecord({ memoryMb: 768 }),
      secondAppRecord({ app: "archive", state: "data-kept" }),
    ]);
    expect(otherAppsMemory(facts)).toEqual([{ name: "inventory", memoryMb: 768, tunnel: false }]);
  });
});

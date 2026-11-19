import type { HostFacts } from "@opscrew/connector-ssh-host";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createdServerFacts,
  FakeGitHub,
  freshFacts,
  SERVER_IPV4,
  secondAppRecord,
  sharedServerProject,
  testPlan,
} from "../testing";
import { appWords, otherAppsLines } from "./other-apps";
import { componentStatusReport } from "./run";

/** The first app's deps and plan, with a server whose inspection reports `facts` (or throws). */
async function firstApp(facts?: HostFacts | Error) {
  const project = await sharedServerProject();
  const deps = { ...project.deps, paths: project.first };
  const plan = await readArtifact("plan", project.first.files.plan);
  const services = {
    inspect: async (_remote: RemoteExec) => {
      if (facts instanceof Error) throw facts;
      return facts ?? createdServerFacts();
    },
  };
  const said = (lines: string[]) =>
    [...lines, deps.reporter.text(), JSON.stringify(deps.audit.entries)].join("\n");
  return { project, deps, plan, services, said };
}

describe("otherAppsLines", () => {
  it("names each app from another repository, its data kept, and a record OpsCrew can't read", async () => {
    const facts = createdServerFacts([
      secondAppRecord(),
      secondAppRecord({ app: "archive", state: "data-kept" }),
    ]);
    facts.apps.push({ name: "ledger", record: null });
    const t = await firstApp(facts);
    const lines = await otherAppsLines(t.deps, t.plan, t.services);
    expect(lines).toEqual([
      "Also on this server: inventory (github.com/example/inventory), archive (github.com/example/archive, only its data kept) and ledger (an app whose record OpsCrew can't read).",
    ]);
    expect(t.said(lines)).not.toContain(SERVER_IPV4);
    expect(t.said(lines)).not.toContain(t.project.firstKey);
  });

  it("says nothing when the server holds no other app", async () => {
    const t = await firstApp();
    expect(await otherAppsLines(t.deps, t.plan, t.services)).toEqual([]);
  });

  it("says nothing when OpsCrew couldn't look", async () => {
    const t = await firstApp(new Error(`ssh: connect to host ${SERVER_IPV4}`));
    const lines = await otherAppsLines(t.deps, t.plan, t.services);
    expect(lines).toEqual([]);
    expect(t.said(lines)).not.toContain(SERVER_IPV4);

    const partial = await firstApp(freshFacts({ user: "deploy", privilege: "none" }));
    expect(await otherAppsLines(partial.deps, partial.plan, partial.services)).toEqual([]);
  });
});

describe("appWords", () => {
  it("names an app with its repository, when the record has one", () => {
    expect(appWords(secondAppRecord())).toBe('"inventory" (from github.com/example/inventory)');
    expect(appWords({ app: "archive" })).toBe('"archive"');
  });
});

describe("componentStatusReport of the first app", () => {
  it("lists the apps from other repositories on its server after its components", async () => {
    const plan = DeployPlanSchema.parse({
      ...testPlan({ deployed: true, domain: "shop.example.com" }),
      deployment: {
        ...testPlan({ deployed: true }).deployment,
        firstDeployAt: "2026-10-10T09:00:00.000Z",
      },
    });
    const project = await sharedServerProject({ plan });
    const deps = { ...project.deps, paths: project.first };
    const remote = (host: string): RemoteExec => ({
      host,
      run: async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const inspect = async () => createdServerFacts([secondAppRecord()]);
    const report = await componentStatusReport(deps, plan, {
      services: { remote, github: new FakeGitHub(), deploys: null, otherApps: { inspect } },
    });
    expect(report.lines).toContain(
      "Also on this server: inventory (github.com/example/inventory).",
    );
    const said = [...report.lines, deps.reporter.text(), JSON.stringify(deps.audit.entries)];
    expect(said.join("\n")).not.toContain(SERVER_IPV4);
    expect(said.join("\n")).not.toContain(project.firstKey);
  });
});

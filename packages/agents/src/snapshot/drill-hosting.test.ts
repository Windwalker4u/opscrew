// Feature 029 (T2935, research R25, R27): `opscrew restore --drill` on a hosting account, through
// the agent's `drill` request, with the cPanel fake; the agent's part is played by the test.
import { readFile } from "node:fs/promises";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  type AgentAnswer,
  type HostedApp,
  hostedApp,
  PANEL_TOKEN,
  playAgent,
} from "../hosting/__fixtures__/account";
import { recordObject } from "../hosting/record";
import { ScriptedApprovalHandler } from "../testing";
import { drillSnapshot } from "./drill";
import { drillOnHosting } from "./drill-hosting";
import { drillProves } from "./drill-report";
import { snapshotRun } from "./run";
import type { DrillRequest } from "./types";

const OLDER = "snapshot-20261117T120000Z";
const ID = "snapshot-20261118T120000Z";
const DRILL = "acct_notes_drill";

/** The plan with restore drills on. */
const withDrills = (plan: DeployPlan): DeployPlan =>
  DeployPlanSchema.parse({ ...plan, snapshots: { ...plan.snapshots, drills: {} } });

/** An app on a cPanel account with restore drills on, its drill database made, two snapshots kept. */
async function drillWorld(o: { drills?: boolean; made?: boolean } = {}): Promise<HostedApp> {
  const app = await hostedApp();
  const deps = await app.deps();
  if (o.drills !== false) await writeArtifact("plan", deps.paths.files.plan, withDrills(app.plan));
  if (o.made !== false) await recordObject(deps.paths, { kind: "drill-database", key: DRILL });
  for (const id of [OLDER, ID]) {
    app.account.write(`${app.folder}/dumps/${id}.sql.gz`, "dump");
    app.account.write(`${app.folder}/dumps/${id}.shared.tar.gz`, "copy");
  }
  return app;
}

/** The agent's answer to a drill: its record line, as `drill_snapshot` writes it. */
function drilling(result: string, fields: string, expected?: number): AgentAnswer {
  return (request) =>
    request.kind === "drill"
      ? `result=done\nrecord=2026-11-18T12:05:00Z manual ${result} id=${request.snapshot} start=2026-11-18T12:04:00Z ${fields} cleaned=no\n${expected === undefined ? "" : `expected=${expected}\n`}`
      : undefined;
}

const LOADED = drilling(
  "healthy",
  "parts=database:2048:3,files:4:0 tables=database:2 removal=removed reason=-",
  2,
);

/** One `opscrew restore --drill` on `app`, the agent answering with `answer`. */
async function drill(
  app: HostedApp,
  answer: AgentAnswer,
  request: DrillRequest = {},
  approve = true,
) {
  const handler = new ScriptedApprovalHandler(() => approve);
  const deps = await app.deps(handler);
  const agent = playAgent(app, answer);
  const run = await snapshotRun(deps);
  const outcome = await drillOnHosting(run, { sleep: agent.sleep }, request).then(
    (report) => ({ report, error: undefined }),
    (error: unknown) => ({
      report: undefined,
      error: error as Error & { code?: string; hint?: string },
    }),
  );
  return { deps, handler, agent, ...outcome };
}

describe("opscrew restore --drill on a hosting account", () => {
  it("asks the agent for a drill of the newest snapshot, bound to its approval, and says what it proves", async () => {
    const app = await drillWorld();
    const { deps, handler, agent, report, error } = await drill(app, LOADED);
    expect(error).toBeUndefined();

    // Approved like a destroy, with <app>-drill typed; the request is bound to that hash.
    expect(handler.requests).toHaveLength(1);
    const [approval] = handler.requests;
    expect(approval).toMatchObject({
      kind: "remote-exec",
      title: `Run a restore drill of the snapshot ${ID} of prod on the hosting account`,
      allowDestroy: true,
      confirmPhrase: "notes-drill",
    });
    expect(approval?.details).toContain(
      `The drill checks the snapshot ${ID} in ~/opscrew/notes-prod/dumps/ (${ID}.sql.gz and ${ID}.shared.tar.gz). The app itself isn't started`,
    );
    expect(approval?.details).toContain(
      `loaded into the drill database ${DRILL} only, every table and view in it dropped first; its tables are counted against the dump's (names and counts only, no row is read), then the drill database is emptied again.`,
    );
    expect(approval?.details).toContain("which has no right on the app's database");
    expect(approval?.details).toContain(`Drill hash: ${approval?.planHash}`);
    expect(agent.requests).toEqual([
      {
        kind: "drill",
        hash: approval?.planHash,
        expires: expect.stringMatching(/^\d+$/),
        snapshot: ID,
      },
    ]);

    expect(report).toEqual({
      id: ID,
      where: "on the hosting account (~/opscrew/notes-prod/dumps/)",
      outcome: "healthy",
      summary: `The snapshot ${ID}'s dump loaded with 2 tables; the app itself wasn't started. Its copy of the shared files is a valid archive.`,
      proves: drillProves("hosting", "notes"),
      parts: [
        { name: "database", size: 2048, seconds: 3 },
        { name: "files", size: 4, seconds: 0 },
      ],
      tables: [{ service: "database", count: 2 }],
      removal: "removed",
      ownLogins: [],
    });
    const said = deps.reporter.text();
    expect(said).toContain("step: Loaded the dump (2.0 KB) into the drill database in 3 seconds");
    expect(said).toContain("step: The drill database held 2 tables (the dump makes 2)");
    expect(said).toContain("step: Emptied the drill database again");
    expect(said).toContain(`success: ${report?.summary}`);
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({
        action: `ask the agent for a restore drill of the snapshot ${ID}`,
        target: approval?.planHash,
        decision: "approved",
        detail: "healthy",
      }),
    );

    // Leak check: the panel's token is nowhere OpsCrew wrote or showed.
    const record = await readFile(`${deps.paths.stateDir}/hosting.json`, "utf8");
    const shown = `${said}\n${JSON.stringify(deps.audit.entries)}\n${JSON.stringify(handler.requests)}\n${JSON.stringify(agent.requests)}\n${record}`;
    expect(shown).not.toContain(PANEL_TOKEN);
  });

  it("tells the user the backup is bad when the dump doesn't hold its tables", async () => {
    const app = await drillWorld();
    const short = drilling(
      "not-restored",
      "parts=database:2048:3 tables=database:1 removal=removed reason=tables",
      2,
    );
    const { deps, report } = await drill(app, short, { id: OLDER });
    expect(report).toMatchObject({ id: OLDER, outcome: "not-restored", reason: "tables" });
    expect(report?.summary).toBe(
      `The snapshot ${OLDER} did not restore: the drill database holds 1 table once the dump loaded, and the dump makes 2. The backup is bad: take a new snapshot now with \`opscrew snapshot\`.`,
    );
    expect(deps.reporter.text()).toContain(`warn: ${report?.summary}`);

    const broken = drilling("not-restored", "parts=- tables=- removal=- reason=dump");
    expect((await drill(app, broken)).report?.summary).toContain(
      "did not restore: its dump is empty or not a valid gzip file.",
    );
    const unemptied = drilling(
      "healthy",
      "parts=database:2048:3 tables=database:2 removal=failed reason=-",
      2,
    );
    expect((await drill(app, unemptied)).deps.reporter.text()).toContain(
      `warn: The agent could not empty the drill database ${DRILL} again, so it still holds the snapshot's data: run \`opscrew restore --drill\` again, which empties it first.`,
    );
  });

  it("drills a release's dump by its id, and the shared files alone of an app without a database", async () => {
    const app = await drillWorld();
    const dumpOnly = drilling(
      "healthy",
      "parts=database:12:0 tables=database:2 removal=removed reason=-",
      2,
    );
    const { handler, agent } = await drill(app, dumpOnly, { id: "790-1" });
    expect(agent.requests[0]).toMatchObject({ kind: "drill", snapshot: "790-1" });
    expect(handler.requests[0]?.details).toContain("(790-1.sql.gz)");
    expect(handler.requests[0]?.details).not.toContain("The shared files:");

    const plain = await hostedApp({ database: false });
    plain.account.write(`${plain.folder}/dumps/${ID}.shared.tar.gz`, "copy");
    const filesOnly = drilling("healthy", "parts=files:4:0 tables=- removal=- reason=-");
    const { report, error } = await drill(plain, filesOnly);
    expect(error).toBeUndefined();
    expect(report).toMatchObject({
      outcome: "healthy",
      summary: `The snapshot ${ID}'s copy of the shared files is a valid archive; the app itself wasn't started.`,
      proves: "the copy of the shared files is a valid archive; the app itself wasn't started",
    });
  });

  it("refuses, before anything is asked, what a hosting account can't drill", async () => {
    const app = await drillWorld();
    const keep = await drill(app, LOADED, { keep: true });
    expect(keep.error).toMatchObject({
      code: "INVALID_INPUT",
      message:
        "A drill on a hosting account leaves no copy to keep: it empties the drill database again at its end. Nothing was changed.",
    });
    expect((await drill(app, LOADED, { only: "db" })).error?.code).toBe("INVALID_INPUT");
    expect((await drill(app, LOADED, { allowOtherVersion: true })).error?.code).toBe(
      "INVALID_INPUT",
    );
    expect((await drill(app, LOADED, { remove: true })).error?.code).toBe("INVALID_INPUT");
    const nope = await drill(app, LOADED, { id: "nope" });
    expect(nope.error?.message).toBe(
      `The hosting account keeps no snapshot nope of prod; it keeps 777-2, 790-1, ${OLDER} and ${ID}. Nothing was changed.`,
    );
    expect(nope.handler.requests).toEqual([]);

    const off = await drill(await drillWorld({ drills: false, made: false }), LOADED);
    expect(off.error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Restore drills are off for prod: on a hosting account a drill loads the snapshot's dump into a database of its own, which OpsCrew makes once they are on. Nothing was changed.",
    });
    expect(off.error?.hint).toContain("Add `drills: {}` under `snapshots:` in opscrew/plan.yaml");
    const unmade = await drill(await drillWorld({ made: false }), LOADED);
    expect(unmade.error?.message).toContain(
      "The drill database isn't made on the hosting account yet",
    );

    // Only the releases' dumps, which the fixture's account keeps.
    const releases = await drillWorld();
    for (const file of [OLDER, ID].flatMap((id) => [`${id}.sql.gz`, `${id}.shared.tar.gz`])) {
      releases.account.remove(`${releases.folder}/dumps/${file}`);
    }
    const none = await drill(releases, LOADED);
    expect(none.error?.message).toBe(
      "The hosting account keeps no snapshot of prod that `opscrew snapshot` took, so there is nothing to drill; it keeps the releases' dumps 777-2 and 790-1, which a drill takes by id. Nothing was changed.",
    );
  });

  it("asks nothing of the agent without the approval, and reports the agent's refusal", async () => {
    const app = await drillWorld();
    const refused = await drill(app, LOADED, {}, false);
    expect(refused.error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(refused.error?.hint).toContain("--confirm notes-drill --approve");
    expect(refused.agent.requests).toEqual([]);

    const said = await drill(
      app,
      () =>
        "result=refused\nreason=restore drills are off here: keys/drill.cnf, the drill database's login, isn't there\n",
    );
    expect(said.error).toMatchObject({
      code: "COMMAND_FAILED",
      message:
        "The agent on the hosting account refused the drill of the snapshot snapshot-20261118T120000Z: restore drills are off here: keys/drill.cnf, the drill database's login, isn't there. Nothing was changed.",
    });
  });

  it("is refused on an SFTP host, which keeps no snapshots", async () => {
    const app = await hostedApp({ database: false });
    const deps = await app.deps();
    const sftp = DeployPlanSchema.parse({
      ...app.plan,
      target: {
        ...app.plan.target,
        panel: "sftp",
        cron: [],
        php: { version: "8.3", via: "account" },
      },
    });
    await writeArtifact("plan", deps.paths.files.plan, sftp);
    await expect(drillSnapshot(deps, undefined)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "prod is on an SFTP host, where no agent of OpsCrew's runs to take snapshots, so there is none to drill.",
      ),
    });
  });
});

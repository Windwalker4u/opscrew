/**
 * The live pass of OVHcloud (docs/e2e.md "OVHcloud", SC-3501, SC-3505, SC-3507):
 * `examples/flask-sqlite` on one `d2-2` in DE1 or GRA11, in the Public Cloud project the four
 * `OVH_*` variables name. OVHcloud bills it by the hour, so a run costs cents (about €0.0104 an
 * hour for the server, plus its snapshot at €0.011 per GB a month while it exists). The app is
 * named after the run, so nothing of an earlier run is ever taken for this one's. Steps, in order:
 * 1. the interview chooses OVHcloud from its four credentials alone;
 * 2. design: one `d2-2` in DE1 or GRA11, priced in EUR, with no provider backups;
 * 3. provision: one server, and no takeover;
 * 4. the first deploy, verify, status, and the app on its domain;
 * 5. a whole-server snapshot, billed per GB; 6. its restore, and verify again;
 * 7. secure and drift;
 * 8. destroy: the server gone, the snapshot named as what stays, then deleted by the test;
 * 9. none of the four values in any output, log, audit entry, state file or commit.
 * Whatever fails after provision, the cleanup still destroys the app and deletes the snapshot.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import type { ServerSnapshotApi } from "@opscrew/contracts";
import { cloudTarget } from "@opscrew/iac-templates";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import { describe, expect } from "vitest";
import { minutes } from "./cloud";
import { readValue, writeValue } from "./component-checks";
import { serverSnapshotId, takeoverLines, unsaid } from "./contabo-support";
import { AppEnvironments } from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import {
  approvedRestore,
  type DeployRun,
  deployLogLeaks,
  listSnapshots,
  snapshotOf,
} from "./snapshots-checks";
import { missingVariables } from "./support";

const ENV = process.env;
const GATE = "OPSCREW_E2E_OVHCLOUD";
/** OVHcloud's four variables, read by OpsCrew under these names, as a user's run does. */
const CREDENTIAL_VARIABLES = [
  "OVH_ENDPOINT",
  "OVH_CLIENT_ID",
  "OVH_CLIENT_SECRET",
  "OVH_CLOUD_PROJECT_SERVICE",
] as const;
/** The values the leak scan looks for: every one but the zone, `ovh-eu`, which OpsCrew's texts name. */
const SECRET_VARIABLES = ["OVH_CLIENT_ID", "OVH_CLIENT_SECRET", "OVH_CLOUD_PROJECT_SERVICE"];
const VARIABLES = [
  ...CREDENTIAL_VARIABLES,
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
];
/** The plan the pass runs, the smallest OpsCrew offers, and the locations it may run in. */
const PLAN = "d2-2";
const LOCATIONS = ["DE1", "GRA11"];
/** An app with its own SQLite file, whose value shows that the restore put the snapshot back. */
const EXAMPLE = "flask-sqlite";
const SETTINGS = { ...serverSettings(ENV), app: EXAMPLE };
const MISSING = [
  ...missingVariables(ENV, GATE, VARIABLES),
  ...(ENV.OVH_ENDPOINT === undefined || ENV.OVH_ENDPOINT === "ovh-eu"
    ? []
    : ["OVH_ENDPOINT=ovh-eu"]),
];
if (ENV[GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (OVHcloud): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "OVHcloud").`,
  );
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live OVHcloud (skipped: set ${MISSING.join(", ")}; see docs/e2e.md, "OVHcloud")`
    : `live OVHcloud: examples/${EXAMPLE} on one ${PLAN} in ${LOCATIONS.join(" or ")}`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "OVHcloud",
      name: "ovhcloud",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, "");
    const { log } = run;
    const credentials = Object.fromEntries(
      CREDENTIAL_VARIABLES.map((name) => [name, ENV[name]?.trim() ?? ""]),
    );
    for (const variable of SECRET_VARIABLES) run.scrubber.add(ENV[variable], variable);
    const app = `e2e-ovh-${run.runId}`;
    const before = `value-${run.runId}-before`;
    const after = `value-${run.runId}-after`;
    const deployRuns: DeployRun[] = [];
    const site = () => `https://${run.appHost}`;
    const ageKey = () => join(run.work, "age-key.txt");
    let serverId = "";
    let ipv4: string | undefined;
    /** The whole-server snapshot of step 5, until the test deletes it. */
    let snapshot = "";

    /** OVHcloud's server API through OpsCrew's own connector, with the four values. */
    function ovhcloud(): ServerSnapshotApi {
      const servers = cloudProvider("ovhcloud").connector({ env: credentials }).servers;
      if (servers === undefined) throw new Error("OpsCrew's OVHcloud connector has no server API.");
      return servers;
    }

    run.step(
      `1. examples/${EXAMPLE} named ${app}: init, analyze and the interview, which chooses OVHcloud from its four credentials alone`,
      minutes(15),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${EXAMPLE} on OVHcloud`,
          env: { ...credentials, CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
        });
        await envs.snapshotGithub();
        await run.initFix();
        await run.opscrewOk("analyze", "--no-ai");
        const file = run.paths().files.architecture;
        const architecture = await readArtifact("architecture", file);
        await writeArtifact("architecture", file, {
          ...architecture,
          facts: { ...architecture.facts, name: app },
        });
        const answers = join(run.work, "answers.json");
        // No provider: with only OVHcloud's credentials set, the interview chooses it.
        await writeFile(
          answers,
          JSON.stringify({
            expectedMonthlyUsers: "<1k",
            budgetMonthly: 20,
            region: "eu-central",
            uptime: "best-effort",
            dataCriticality: "important",
            dnsProvider: "cloudflare",
            domain: run.appHost,
            keepExternalServices: { s3: false },
          }),
        );
        await run.opscrewOk("interview", "--answers", answers);
        const requirements = await readArtifact("requirements", run.paths().files.requirements);
        expect(requirements.provider, "the provider the interview chose").toBe("ovhcloud");
      },
    );

    run.step(
      `2. design: one ${PLAN} in ${LOCATIONS.join(" or ")}, priced in EUR, with no OVHcloud backups`,
      minutes(10),
      async () => {
        await run.opscrewOk("design");
        const plan = await envs.designed("prod");
        expect(plan.app.name, "the app's name").toBe(app);
        const target = cloudTarget(plan.target);
        expect(
          { provider: target.provider, plan: target.serverType, backups: target.backups },
          "the server design planned",
        ).toEqual({ provider: "ovhcloud", plan: PLAN, backups: false });
        expect(LOCATIONS, "the location design chose").toContain(target.location);
        expect(plan.cost.monthly.currency, "the price's currency").toBe("EUR");
        await run.snapshotCloudflare(() => [run.appHost, `www.${run.appHost}`]);
        // The pass tests OVHcloud, not off-server copies, whose R2 bucket needs a key only the user
        // can make in Cloudflare's dashboard; the recovery copy still needs its age key.
        await run.opscrewOk("snapshot", "offsite", "off");
        const copies = join(run.work, "copies");
        await mkdir(copies, { recursive: true });
        await run.opscrewOk("secrets", "folder", copies);
        run.provisionFlags = ["--key-out", ageKey()];
        log(
          `observed: ${PLAN} in ${target.location} at ${plan.cost.monthly.amount} ${plan.cost.monthly.currency} a month (${plan.cost.source} prices)`,
        );
      },
    );

    run.step(
      "3. provision: one server in your Public Cloud project, its security group and SSH key, and the takeover found nothing",
      minutes(45),
      async () => {
        await run.adaptAndMerge();
        expect(
          await ovhcloud().findAppServers(app),
          "the app's servers at OVHcloud before provision",
        ).toEqual([]);
        envs.provisioned.add("prod");
        const output = await run.provisionUntilDone("provision");
        await envs.remember("prod");
        await run.rememberSecretFile(ageKey(), "age-identity");
        expect(takeoverLines(output), "provision's takeover notes").toEqual([]);
        const servers = await ovhcloud().findAppServers(app);
        expect(
          servers.map((server) => server.name),
          "the app's servers at OVHcloud",
        ).toEqual([app]);
        serverId = servers[0]?.id ?? "";
        ipv4 = (await readServerAddresses(run.paths())).deployment?.ipv4;
        expect(ipv4, "the server's address OpsCrew recorded").toBeDefined();
        log(`observed: server ${serverId} (${servers[0]?.status})`);
      },
    );

    run.step(
      "4. deploy, verify and status: the first deploy, and the app answers on its domain through Cloudflare",
      minutes(45),
      async () => {
        deployRuns.push({ what: "the first deploy", id: await run.deployAny("the first deploy") });
        await run.waitForHealth();
        await run.opscrewOk("verify");
        await run.opscrewOk("status");
        await writeValue(site(), before);
      },
    );

    run.step(
      "5. snapshot --server: a whole-server snapshot, billed per GB per month",
      minutes(30),
      async () => {
        const taken = await run.opscrewOk("snapshot", "--server");
        expect(unsaid(taken.output, ["per GB per month"]), "its price").toEqual([]);
        const id = serverSnapshotId(taken.output);
        if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(taken.output)}`);
        snapshot = id;
        const listed = snapshotOf(await listSnapshots(run), id);
        expect(listed.kind, "its kind").toBe("server");
        expect(listed.server?.name, "its server").toBe(app);
        log(`observed: the whole-server snapshot ${id}`);
      },
    );

    run.step(
      "6. restore --server <id> after the server's name typed: the same server and address, the snapshot's data back, and verify again",
      minutes(45),
      async () => {
        await writeValue(site(), after);
        const restored = await approvedRestore(run, ["--server", snapshot]);
        expect(restored.confirm, "the name the restore asks to type").toBe(app);
        expect(
          restored.applied.output.includes("and the app answers"),
          `the result says the app answers:\n${run.tail(restored.applied.output)}`,
        ).toBe(true);
        expect(
          (await ovhcloud().findAppServers(app)).map((server) => server.id),
          "the app's servers after the restore",
        ).toEqual([serverId]);
        expect(
          (await readServerAddresses(run.paths())).deployment?.ipv4,
          "the server's address after the restore",
        ).toBe(ipv4);
        await run.waitForHealth();
        await readValue(site(), before);
        await run.opscrewOk("verify");
      },
    );

    run.step(
      "7. secure and drift: the security group attached, the deploy key set, and no drift",
      minutes(20),
      async () => {
        const secure = await run.opscrew("secure");
        expect(secure.output, "secure's report").toContain("SECURITY_REPORT.md");
        const report = await readFile(run.paths().files.securityReport, "utf8");
        const { unattachedText, keylessText } = cloudProvider("ovhcloud").texts.secops;
        expect(
          [unattachedText, keylessText].filter((text) => report.includes(text)),
          "SECURITY_REPORT.md's findings on the server",
        ).toEqual([]);
        const drift = await run.opscrew("drift");
        expect(drift.exitCode, `opscrew drift:\n${run.tail(drift.output)}`).toBe(0);
      },
    );

    run.step(
      "8. destroy: the server deleted, the snapshot named as what stays and bills, nothing else left at OVHcloud or in Cloudflare; then the test deletes the snapshot",
      minutes(30),
      async () => {
        const from = run.outputs.size;
        await envs.destroy("prod");
        const output = [...run.outputs.values()].slice(from).join("\n");
        expect(unsaid(output, [`OVHcloud snapshot ${snapshot}`]), "what destroy said").toEqual([]);
        expect(await ovhcloud().findAppServers(app), "the app's servers at OVHcloud").toEqual([]);
        await run.expectCloudflareClean();
        await ovhcloud().deleteSnapshot(snapshot);
        log(
          `observed: the server ${serverId} deleted; the snapshot ${snapshot} deleted by the test`,
        );
        snapshot = "";
      },
    );

    run.step(
      "9. none of the OVHcloud values, nor any other secret, in any output, deploy job's log, audit entry, state file, plan or commit",
      minutes(10),
      async () =>
        run.expectNothingLeaked([
          ...(await envs.leaks({ cloudflare: true })),
          ...(await deployLogLeaks(run, deployRuns)),
        ]),
      { always: true },
    );

    envs.registerCleanup({
      last: async (attempt) => {
        if (run.appName === undefined) return;
        if (snapshot !== "") {
          const id = snapshot;
          await attempt(`delete the snapshot ${id} at OVHcloud`, () =>
            ovhcloud().deleteSnapshot(id),
          );
        }
        await attempt(`check that nothing of ${app} is left at OVHcloud`, async () => {
          const left = await ovhcloud().findAppServers(app);
          if (left.length > 0) {
            throw new Error(
              `OVHcloud still has ${left.map((server) => `${server.name} (${server.id})`).join(", ")}: delete it in the control panel (Public Cloud → your project → Compute → Instances).`,
            );
          }
        });
      },
    });
  },
);

/**
 * The live pass of Kamatera (docs/e2e.md "Kamatera", SC-3508, SC-3511, SC-3513):
 * `examples/flask-sqlite` on one `A-2-4` in EU-FR (Frankfurt), on the Kamatera account the two
 * `KAMATERA_API_*` variables reach. Kamatera bills it by the hour, counted by the minute, so a run
 * costs cents (about $0.026 an hour for the server, plus its snapshot at $0.05 per GB a month while
 * it exists). The app is named after the run, so nothing of an earlier run is ever taken for this
 * one's. Steps, in order:
 * 1. the interview chooses Kamatera from its two credentials alone;
 * 2. design: one `A-2-4` in EU-FR, priced in USD, with no provider backups;
 * 3. provision: one server, no takeover and no `<name>(n)` duplicate;
 * 4. the first deploy, verify, status, and the app on its domain;
 * 5. a whole-server snapshot, billed per GB; 6. its restore, and verify again;
 * 7. secure on the server's own firewall (cloud firewall: none; server firewall: on), and drift;
 * 8. a reboot through Kamatera, and secure again: the firewall's rules are kept;
 * 9. the run's snapshots deleted through Kamatera's API while the server exists (Kamatera reaches
 *    a snapshot only through its server), always;
 * 10. destroy: no server of the app and no `<name>(n)` duplicate left, nothing in Cloudflare;
 * 11. neither value in any output, log, audit entry, state file, plan or commit, and the root
 *     password Kamatera generated (which only the state holds) in none but the state.
 * Whatever fails after provision, the cleanup still destroys the app and fails the run on any
 * server or duplicate of it left at Kamatera.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import type { ServerSnapshotApi } from "@opscrew/contracts";
import { isRecord, readTextIfExists, tfstateFile } from "@opscrew/core";
import { selectEngine, stateKeyName, tofuEncryptionEnv } from "@opscrew/iac-engine";
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
const GATE = "OPSCREW_E2E_KAMATERA";
/** Kamatera's two variables, read by OpsCrew under these names, as a user's run does. */
const SECRET_VARIABLES = ["KAMATERA_API_CLIENT_ID", "KAMATERA_API_SECRET"] as const;
const VARIABLES = [
  ...SECRET_VARIABLES,
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
];
/**
 * The plan the pass runs and its datacenter. Design sizes 2 vCPU and 4 GB for 1,000 to 10,000
 * users a month, which the `A-2-4` holds with its 40 GB disk.
 */
const PLAN = "A-2-4";
const LOCATION = "EU-FR";
/** An app with its own SQLite file, whose value shows that the restore put the snapshot back. */
const EXAMPLE = "flask-sqlite";
const SETTINGS = { ...serverSettings(ENV), app: EXAMPLE };
const MISSING = missingVariables(ENV, GATE, VARIABLES);
if (ENV[GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (Kamatera): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Kamatera").`,
  );
}

/** The check `opscrew secure` runs on a server with no cloud firewall, as SECURITY_REPORT.md titles it. */
const FIREWALL_CHECK = "The server's own firewall lets in only what the plan allows";

/**
 * The scrubber's label of the root password Kamatera generated for the app's server: the engine's
 * state holds it by design (`generated_password`), and nothing else may.
 */
const ROOT_PASSWORD = "kamatera-root-password";

/** Each `generated_password` of a `kamatera_server` in the engine's `show -json` of the state. */
function generatedPasswords(shown: unknown): string[] {
  const out: string[] = [];
  const walk = (module: unknown) => {
    if (!isRecord(module)) return;
    for (const resource of Array.isArray(module.resources) ? module.resources : []) {
      if (!isRecord(resource) || resource.type !== "kamatera_server") continue;
      const password = isRecord(resource.values) ? resource.values.generated_password : undefined;
      if (typeof password === "string" && password !== "") out.push(password);
    }
    for (const child of Array.isArray(module.child_modules) ? module.child_modules : []) {
      walk(child);
    }
  };
  if (isRecord(shown) && isRecord(shown.values)) walk(shown.values.root_module);
  return out;
}

/**
 * The results SECURITY_REPORT.md gives the server's own firewall, one per server (`Pass`,
 * `**Fail**`, ...): its rows in the server checks' table.
 */
function firewallResults(report: string): string[] {
  return report
    .split(/\r?\n/)
    .filter((line) => line.includes(`| ${FIREWALL_CHECK} |`))
    .map((line) => line.split("|")[1]?.trim() ?? "");
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live Kamatera (skipped: set ${MISSING.join(", ")}; see docs/e2e.md, "Kamatera")`
    : `live Kamatera: examples/${EXAMPLE} on one ${PLAN} in ${LOCATION}`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "Kamatera",
      name: "kamatera",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, "");
    const { log } = run;
    const credentials: Record<string, string> = Object.fromEntries(
      SECRET_VARIABLES.map((name) => [name, ENV[name]?.trim() ?? ""]),
    );
    // Only to point OpsCrew at another address of Kamatera's API, as a user may.
    if (ENV.KAMATERA_API_URL !== undefined) credentials.KAMATERA_API_URL = ENV.KAMATERA_API_URL;
    for (const variable of SECRET_VARIABLES) run.scrubber.add(ENV[variable], variable);
    const app = `e2e-kam-${run.runId}`;
    const before = `value-${run.runId}-before`;
    const after = `value-${run.runId}-after`;
    const deployRuns: DeployRun[] = [];
    const site = () => `https://${run.appHost}`;
    const ageKey = () => join(run.work, "age-key.txt");
    let ipv4: string | undefined;
    /** The whole-server snapshot of step 5, which step 6 restores. */
    let snapshot = "";
    let api: ServerSnapshotApi | undefined;

    /**
     * Kamatera's server API through OpsCrew's own connector, with the two values, built on first
     * use. A server's id there is its name; `findAppServers` fails, naming it, on any `<name>(n)`
     * duplicate Kamatera made.
     */
    function kamatera(): ServerSnapshotApi {
      api ??= cloudProvider("kamatera").connector({ env: credentials }).servers;
      if (api === undefined) throw new Error("OpsCrew's Kamatera connector has no server API.");
      return api;
    }

    /**
     * Adds the root password Kamatera generated for the app's server to the scrubber, read from the
     * engine's state with `show -json`, decrypted with the passphrase the state has now (as the
     * harness reads the outputs). Nothing is printed from it. One it can't read is a finding, so
     * step 11 never passes without searching for it.
     */
    async function rememberRootPassword(): Promise<void> {
      const missed = (why: string) => {
        run.findings.push(`${why}, so the leak search misses Kamatera's root password`);
      };
      const plan = await run.readPlan();
      const engine = await selectEngine("auto", { env: run.env, runner: run.runner });
      const env = { ...run.env };
      const passphrase = run.paths().files.statePassphrase;
      if (engine.info.name === "tofu" && existsSync(passphrase)) {
        const state = await readTextIfExists(tfstateFile(run.paths()));
        env.TF_ENCRYPTION = tofuEncryptionEnv((await readFile(passphrase, "utf8")).trim(), {
          name: stateKeyName(state?.trim() ? state : undefined),
        });
      }
      const shown = await run.runner.run(engine.info.binary, ["show", "-json", "-no-color"], {
        cwd: join(run.repo, plan.infra.dir),
        env,
      });
      if (shown.exitCode !== 0)
        return missed(`${engine.info.name} show exited with ${shown.exitCode}`);
      let passwords: string[];
      try {
        passwords = generatedPasswords(JSON.parse(shown.stdout));
      } catch {
        return missed(`${engine.info.name} show printed no JSON`);
      }
      if (passwords.length === 0)
        return missed("the state has no kamatera_server generated_password");
      for (const password of passwords) run.scrubber.add(password, ROOT_PASSWORD);
      rootPasswords.push(...passwords);
      log("observed: Kamatera's root password read from the state, for the leak search");
    }

    /** Kamatera's root passwords read from the state, for the plan sidecars' own search. */
    const rootPasswords: string[] = [];

    /** The plan sidecars (`*.json` in the plans folder) that carry one of `rootPasswords`. */
    async function sidecarsWithPassword(): Promise<string[]> {
      const dir = run.paths().files.plansDir;
      if (!existsSync(dir)) return [];
      const found: string[] = [];
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".json")) continue;
        const text = await readFile(join(dir, name), "utf8");
        if (rootPasswords.some((password) => text.includes(password))) found.push(name);
      }
      return found;
    }

    /** Runs `opscrew secure` and gives SECURITY_REPORT.md. */
    async function secureReport(): Promise<string> {
      const secure = await run.opscrew("secure");
      expect(secure.output, "secure's report").toContain("SECURITY_REPORT.md");
      return readFile(run.paths().files.securityReport, "utf8");
    }

    run.step(
      `1. examples/${EXAMPLE} named ${app}: init, analyze and the interview, which chooses Kamatera from its two credentials alone`,
      minutes(15),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${EXAMPLE} on Kamatera`,
          env: { ...credentials, CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
          // Only Kamatera's credentials, so the interview has no other provider to choose.
          drop: [
            "CNTB_OAUTH2_CLIENT_ID",
            "CNTB_OAUTH2_CLIENT_SECRET",
            "CNTB_OAUTH2_USER",
            "CNTB_OAUTH2_PASS",
            "OVH_ENDPOINT",
            "OVH_CLIENT_ID",
            "OVH_CLIENT_SECRET",
            "OVH_CLOUD_PROJECT_SERVICE",
          ],
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
        // No provider: with only Kamatera's credentials set, the interview chooses it.
        await writeFile(
          answers,
          JSON.stringify({
            expectedMonthlyUsers: "1k-10k",
            budgetMonthly: 25,
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
        expect(requirements.provider, "the provider the interview chose").toBe("kamatera");
      },
    );

    run.step(
      `2. design: one ${PLAN} in ${LOCATION}, priced in USD, with no Kamatera backups`,
      minutes(10),
      async () => {
        await run.opscrewOk("design");
        const plan = await envs.designed("prod");
        expect(plan.app.name, "the app's name").toBe(app);
        const target = cloudTarget(plan.target);
        expect(
          {
            provider: target.provider,
            plan: target.serverType,
            location: target.location,
            backups: target.backups,
          },
          "the server design planned",
        ).toEqual({ provider: "kamatera", plan: PLAN, location: LOCATION, backups: false });
        expect(plan.cost.monthly.currency, "the price's currency").toBe("USD");
        await run.snapshotCloudflare(() => [run.appHost, `www.${run.appHost}`]);
        // The pass tests Kamatera, not off-server copies, whose R2 bucket needs a key only the user
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
      "3. provision: one server named after the app, no takeover and no duplicate Kamatera renamed",
      minutes(60),
      async () => {
        await run.adaptAndMerge();
        expect(
          await kamatera().findAppServers(app),
          "the app's servers at Kamatera before provision",
        ).toEqual([]);
        envs.provisioned.add("prod");
        const output = await run.provisionUntilDone("provision");
        await envs.remember("prod");
        await rememberRootPassword();
        await run.rememberSecretFile(ageKey(), "age-identity");
        expect(takeoverLines(output), "provision's takeover notes").toEqual([]);
        // Fails, naming it, on a `<app>(n)` duplicate.
        const servers = await kamatera().findAppServers(app);
        expect(
          servers.map((server) => server.name),
          "the app's servers at Kamatera",
        ).toEqual([app]);
        ipv4 = (await readServerAddresses(run.paths())).deployment?.ipv4;
        expect(ipv4, "the server's address OpsCrew recorded").toBeDefined();
        log(`observed: server ${app} (${servers[0]?.status})`);
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
        const taken = await run.opscrewWithin(minutes(25), "snapshot", "--server");
        if (taken.exitCode !== 0) {
          throw new Error(
            `opscrew snapshot --server exited with ${taken.exitCode}:
${run.tail(taken.output)}`,
          );
        }
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
          (await kamatera().findAppServers(app)).map((server) => server.name),
          "the app's servers after the restore",
        ).toEqual([app]);
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
      "7. secure and drift: the server's own firewall as the plan says (cloud firewall: none; server firewall: on), the deploy key set, and no drift",
      minutes(20),
      async () => {
        const report = await secureReport();
        expect(firewallResults(report), "secure's check of the server's own firewall").toEqual([
          "Pass",
        ]);
        const { unattachedText, keylessText } = cloudProvider("kamatera").texts.secops;
        expect(
          [unattachedText, keylessText].filter((text) => report.includes(text)),
          "SECURITY_REPORT.md's findings on the server",
        ).toEqual([]);
        const drift = await run.opscrew("drift");
        expect(drift.exitCode, `opscrew drift:\n${run.tail(drift.output)}`).toBe(0);
      },
    );

    run.step(
      "8. a reboot through Kamatera: the app answers again, and secure finds the firewall's rules kept",
      minutes(30),
      async () => {
        const servers = kamatera();
        if (servers.restart === undefined) {
          throw new Error("OpsCrew's Kamatera connector can't restart a server.");
        }
        await servers.restart(app);
        log(`observed: the server ${app} rebooted`);
        await run.waitForHealth();
        await readValue(site(), before);
        expect(
          firewallResults(await secureReport()),
          "secure's check of the server's own firewall after the reboot",
        ).toEqual(["Pass"]);
      },
    );

    run.step(
      "9. the run's whole-server snapshots deleted through Kamatera's API while the server exists",
      minutes(30),
      async () => {
        // Provision didn't finish: no server, so no snapshot of it either.
        if ((await kamatera().findAppServers(app)).length === 0) return;
        for (const { id } of await kamatera().listSnapshots(app)) {
          await kamatera().deleteSnapshot(id);
          log(`observed: the snapshot ${id} deleted by the test`);
        }
        expect(await kamatera().listSnapshots(app), "the server's snapshots").toEqual([]);
      },
      { always: true },
    );

    run.step(
      "10. destroy: the server terminated, no duplicate of it, nothing else left at Kamatera or in Cloudflare",
      minutes(45),
      async () => {
        await envs.destroy("prod");
        // Fails, naming it, on a `<app>(n)` duplicate.
        expect(await kamatera().findAppServers(app), "the app's servers at Kamatera").toEqual([]);
        await run.expectCloudflareClean();
        log(`observed: the server ${app} terminated, and no server or duplicate of the app left`);
      },
    );

    run.step(
      "11. neither Kamatera value, nor any other secret, in any output, deploy job's log, audit entry, state file, plan or commit, and Kamatera's root password only in the state",
      minutes(10),
      async () => {
        // A plan's JSON sidecar masks the root password (`ALWAYS_MASKED`). The harness searches
        // every file under the plans folder as state, which `inState` exempts, so the sidecars
        // are searched here on their own.
        expect(await sidecarsWithPassword(), "plan sidecars with Kamatera's root password").toEqual(
          [],
        );
        return run.expectNothingLeaked([
          // Kamatera's provider reads both values from the environment: neither is in a state
          // file. The root password it generates is, by design (and in a binary plan file, which
          // holds the state), and OpsCrew never reads or shows it: it is searched for everywhere
          // else.
          ...(await envs.leaks({ cloudflare: true, inState: [ROOT_PASSWORD] })),
          ...(await deployLogLeaks(run, deployRuns)),
        ]);
      },
      { always: true },
    );

    envs.registerCleanup({
      last: async (attempt) => {
        if (run.appName === undefined) return;
        await attempt(`check that nothing of ${app} is left at Kamatera`, async () => {
          // Fails, naming each, on a `<app>(n)` duplicate.
          const left = await kamatera().findAppServers(app);
          if (left.length > 0) {
            throw new Error(
              `Kamatera still has ${left.map((server) => server.name).join(", ")}: terminate it in Kamatera's console, after deleting its snapshots there.`,
            );
          }
        });
      },
    });
  },
);

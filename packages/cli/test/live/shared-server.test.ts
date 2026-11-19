/**
 * Feature 030's live pass L1, the throwaway pair (plan.md 15.; docs/e2e.md "A second app on a
 * server OpsCrew created"), with `OPSCREW_E2E_SHARED_SERVER=1`: in `OPSCREW_E2E_GITHUB_REPO_C`,
 * the seeded `examples/koa-knex` is the first app, on a throwaway Hetzner CX23 behind Cloudflare
 * at `j030-<tag>-first.<zone>`; `examples/express-api`, added with `opscrew app add`, joins its
 * server at `j030-<tag>-second.<zone>`. A request every second against the first app's site runs
 * through the second app's provision, first deploy and destroy (SC-3002); `deploy`'s
 * `authorized_keys` is the same, line by line, before the join and after the destroy (SC-3003);
 * provision again shows no changes and neither app drifts (SC-3005); the first app's harmful
 * commands refuse with nothing changed (SC-3004); the second app's data is snapshotted and
 * restored; the first app deploys and its check passes after the second app is gone; then the
 * first app's destroy and the leak search (SC-3006). Names never start with `e2e-`, which 029's
 * passes use, and every cleanup matches only the run's own names: the Hetzner project also holds
 * production servers.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { APPS_DIR, checkEnvironmentKey } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import {
  type CloudflareZone,
  hetznerAppFirewallRules,
  hetznerAppServers,
  minutes,
  waitFor,
} from "./cloud";
import { AppEnvironments, acceptOriginPullBlips, secretsRecord } from "./environment-checks";
import { destroyConfirmArgs, EXAMPLES, LiveRun, serverSettings } from "./harness";
import { dispatchCheck } from "./observability-checks";
import { issueKey } from "./observability-support";
import { previewPage } from "./previews-checks";
import { e2eOverlay, PREVIEW_VALUE } from "./previews-support";
import { composeProjectOf, inContainer, psql } from "./retarget-anywhere-support";
import {
  addressLeaks,
  dnsFacts,
  FIRST_EXAMPLE,
  factDigests,
  keptRate,
  keyLineDigests,
  loadSummary,
  otherAppRefused,
  REQUESTS_PER_SECOND,
  SECOND_EXAMPLE,
  SERVER_TYPE,
  SHARED_SERVER_GATE,
  SHARED_SERVER_VARIABLES,
  sharedHosts,
  sharedNames,
  sortedLines,
} from "./shared-server-support";
import { approvedRestore, listSnapshots } from "./snapshots-checks";
import {
  approveHashes,
  type LoadFailure,
  leakedLabels,
  missingVariables,
  steadyLoad,
} from "./support";

const MISSING = missingVariables(process.env, SHARED_SERVER_GATE, SHARED_SERVER_VARIABLES);
/** Both apps in the public throwaway repository C; the first app's example names the run. */
const SETTINGS = {
  ...serverSettings(process.env),
  githubRepo: process.env.OPSCREW_E2E_GITHUB_REPO_C?.trim() ?? "",
  app: FIRST_EXAMPLE,
};
/** The test's own table in the second app's PostgreSQL, for its snapshot and restore. */
const TABLE = "j030_rows";

if (process.env[SHARED_SERVER_GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (a second app on a created server): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "A second app on a server OpsCrew created").`,
  );
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live second app on a created server (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live second app on a created server: examples/${FIRST_EXAMPLE} at Hetzner, examples/${SECOND_EXAMPLE} beside it`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "a second app on a created server",
      name: "j030",
      settings: SETTINGS,
      afterCli: async () => {
        await first.rememberServers();
        await second.rememberServers();
      },
    });
    const { log } = run;
    const NAMES = sharedNames(run.runId);
    const hosts = () => sharedHosts(SETTINGS.domain, NAMES.tag);
    const first = new AppEnvironments(run, SETTINGS.hcloudToken, { firstOfSeveral: true });
    const second = new AppEnvironments(run, SETTINGS.hcloudToken, { app: NAMES.secondApp });
    /** `deploy`'s `authorized_keys` before the second app joined, by the SHA-256 of each line. */
    let keysBefore: string[] | undefined;
    /** The first app's server at Hetzner, by id, once it runs. */
    let firstServers: number[] = [];
    /** Each load's figures, for docs/e2e-coverage.md. */
    const loads: string[] = [];

    const firstHealth = async () =>
      `https://${hosts().firstHost}${(await first.readPlan()).app.healthPath}`;
    const serverIds = async (app: string) =>
      (await hetznerAppServers(SETTINGS.hcloudToken, app)).map((server) => server.id);
    const addresses = () =>
      run.scrubber.entries().filter((entry) => entry.label.startsWith("server-"));

    /** The first app's page answers through Cloudflare with the marker of `main`. */
    async function expectFirstAnswering(after: string): Promise<void> {
      await run.waitForHealth(minutes(5), true, await firstHealth());
      expect(
        await previewPage(`https://${hosts().firstHost}`),
        `the first app's page after ${after}`,
      ).toMatchObject({ marker: "main", viaCloudflare: true });
      log(`observed: the first app answers after ${after}`);
    }

    /** `deploy`'s `authorized_keys`, read through the first app's deploy login: line digests only. */
    async function keyDigests(): Promise<string[]> {
      const read = await (await first.shell()).run("cat ~/.ssh/authorized_keys");
      if (read.exitCode !== 0) {
        throw new Error(`deploy's authorized_keys could not be read (exit ${read.exitCode}).`);
      }
      return keyLineDigests(read.stdout);
    }

    /**
     * What the first app's refused commands must leave as it was, each part by its digest: both
     * plans and the checkout; on the server `authorized_keys`, the containers and the apps'
     * folders; at Hetzner the first app's server and firewall; at Cloudflare both apps' records.
     */
    async function firstAppFacts(): Promise<Record<string, string>> {
      const shell = await first.shell();
      const { firstHost, secondHost } = hosts();
      return factDigests({
        "the first app's plan": await readFile(first.paths().files.plan, "utf8"),
        "the second app's plan": await readFile(second.paths().files.plan, "utf8"),
        "the checkout": await run.git("status", "--porcelain"),
        "deploy's authorized_keys": (await keyDigests()).join("\n"),
        "the containers": sortedLines(
          await shell.ok("docker ps --format '{{.Names}} {{.Image}} {{.State}}'"),
        ),
        "the apps' folders": sortedLines(await shell.ok(`ls -1 ${APPS_DIR}`)),
        "the first app's servers at Hetzner": JSON.stringify(
          (await hetznerAppServers(SETTINGS.hcloudToken, NAMES.firstApp)).map((server) => [
            server.id,
            server.server_type?.name,
          ]),
        ),
        "its firewall rules at Hetzner": JSON.stringify(
          await hetznerAppFirewallRules(SETTINGS.hcloudToken, NAMES.firstApp),
        ),
        "both apps' DNS records": dnsFacts(
          await run.cloudflare.zoneRecords(run.zone as CloudflareZone),
          [firstHost, secondHost],
        ),
      });
    }

    /**
     * The first app's command `args` refuses while the second app is on its server: exit ≠ 0, the
     * refusal naming the second app, no server address in it, and nothing changed. With `change`,
     * the first app's plan is edited first, as a user does (and put back after the run, once it is
     * checked that OpsCrew left it as written).
     */
    async function expectRefused(
      what: string,
      args: readonly string[],
      change?: (plan: DeployPlan) => DeployPlan,
    ): Promise<void> {
      const before = await firstAppFacts();
      const file = first.paths().files.plan;
      const original = await readFile(file, "utf8");
      let written: string | undefined;
      let left = true;
      let refused: Awaited<ReturnType<typeof run.opscrew>>;
      try {
        if (change !== undefined) {
          await writeArtifact("plan", file, change(await first.readPlan()));
          written = await readFile(file, "utf8");
        }
        refused = await run.opscrew(...args);
        if (written !== undefined) left = (await readFile(file, "utf8")) === written;
      } finally {
        if (change !== undefined) await writeFile(file, original);
      }
      expect(left, `${what}: the first app's plan as the test wrote it`).toBe(true);
      expect(refused.exitCode, `${what}: the exit code`).not.toBe(0);
      expect(
        otherAppRefused(refused.output, NAMES.secondApp),
        `${what}: the refusal naming "${NAMES.secondApp}":\n${run.tail(refused.output)}`,
      ).toBe(true);
      expect(
        leakedLabels(refused.output, addresses()),
        `${what}: addresses in the refusal`,
      ).toEqual([]);
      expect(await firstAppFacts(), `what ${what} must leave as it was`).toEqual(before);
      log(`observed: ${what} refused, naming "${NAMES.secondApp}"; nothing changed`);
    }

    /**
     * Runs `body` under a request every second against the first app's health route through
     * Cloudflare (SC-3002), and fails when any counted: Cloudflare's brief 52x answers while an
     * origin pull setting rolls out are accepted, as the founder accepted them (logged with their
     * reason). The figures are kept for the coverage page.
     */
    async function underLoad<T>(what: string, body: () => Promise<T>): Promise<T> {
      const url = await firstHealth();
      const statuses: Record<string, number> = {};
      log(`${what}: sending ${REQUESTS_PER_SECOND} request a second to the first app's site`);
      const startedAt = Date.now();
      const load = steadyLoad(
        async () => {
          const answer = await fetch(url, {
            headers: { "User-Agent": "opscrew-e2e" },
            signal: AbortSignal.timeout(10_000),
          });
          await answer.arrayBuffer();
          statuses[answer.status] = (statuses[answer.status] ?? 0) + 1;
          return answer.status;
        },
        REQUESTS_PER_SECOND,
        (failure) => log(`${what}: the request sent at ${failure.at} failed: ${failure.what}`),
      );
      let result: T;
      let outcome: { sent: number; failures: LoadFailure[] };
      try {
        result = await body();
      } finally {
        outcome = await load.stop();
      }
      const seconds = (Date.now() - startedAt) / 1000;
      const accept = acceptOriginPullBlips(run, log);
      const counted: LoadFailure[] = [];
      let accepted = 0;
      for (const failure of outcome.failures) {
        const reason = await accept(failure);
        if (reason === undefined) counted.push(failure);
        else {
          accepted++;
          log(`${what}: the request sent at ${failure.at} is accepted: ${reason}`);
        }
      }
      const line = loadSummary(what, { sent: outcome.sent, seconds, statuses, counted, accepted });
      loads.push(line);
      log(`observed: ${line}`);
      expect(counted, `requests to the first app's site that failed during ${what}`).toEqual([]);
      expect(
        keptRate(outcome.sent, seconds),
        `requests sent in ${Math.round(seconds)} s (at least 90% of ${REQUESTS_PER_SECOND} a second)`,
      ).toBe(true);
      return result;
    }

    run.step(
      `1. the first app, examples/${FIRST_EXAMPLE} with a seed, named after the run, deployed on a throwaway Hetzner ${SERVER_TYPE} behind Cloudflare at its own hostname`,
      minutes(60),
      async () => {
        const { firstHost } = hosts();
        const overlay = await mkdtemp(join(tmpdir(), "opscrew-e2e-j030-overlay-"));
        try {
          const index = await readFile(join(EXAMPLES, FIRST_EXAMPLE, "index.js"), "utf8");
          for (const [path, text] of Object.entries(e2eOverlay(index))) {
            const file = join(overlay, FIRST_EXAMPLE, path);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, text);
          }
          await run.prepareRepo({
            commit: `e2e: examples/${FIRST_EXAMPLE} with a seed and examples/${SECOND_EXAMPLE}, for one server`,
            env: {
              HCLOUD_TOKEN: SETTINGS.hcloudToken,
              CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
            },
            folders: { [FIRST_EXAMPLE]: FIRST_EXAMPLE, [SECOND_EXAMPLE]: SECOND_EXAMPLE },
            overlay,
          });
          // The page reads the previews' value, so every environment is asked for one.
          await appendFile(join(run.work, "production.env"), `${PREVIEW_VALUE}=prod\n`);
        } finally {
          await rm(overlay, { recursive: true, force: true });
        }
        await first.snapshotGithub();
        await second.snapshotGithub();
        await run.initFix();
        await run.opscrewOk("analyze", "--no-ai", "--dir", FIRST_EXAMPLE);
        // The app is named after the run, so its servers' labels and names are the run's alone.
        const architecture = run.paths().files.architecture;
        const facts = await readArtifact("architecture", architecture);
        await writeArtifact("architecture", architecture, {
          ...facts,
          facts: { ...facts.facts, name: NAMES.firstApp },
        });
        const answers = join(run.work, "answers-first.json");
        await writeFile(
          answers,
          JSON.stringify({
            provider: "hetzner",
            expectedMonthlyUsers: "<1k",
            budgetMonthly: 20,
            region: SETTINGS.region,
            uptime: "best-effort",
            dataCriticality: "important",
            dnsProvider: "cloudflare",
            domain: firstHost,
            keepExternalServices: { s3: false },
          }),
        );
        await run.opscrewOk("interview", "--answers", answers);
        await run.opscrewOk("design");
        const designed = await first.designed("prod");
        expect(designed.app.name, "the first app's name").toBe(NAMES.firstApp);
        if (designed.target.provider !== "hetzner") {
          throw new Error(`design planned ${designed.target.provider}, not Hetzner.`);
        }
        expect(designed.dns.proxied, "the first app behind Cloudflare's proxy").toBe(true);
        log(
          `observed: design chose ${designed.target.serverType}; the plan now says ${SERVER_TYPE}`,
        );
        // As a user edits opscrew/plan.yaml: the small server the pass is about.
        await writeArtifact("plan", first.paths().files.plan, {
          ...designed,
          target: { ...designed.target, serverType: SERVER_TYPE },
        });
        await run.snapshotCloudflare(() => [firstHost, `www.${firstHost}`]);
        await run.adaptAndMerge();
        await first.provision("prod", "the first app");
        await run.deployAny("the first app's first deploy");
        await expectFirstAnswering("its first deploy");
        await run.opscrewOk("verify", "--app", ".");
        const servers = await hetznerAppServers(SETTINGS.hcloudToken, NAMES.firstApp);
        expect(
          servers.map((server) => server.server_type?.name),
          "the first app's servers at Hetzner",
        ).toEqual([SERVER_TYPE]);
        firstServers = servers.map((server) => server.id);
      },
    );

    run.step(
      `2. the second app, examples/${SECOND_EXAMPLE} added with app add, joins the first app's server: interview (server.shares), design, provision and its first deploy, a request every second against the first app's site throughout`,
      minutes(75),
      async () => {
        const { secondHost } = hosts();
        const key = NAMES.secondApp;
        keysBefore = await keyDigests();
        log(`deploy's authorized_keys before the join: ${keysBefore.length} line(s)`);
        await run.opscrewOk("app", "add", key, "--dir", SECOND_EXAMPLE);
        await run.opscrewOk("analyze", "--no-ai", "--app", key);
        const answers = join(run.work, "answers-second.json");
        await writeFile(
          answers,
          JSON.stringify({
            provider: "own",
            "server.shares": run.repo,
            "server.shares-app": ".",
            expectedMonthlyUsers: "<1k",
            budgetMonthly: 20,
            uptime: "best-effort",
            dataCriticality: "important",
            dnsProvider: "cloudflare",
            domain: secondHost,
          }),
        );
        await run.opscrewOk("interview", "--app", key, "--answers", answers);
        await run.opscrewOk("design", "--app", key);
        const plan = await second.designed("prod");
        expect(plan.app.name, "the second app's name").toBe(key);
        expect(plan.target, "the second app's target").toMatchObject({
          provider: "own",
          shares: { app: NAMES.firstApp, provider: "hetzner" },
        });
        expect(plan.dns, "the second app's hostname, behind Cloudflare's proxy").toMatchObject({
          domain: secondHost,
          proxied: true,
        });
        // A second app is an own-server app: for data that matters, design proposes an encrypted
        // copy of its snapshots off the server, whose key the recovery copy holds, and a public
        // repository's recovery copy isn't committed without asking. The off-server copies have
        // passes of their own (snapshots.test.ts), so this one keeps the snapshots on the server.
        if (plan.snapshots?.offsite !== undefined) {
          await run.opscrewOk("snapshot", "offsite", "off", "--app", key);
        }
        await run.opscrewOk("adapt", "--app", key, "--no-ai", "--yes");
        const pull = await run.github.openPullRequest(`opscrew/prepare-deploy-${key}`);
        if (pull === undefined) throw new Error("adapt --app opened no pull request.");
        log(`merging the second app's adapt pull request #${pull}`);
        await run.github.merge(pull);
        await run.checkoutMain();

        await underLoad("the second app's provision and first deploy", async () => {
          await second.provision("prod", "the second app");
          const deployed = await run.deploy("the second app's first deploy", [
            posix.basename(plan.cicd.workflowPath),
          ]);
          if (deployed === undefined) {
            throw new Error("The second app's provision opened no deploy-setup pull request.");
          }
        });
        await run.waitForHealth(minutes(10), true, `https://${secondHost}${plan.app.healthPath}`);
        await run.opscrewOk("verify", "--app", key);
        expect(await serverIds(key), "servers of the second app's own at Hetzner").toEqual([]);
        expect(await serverIds(NAMES.firstApp), "the first app's server at Hetzner").toEqual(
          firstServers,
        );
        await expectFirstAnswering("the second app's first deploy");
      },
    );

    run.step(
      "3. the second app's provision again shows no changes, and drift of both apps finds nothing (SC-3005)",
      minutes(20),
      async () => {
        const planned = await run.opscrewOk(
          "provision",
          "--app",
          NAMES.secondApp,
          "--plan-only",
          "--yes",
        );
        expect(
          approveHashes(planned.output),
          `nothing to approve:\n${run.tail(planned.output)}`,
        ).toEqual([]);
        expect(
          /Nothing to apply/.test(planned.output),
          `nothing to apply:\n${run.tail(planned.output)}`,
        ).toBe(true);
        // `app add` left the first app's deploy workflow as rendered for a repository with one app:
        // its next provision leaves the second app's folder out of the paths it deploys on (an app
        // from another repository has no such change). It also shows the first app's provision and
        // deploy beside the second app, with no look at the server for a change that harms none.
        await first.provision("prod", "the first app again, beside the second app");
        await run.deployAny("the first app's deploy with its updated workflow");
        await expectFirstAnswering("its deploy beside the second app");
        await run.opscrewOk("drift", "--app", ".");
        await run.opscrewOk("drift", "--app", NAMES.secondApp);
        log("observed: no changes for the second app, no drift in either");
      },
    );

    run.step(
      "4a. the first app's destroy is refused before any change, naming the second app",
      minutes(15),
      async () => {
        const plan = await first.readPlan();
        await expectRefused("the first app's destroy", [
          "destroy",
          "--app",
          ".",
          ...destroyConfirmArgs(plan),
          "--no-snapshot",
        ]);
      },
    );

    run.step(
      "4b. the first app's secure --close-public-ssh is refused before any change, naming the second app",
      minutes(15),
      async () => {
        await expectRefused("closing the first app's public SSH", [
          "secure",
          "--app",
          ".",
          "--close-public-ssh",
        ]);
      },
    );

    run.step(
      "4c. the first app's switch from proxied to DNS only (provision --plan-only) is refused before any change, naming the second app",
      minutes(15),
      async () => {
        await expectRefused(
          "the first app's switch to DNS only",
          ["provision", "--app", ".", "--plan-only", "--yes"],
          (plan) => ({ ...plan, dns: { ...plan.dns, proxied: false } }),
        );
      },
    );

    run.step(
      "4d. the first app's retarget is refused before any change, naming the second app",
      minutes(15),
      async () => {
        await expectRefused("the first app's retarget", [
          "retarget",
          "--app",
          ".",
          "--to",
          "contabo",
        ]);
      },
    );

    run.step(
      "5. a snapshot of the second app's data, a change, and the restore that puts the snapshot back; the first app keeps answering",
      minutes(30),
      async () => {
        const key = NAMES.secondApp;
        const plan = await second.readPlan();
        const database = plan.services.find((service) => service.kind === "postgres")?.name;
        if (database === undefined) throw new Error("The second app's plan has no PostgreSQL.");
        const sql = (statement: string) =>
          waitFor(
            `PostgreSQL of ${key} answering`,
            minutes(5),
            async () =>
              (await first.shell()).ok(
                inContainer(composeProjectOf(plan), database, psql(statement)),
              ),
            10_000,
          );
        await sql(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (label text); DELETE FROM ${TABLE}; INSERT INTO ${TABLE} VALUES ('before')`,
        );
        const earlier = (await listSnapshots(run, ["--app", key])).map((item) => item.id);
        await run.opscrewOk("snapshot", "--app", key);
        const taken = (await listSnapshots(run, ["--app", key])).find(
          (item) => !earlier.includes(item.id),
        );
        if (taken === undefined) throw new Error("opscrew snapshot --app listed no new snapshot.");
        await sql(`INSERT INTO ${TABLE} VALUES ('after')`);
        const restored = await approvedRestore(run, ["--app", key, taken.id]);
        expect(restored.confirm, "the name the restore asks to be typed").toBe(key);
        expect(await sql(`SELECT label FROM ${TABLE} ORDER BY label`), "the rows restored").toBe(
          "before",
        );
        await run.waitForHealth(
          minutes(5),
          true,
          `https://${hosts().secondHost}${plan.app.healthPath}`,
        );
        await expectFirstAnswering("the second app's restore");
      },
    );

    run.step(
      "6. the second app's destroy under the load: deploy's authorized_keys holds exactly its lines from before the join (SC-3003), nothing of the second app is left, and the first app deploys and its scheduled check passes",
      minutes(60),
      async () => {
        const record = await secretsRecord(second.paths());
        await underLoad("the second app's destroy", () => second.destroy("prod"));
        if (keysBefore === undefined) throw new Error("Step 2 read no authorized_keys.");
        expect(
          await keyDigests(),
          "deploy's authorized_keys after the second app's destroy, line by line (SHA-256 of each)",
        ).toEqual(keysBefore);
        if (record !== undefined) await second.expectSecretsGone("prod", record);
        const { secondHost } = hosts();
        expect(
          dnsFacts(await run.cloudflare.zoneRecords(run.zone as CloudflareZone), [secondHost]),
          "the second app's DNS records",
        ).toBe("");
        expect(await serverIds(NAMES.firstApp), "the first app's server at Hetzner").toEqual(
          firstServers,
        );
        await expectFirstAnswering("the second app's destroy");
        await run.deployMain("the first app's deploy after the second app's destroy");
        await expectFirstAnswering("its deploy");
        await dispatchCheck(
          run.github,
          (...args) => run.git(...args),
          "the first app after the second app's destroy",
          log,
        );
        const checkKey = checkEnvironmentKey(await first.readPlan());
        const open = (await run.github.checkIssues(run.startedAt)).filter(
          (issue) => issue.open && issueKey(issue.body)?.startsWith(`${checkKey}/`) === true,
        );
        expect(
          open.map((issue) => issue.title),
          "the check's open issues for the first app",
        ).toEqual([]);
      },
    );

    run.step(
      "7. the first app's destroy: refused while the second app's data is kept on the server, then with --skip-other-apps-check; nothing of either app left at Hetzner or in Cloudflare",
      minutes(45),
      async () => {
        const plan = await first.readPlan();
        const refused = await run.opscrew(
          "destroy",
          "--app",
          ".",
          ...destroyConfirmArgs(plan),
          "--no-snapshot",
        );
        expect(refused.exitCode, "the first app's destroy beside the kept data").not.toBe(0);
        expect(
          otherAppRefused(refused.output, NAMES.secondApp),
          `the refusal naming "${NAMES.secondApp}", whose data is kept:\n${run.tail(refused.output)}`,
        ).toBe(true);
        expect(await serverIds(NAMES.firstApp), "the first app's server after it").toEqual(
          firstServers,
        );
        const record = await secretsRecord(first.paths());
        await first.destroy("prod", undefined, ["--skip-other-apps-check"]);
        await first.expectNothingLeft("prod");
        await run.expectCloudflareClean();
        const { firstHost, secondHost } = hosts();
        expect(
          dnsFacts(await run.cloudflare.zoneRecords(run.zone as CloudflareZone), [
            firstHost,
            secondHost,
          ]),
          "both apps' DNS records",
        ).toBe("");
        if (record !== undefined) await first.expectSecretsGone("prod", record);
      },
    );

    run.step(
      "8. no token, key or generated value in any output, commit, pull request, audit entry, plan or state file, and no server address in the second app's outputs (SC-3006)",
      minutes(15),
      async () => {
        for (const line of loads) log(`figure: ${line}`);
        run.expectNothingLeaked([
          ...(await first.leaks({ cloudflare: true, others: [second] })),
          ...addressLeaks(run.outputs, addresses(), NAMES.secondApp),
        ]);
      },
      { always: true },
    );

    // The harness's cleanup: `opscrew destroy` of what is left, the second app first; then
    // Hetzner's API by each app's own labels (`app=<the run's app name>`), GitHub's environments
    // and secrets, Cloudflare on the run's hostnames, and the repository's reset.
    first.registerCleanup({ others: [second] });
  },
);

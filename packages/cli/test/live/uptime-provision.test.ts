/**
 * The full live pass of the uptime Worker's server part (feature 046, T4694; docs/e2e.md "The
 * uptime Worker through provision"): what the adapter-level pass (`uptime-server.test.ts`) can't
 * show, through OpsCrew's own commands in the Cloudflare account of the app's zone. A throwaway
 * Hetzner server set up as the user's own carries `examples/flask-sqlite`, DNS only, with
 * `observability.check.runner: cloudflare`, `webhook: ntfy` and `credentials: true` in its plan:
 * provision plans the Worker and the host step `uptime-report` itself, `status` shows the server's
 * last report, `rotate` dates a credential anew, a provision with `runner: actions` removes the
 * timer, and `destroy` removes the Worker with the last entry. Every plan is approved by the hash
 * a run printed; the test itself only reads the server (`systemctl`, `stat`, `cat`) and
 * Cloudflare's API.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  UPTIME_REPORT_CONFIG_DIR,
  UPTIME_REPORT_SCRIPT,
  UPTIME_REPORT_SERVICE_UNIT,
  UPTIME_REPORT_TIMER_UNIT,
  uptimeReportInstance,
  uptimeReportTimer,
} from "@opscrew/connector-ssh-host";
import { checkEnvironmentKey, checkHosts, UPTIME_WORKER } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { api, CLOUDFLARE_API, HETZNER_API, minutes, waitFor } from "./cloud";
import {
  AppEnvironments,
  environmentNames,
  type SecretsRecord,
  secretsRecord,
} from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { secretNames } from "./portainer-cloud";
import { scriptedRotation } from "./rotation-checks";
import { missingVariables } from "./support";

const ENV = process.env;
const GATE = "OPSCREW_E2E_UPTIME_PROVISION";
const MISSING = missingVariables(ENV, GATE, [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
  "OPSCREW_E2E_NTFY_TOPIC",
]);
const APP = "flask-sqlite";
const SETTINGS = { ...serverSettings(ENV, "OPSCREW_E2E_UPTIME_SERVER_TYPE"), app: APP };
const TOPIC = (ENV.OPSCREW_E2E_NTFY_TOPIC ?? "").trim();
const WEBHOOK = { OPSCREW_CHECK_WEBHOOK: `https://ntfy.sh/${TOPIC}` };
const WORKER = UPTIME_WORKER.name;
const NAMESPACE = UPTIME_WORKER.namespace;
/** The credential the pass rotates: OpenTofu's state passphrase, on this computer only. */
const ROTATED = "state-passphrase";

if (MISSING.length > 0 && ENV[GATE] === "1") {
  console.warn(
    `OpsCrew E2E (uptime provision): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "The uptime Worker through provision").`,
  );
}

interface Envelope {
  success: boolean;
  errors: { code: number; message: string }[];
  result: unknown;
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live uptime Worker through provision (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live uptime Worker through provision: examples/${APP} on a throwaway server as your own`,
  () => {
    const run = new LiveRun({ label: "uptime provision", name: "upprov", settings: SETTINGS });
    const { log } = run;
    const envs = new AppEnvironments(run, "");
    run.scrubber.add(TOPIC, "ntfy-topic");
    let hostKey = "";
    let accountId = "";
    /** True once step 2 found the account without the Worker: only then is its cleanup the run's. */
    let ours = false;
    let provisioned = false;
    let workerDestroyed = false;
    let secrets: SecretsRecord | undefined;
    let id = "";
    let serverId = "";

    const token = SETTINGS.cloudflareToken.trim().replace(/^(["'])(.*)\1$/, "$2");
    async function cf(path: string, init: RequestInit = {}) {
      const response = await fetch(`${CLOUDFLARE_API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
      });
      const text = await response.text();
      let body: Envelope;
      try {
        body = JSON.parse(text) as Envelope;
      } catch {
        body = { success: response.ok, errors: [], result: text };
      }
      return { status: response.status, body };
    }
    const workers = async () => {
      const { body } = await cf(`/accounts/${accountId}/workers/scripts`);
      expect(body.success, JSON.stringify(body.errors)).toBe(true);
      return (body.result as { id: string }[]).map((w) => w.id);
    };
    const namespaces = async () => {
      const { body } = await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
      expect(body.success, JSON.stringify(body.errors)).toBe(true);
      return body.result as { id: string; title: string }[];
    };
    const workerSecrets = async () => {
      const { status, body } = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/secrets`);
      if (status === 404) return undefined;
      return (body.result as { name: string }[]).map((s) => s.name).sort();
    };
    const kvKeys = async () => {
      const ns = (await namespaces()).find((n) => n.title === NAMESPACE)?.id;
      if (ns === undefined) return [];
      const { body } = await cf(`/accounts/${accountId}/storage/kv/namespaces/${ns}/keys`);
      return (body.result as { name: string }[]).map((k) => k.name).sort();
    };
    const shell = (command: string) => run.shell().ok(command, minutes(3));
    const timers = async () =>
      (await shell("systemctl list-timers 'opscrew-uptime-report@*' --all --no-legend --no-pager"))
        .split("\n")
        .flatMap((line) => line.match(/opscrew-uptime-report@[0-9a-f]{16}\.timer/g) ?? [])
        .sort();
    const configFile = () => `${UPTIME_REPORT_CONFIG_DIR}/${uptimeReportInstance(id)}.conf`;
    const keyFile = () => `${UPTIME_REPORT_CONFIG_DIR}/${uptimeReportInstance(id)}.key`;
    /** Every CLI output since `from` (an index into the run's outputs). */
    const outputsSince = (from: number) => [...run.outputs.values()].slice(from).join("\n");

    /** plan.yaml with `check` (the scheduled check's settings) changed, as a user edits it. */
    async function setCheck(check: NonNullable<DeployPlan["observability"]>["check"]) {
      const plan = await run.readPlan();
      await writeArtifact("plan", run.paths().files.plan, {
        ...plan,
        observability: { ...plan.observability, check: { ...plan.observability?.check, ...check } },
      });
      log(
        `plan.yaml: observability.check ${JSON.stringify((await run.readPlan()).observability?.check)}`,
      );
    }

    run.step(
      "1. a throwaway Hetzner server with its own SSH key, outside OpsCrew",
      minutes(30),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${APP} on your own server, its uptime check in Cloudflare`,
          env: { CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
        });
        await envs.snapshotGithub();
        hostKey = await run.createServer();
      },
    );

    run.step(
      "2. runner: cloudflare in plan.yaml; provision plans the Worker (workers.dev on) and the host step uptime-report, each by its hash; the first deploy and verify",
      minutes(75),
      async () => {
        await run.initFix();
        await run.opscrewOk("analyze", "--no-ai");
        const answers = join(run.work, "answers.json");
        await writeFile(
          answers,
          JSON.stringify({
            provider: "own",
            expectedMonthlyUsers: "<1k",
            budgetMonthly: 20,
            uptime: "best-effort",
            dataCriticality: "important",
            dnsProvider: "cloudflare",
            domain: run.appHost,
            keepExternalServices: { s3: false },
            "server.host": run.ipv4(),
            "server.port": 22,
            "server.user": "root",
            "server.key": run.keyFile,
            "server.reachable": true,
            "server.serve": "dns-only",
          }),
        );
        await run.opscrewOk("interview", "--answers", answers);
        await run.opscrewOk("design", "--host-key", hostKey);
        expect((await run.readPlan()).target.provider).toBe("own");
        run.appName = (await run.readPlan()).app.name;
        const zone = await run.snapshotCloudflare(() => [run.appHost, `www.${run.appHost}`], {
          zeroTrust: false,
        });
        accountId = zone.accountId;
        run.scrubber.add(accountId, "zone-account-id");
        // The zone's account must not have the Worker yet: then everything of it is the run's.
        expect(await workers(), "an opscrew-uptime Worker exists: not this run's").not.toContain(
          WORKER,
        );
        expect((await namespaces()).map((n) => n.title)).not.toContain(NAMESPACE);
        ours = true;
        await setCheck({ runner: "cloudflare", webhook: "ntfy", credentials: true });
        await run.opscrewOk("snapshot", "offsite", "off");
        const copies = join(run.work, "copies");
        await mkdir(copies, { recursive: true });
        await run.opscrewOk("secrets", "folder", copies);
        run.provisionFlags = ["--key-out", join(run.work, "age-key.txt")];
        await run.adaptAndMerge();
        envs.provisioned.add("prod");
        provisioned = true;
        const shown = run.outputs.size;
        await run.provisionUntilDone("your own server, runner: cloudflare", { overrides: WEBHOOK });
        const said = outputsSince(shown);
        for (const line of said.split(/\r?\n/)) {
          if (/uptime|workers\.dev|Cloudflare uptime plan/i.test(line))
            log(`2: provision: ${line.trim()}`);
        }
        expect(said, "provision's Cloudflare uptime plan").toContain("Cloudflare uptime plan for");
        expect(said, "it turns on workers.dev").toContain("Turn on the workers.dev address");
        expect(said, "provision's host step").toContain("uptime-report");
        expect(said, "nothing is left to Actions").not.toContain("need `runner: actions`");
        await run.rememberSecretFile(run.paths().files.deployKey, "deploy-private-key");
        await run.rememberSecretFile(run.paths().files.statePassphrase, "state-passphrase");
        await run.rememberGeneratedValues();
        await run.deployAny("the first deploy");
        await run.waitForHealth(minutes(15), false);
        await run.opscrewOk("verify");
        secrets = await envs.expectSecretsPlaced("prod");
        const plan = await run.readPlan();
        id = `${SETTINGS.githubRepo}/${checkEnvironmentKey(plan)}`;
        serverId = `own-${hostKey
          .replace(/^SHA256:/, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")}`;
      },
    );

    run.step(
      "9. provision again: the credentials dated from the first deploy; one timer, its config and key 0600 root, names and dates only; the first report in KV",
      minutes(40),
      async () => {
        // verify recorded the first deploy, so the config now dates the credentials.
        const shown = run.outputs.size;
        await run.provisionUntilDone("provision after the first deploy");
        log(
          `9: provision again ${outputsSince(shown).includes("uptime-report") ? "changed" : "kept"} the host step uptime-report`,
        );
        expect(await timers(), "one timer").toEqual([uptimeReportTimer(uptimeReportInstance(id))]);
        expect(await shell(`stat -c '%a %U' ${configFile()}`)).toBe("600 root");
        expect(await shell(`stat -c '%a %U' ${keyFile()}`)).toBe("600 root");
        const config = await shell(`cat ${configFile()}`);
        expect(config).toContain(`entry=${id}`);
        expect(config).toContain(`server=${serverId}`);
        for (const host of checkHosts(await run.readPlan())) {
          expect(config).toContain(`host=${host.hostname}`);
        }
        expect(config, "the credentials' names and dates").toMatch(
          new RegExp(`^credential=${ROTATED} \\S+ (made|first-deploy)$`, "m"),
        );
        log(
          `9: the config's credentials: ${config
            .split("\n")
            .filter((l) => l.startsWith("credential="))
            .map((l) => l.split(" ").slice(0, 1).concat(l.split(" ").slice(2)).join(" "))
            .join(", ")}`,
        );
        await waitFor(
          "the server's first report in KV",
          minutes(6),
          async () => ((await kvKeys()).includes(`report:${id}/${serverId}`) ? true : undefined),
          20_000,
        );
        expect(await workerSecrets()).toHaveLength(1);
        log("9: passed");
      },
    );

    run.step(
      "12a. status shows the server's last report with the certificate's days; rotate writes the credential's new date on the server",
      minutes(40),
      async () => {
        const status = (await run.opscrewOk("status")).output;
        const lines = status
          .split(/\r?\n/)
          .filter((line) =>
            /Uptime check|Checked every 5 minutes|Down:|Server checks|last report|reports stopped|no report yet/.test(
              line,
            ),
          );
        log(`12a: status:\n    ${lines.map((l) => l.trim()).join("\n    ")}`);
        expect(status).toContain(`Uptime check (the Cloudflare Worker ${WORKER}`);
        expect(status).toMatch(
          new RegExp(`${serverId}: last report .*certificate of \\S+ ok \\(\\d+ days left\\)`),
        );
        expect(status).toMatch(/credentials ok/);
        const before = (await shell(`cat ${configFile()}`))
          .split("\n")
          .find((l) => l.startsWith(`credential=${ROTATED} `));
        const shown = run.outputs.size;
        await scriptedRotation(run, [ROTATED]);
        const said = outputsSince(shown);
        const about = said
          .split(/\r?\n/)
          .filter((line) => /uptime report|new date/i.test(line))
          .map((line) => line.trim());
        log(`12a: rotate's lines about the uptime report:\n    ${about.join("\n    ")}`);
        let after = (await shell(`cat ${configFile()}`))
          .split("\n")
          .find((l) => l.startsWith(`credential=${ROTATED} `));
        if (after === before) {
          // A script can't approve the date's host plan before the rotation dates it: rotate says
          // to provision, whose host plan, approved by its hash, writes the date.
          log("12a: rotate left the old date on the server; provision writes it");
          await run.provisionUntilDone("provision after the rotation");
          after = (await shell(`cat ${configFile()}`))
            .split("\n")
            .find((l) => l.startsWith(`credential=${ROTATED} `));
        }
        log(
          `12a: the config's date of ${ROTATED}: ${before?.split(" ").slice(1).join(" ")} -> ${after?.split(" ").slice(1).join(" ")}`,
        );
        expect(after, "the new date, from the rotation").toMatch(/ rotated$/);
        log("12a: passed");
      },
    );

    run.step(
      "13. runner: actions: provision removes the entry, its secret and the server's timer; the Worker stays",
      minutes(40),
      async () => {
        await setCheck({ runner: "actions" });
        const shown = run.outputs.size;
        await run.provisionUntilDone("leaving the Worker");
        const said = outputsSince(shown);
        for (const line of said.split(/\r?\n/)) {
          if (/uptime/i.test(line)) log(`13: provision: ${line.trim()}`);
        }
        expect(await timers(), "no timer is left").toEqual([]);
        expect(
          await shell(`test ! -e ${configFile()} && test ! -e ${keyFile()} && echo gone`),
        ).toBe("gone");
        expect(await workers(), "the Worker stays").toContain(WORKER);
        expect(await workerSecrets(), "the entry's secret went").toEqual([]);
        await waitFor(
          "the entry's keys gone from KV",
          minutes(2),
          async () => ((await kvKeys()).some((k) => k.includes(id)) ? undefined : true),
          10_000,
        );
        log("13: passed");
      },
    );

    run.step(
      "14. back to the Worker, then destroy: the Worker, its trigger and the namespace go with the last entry, and the timer and its files with the app",
      minutes(60),
      async () => {
        await setCheck({ runner: "cloudflare" });
        await run.provisionUntilDone("back to the Worker", { overrides: WEBHOOK });
        expect(await timers(), "the timer is back").toEqual([
          uptimeReportTimer(uptimeReportInstance(id)),
        ]);
        // The provisions since step 2 may have stored more deploy secrets: destroy removes them all.
        secrets = (await secretsRecord(run.paths())) ?? secrets;
        const shown = run.outputs.size;
        await opscrewDestroy();
        const said = outputsSince(shown);
        for (const line of said.split(/\r?\n/)) {
          if (/uptime|Worker/i.test(line)) log(`14: destroy: ${line.trim()}`);
        }
        expect(await workers(), "the Worker").not.toContain(WORKER);
        expect(
          (await namespaces()).map((n) => n.title),
          "the namespace",
        ).not.toContain(NAMESPACE);
        workerDestroyed = true;
        expect(await timers(), "no timer is left").toEqual([]);
        expect(
          await shell(
            `for f in ${UPTIME_REPORT_SCRIPT} ${UPTIME_REPORT_SERVICE_UNIT} ${UPTIME_REPORT_TIMER_UNIT} ${UPTIME_REPORT_CONFIG_DIR} /var/lib/opscrew-uptime-report; do test -e $f && echo $f; done; true`,
          ),
          "the uptime report's files on the server",
        ).toBe("");
        await run.expectCloudflareClean();
        if (secrets !== undefined) await envs.expectSecretsGone("prod", secrets);
        log("14: passed");
      },
    );

    /** `destroy --confirm <app>`, each printed host plan approved by its hash. */
    async function opscrewDestroy(): Promise<void> {
      const approved: string[] = [];
      for (let round = 1; ; round++) {
        const result = await run.opscrew(
          "destroy",
          "--confirm",
          run.app(),
          ...approved.flatMap((hash) => ["--approve", hash]),
        );
        if (result.exitCode === 0) break;
        const next = [...result.output.matchAll(/(?:Host plan hash: |--approve )([0-9a-f]{64})\b/g)]
          .map((m) => m[1] as string)
          .filter((hash) => !approved.includes(hash));
        if (next.length === 0 || round >= 4) {
          throw new Error(
            `opscrew destroy exited with ${result.exitCode}:\n${run.tail(result.output)}`,
          );
        }
        approved.push(...new Set(next));
      }
      run.destroyed = true;
      envs.destroyed.add("prod");
    }

    run.step(
      "15. nothing left: the account's Workers, KV namespaces and the Worker's secrets; the run's DNS records; GitHub's secrets; no secret in any output",
      minutes(10),
      async () => {
        if (accountId !== "" && workerDestroyed) {
          log(
            `15: the zone's account: ${(await workers()).length} Worker(s) (no ${WORKER}), ${(await namespaces()).length} KV namespace(s) (no ${NAMESPACE}), ${(await workerSecrets()) === undefined ? "no such Worker's secrets" : "secrets left"}`,
          );
          expect(await workerSecrets()).toBeUndefined();
        }
        if (run.destroyed && secrets !== undefined) {
          const record = secrets;
          const left = (await secretNames(run.github)).filter((n) => record.names.includes(n));
          log(
            `15: the run's deploy secrets left at GitHub: ${left.length}; environments: ${(await environmentNames(run.github)).join(", ") || "none"}`,
          );
          expect(left).toEqual([]);
        }
        run.expectNothingLeaked(await envs.leaks({ cloudflare: provisioned }));
      },
      { always: true },
    );

    envs.registerCleanup({
      last: async (attempt) => {
        if (accountId !== "" && ours) {
          await attempt("delete the run's uptime Worker and namespace", async () => {
            if ((await workers()).includes(WORKER)) {
              const gone = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}`, {
                method: "DELETE",
              });
              log(`cleanup: DELETE Worker ${WORKER}: HTTP ${gone.status}`);
            }
            for (const ns of (await namespaces()).filter((n) => n.title === NAMESPACE)) {
              const gone = await cf(`/accounts/${accountId}/storage/kv/namespaces/${ns.id}`, {
                method: "DELETE",
              });
              log(`cleanup: DELETE namespace ${NAMESPACE}: HTTP ${gone.status}`);
            }
            const all = await workers();
            const titles = (await namespaces()).map((n) => n.title);
            log(
              `cleanup: listed, the zone's account: ${all.length} Worker(s) (${all.includes(WORKER) ? "with" : "no"} ${WORKER}), ${titles.length} KV namespace(s) (${titles.includes(NAMESPACE) ? "with" : "no"} ${NAMESPACE}), ${(await workerSecrets()) === undefined ? "no such Worker's secrets" : "secrets left"}`,
            );
            return [
              ...(all.includes(WORKER) ? [`the Worker ${WORKER} is left`] : []),
              ...(titles.includes(NAMESPACE) ? [`the namespace ${NAMESPACE} is left`] : []),
            ];
          });
        }
        await attempt("list the run's DNS records", async () => {
          if (run.zone === undefined) return [];
          const zone = run.zone;
          const records = (await run.cloudflare.zoneRecords(zone)).filter((r) =>
            run.hostnames.includes(r.name),
          ).length;
          log(`cleanup: listed, the zone's records on the run's hostnames: ${records}`);
          return records === 0 ? [] : [`${records} record(s) on the run's hostnames are left`];
        });
        await attempt("list the run's GitHub secrets", async () => {
          if (!run.repoReady || secrets === undefined) return [];
          const record = secrets;
          const left = (await secretNames(run.github)).filter((n) => record.names.includes(n));
          log(`cleanup: listed, the run's deploy secrets at GitHub: ${left.length}`);
          return left.map((name) => `the GitHub secret ${name} is left`);
        });
        await attempt("list the run's Hetzner resources", async () => {
          const selector = encodeURIComponent(`managed-by=opscrew-e2e,run=${run.runId}`);
          const counts: string[] = [];
          for (const kind of ["servers", "ssh_keys", "firewalls"]) {
            const got = await api(
              HETZNER_API,
              SETTINGS.hcloudToken,
              "GET",
              `/${kind}?label_selector=${selector}`,
            );
            counts.push(
              `${kind} ${((got.json as Record<string, unknown[]> | undefined)?.[kind] ?? []).length}`,
            );
          }
          log(`cleanup: listed, Hetzner with the run's label: ${counts.join(", ")}`);
          return counts.filter((c) => !c.endsWith(" 0")).map((c) => `Hetzner still lists ${c}`);
        });
      },
    });
  },
);

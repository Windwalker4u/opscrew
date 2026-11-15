/**
 * The live pass of feature 028 (docs/e2e.md "Moving to another Cloudflare account"), with
 * `OPSCREW_E2E_CLOUDFLARE_MOVE=1`: the real move of a zone with every OpsCrew app it serves from
 * account A to account B, in legs run one at a time with `-t "<leg>"`, over hours or days. Each
 * leg is its own process; the pass keeps its state in its folder under `OPSCREW_TEST_TMP`
 * (`cloudflare-move-pass.ts`). The pass's own apps are P (examples/s3-uploads at Hetzner,
 * proxied, origin TLS, its files in R2) and Q (examples/flask-sqlite on a throwaway server set up
 * as the user's own, in tunnel mode, its snapshots copied off to R2).
 * - **L0** preflight: A holds the zone and B none; the registrar (L4a or L4b); DNSSEC; both
 *   accounts' inventories, what OpsCrew didn't make among them, for the lead's checklist.
 * - **L1** P and Q in A; P's files and Q's copies seeded; the load answers.
 * - **L2** the rehearsal under load: prepare P and Q, abort both; B holds nothing, A unchanged.
 * - **L3** prepare P (the switch then names Q), Q, then the real apps (the lead's), under load.
 * - **L4a / L4b** the switch, at a registrar OpsCrew drives or at Cloudflare Registrar.
 * - **L5** every finish; P's files and Q's copies in B; a restore and a deploy each; A empty.
 * - **L6** the leak search over the whole pass, then P and Q destroyed and the cleanup.
 * Every command runs as a script runs it: each stop's printed command, its names checked.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import {
  deleteHetznerApp,
  deleteThrowaway,
  hetznerAppLeft,
  minutes,
  sleep,
  waitFor,
} from "./cloud";
import { doh, Leg, MovePass, result, type StepWait, zoneName } from "./cloudflare-move-pass";
import {
  configuredRegistrars,
  dataRecords,
  inventoryChanges,
  inventoryLines,
  legSkip,
  MOVE_GATE,
  type MoveLeg,
  nextMoveCommand,
  oneAccount,
  type PassState,
  parsePass,
  passFolder,
  probeFigures,
  rdapRegistrar,
  rdapServers,
  recordKinds,
  registrarFinding,
  switchLegSkip,
  waitOf,
} from "./cloudflare-move-support";
import { readValue, writeValue } from "./component-checks";
import { withBucket } from "./components-support";
import { type AppEnvironments, designProd } from "./environment-checks";
import type { LiveRun } from "./harness";
import { execOn, keptShell } from "./retarget-anywhere-checks";
import { composeProjectOf, OBJECTS, objectsCommand } from "./retarget-anywhere-support";
import { approvedRestore, listSnapshots, snapshotOf } from "./snapshots-checks";
import { takenSnapshotId } from "./snapshots-support";
import { requireDocker } from "./tls-checks";

const ENV = process.env;
const hours = (n: number) => minutes(n * 60);
/** The tunnel's and the Access service token's secrets in Q's outputs, for the leak search. */
const TUNNEL_OUTPUTS = [
  "tunnel_token",
  "deploy_service_token_client_secret",
  "deploy_service_token_client_id",
];

/** What L0 recorded, read when the tests are collected (the switch legs depend on it). */
function recordedPass(): PassState | undefined {
  if (!ENV.OPSCREW_TEST_TMP?.trim()) return undefined;
  const file = join(passFolder(ENV), "pass.json");
  return existsSync(file) ? parsePass(readFileSync(file, "utf8")) : undefined;
}

/** The leg's describe title, or why it is skipped (logged too when the gate is set). */
function legTitle(leg: MoveLeg, title: string): { skip: boolean; title: string } {
  const why =
    legSkip(ENV, leg) ??
    (leg === "L4a" || leg === "L4b" ? switchLegSkip(leg, recordedPass()?.registrar) : undefined);
  const full = `live Cloudflare move, ${leg}: ${title}`;
  if (why === undefined) return { skip: false, title: full };
  if (ENV[MOVE_GATE] === "1") {
    console.warn(`OpsCrew E2E (Cloudflare move, ${leg}): skipped, ${why} (docs/e2e.md).`);
  }
  return { skip: true, title: `${full} (skipped: ${why})` };
}

/**
 * Names the app after the pass (`architecture.json`'s project name, as design names the app after
 * it), then designs again with `args`: every resource of the app is then this pass's alone.
 */
async function nameApp(
  run: LiveRun,
  envs: AppEnvironments,
  name: string,
  args: readonly string[] = [],
): Promise<void> {
  const file = run.paths().files.architecture;
  const architecture = await readArtifact("architecture", file);
  await writeArtifact("architecture", file, {
    ...architecture,
    facts: { ...architecture.facts, name },
  });
  // Design keeps an existing plan's app name, so the plan the first design wrote goes first.
  await rm(run.paths().files.plan, { force: true });
  await run.opscrewOk("design", ...args);
  const plan = await envs.designed("prod");
  if (plan.app.name !== name)
    throw new Error(`design named the app ${plan.app.name}, not ${name}.`);
}

/** The recovery copy: a folder copy, and the age key written to a file of the pass's own. */
async function recoveryCopy(run: LiveRun): Promise<string> {
  const folder = join(run.work, "copies");
  await mkdir(folder, { recursive: true });
  await run.opscrewOk("secrets", "folder", folder);
  const ageKey = join(run.work, "age-key.txt");
  run.provisionFlags = ["--key-out", ageKey];
  return ageKey;
}

// ---------------------------------------------------------------------------------------------

const L0 = legTitle("L0", "A holds the zone, B none; the registrar; DNSSEC; both inventories");

describe.skipIf(L0.skip)(L0.title, () => {
  const pass = new MovePass(ENV);
  const leg = new Leg(pass, "L0");
  const zone = zoneName(pass.settings.domain);
  let zoneId = "";

  leg.step(
    "A holds the zone, active and without a hold; B has no zone of its name; both account ids",
    minutes(5),
    async () => {
      const a = await pass.a.zoneOf(zone);
      expect(a.name, "OPSCREW_E2E_DOMAIN's zone").toBe(zone);
      const accounts = await pass.b.list<{ id: string }>("/accounts");
      const b = oneAccount(accounts, pass.settings.accountB, "OPSCREW_E2E_MOVE_ACCOUNT_B");
      expect(b === a.accountId, "B is another account than A").toBe(false);
      pass.mask(zone, "zone");
      pass.mask(a.accountId, "account-a");
      pass.mask(b, "account-b");
      pass.startPass({ a: a.accountId, b });
      const listed = await pass.zoneIn("a");
      expect(listed?.status, "A's zone").toBe("active");
      zoneId = listed?.id ?? "";
      const hold = await result<{ hold?: boolean }>(pass.a, `/zones/${zoneId}/hold`);
      expect("unreadable" in hold ? hold.unreadable : hold.value?.hold, "A's zone hold").toBe(
        false,
      );
      expect(await pass.zoneIn("b"), "B's zone of the same name").toBeUndefined();
      pass.log("A holds the zone, active, no hold; B has none of its name");
    },
  );

  leg.step("the registrar, and so the switch's leg (L4a or L4b)", minutes(5), async () => {
    const state = pass.pass();
    const read = await pass.a.call(
      "GET",
      `/accounts/${state.accounts.a}/registrar/domains/${zone}`,
    );
    const cloudflare =
      read.status === 200
        ? "holds"
        : read.status === 401 || read.status === 403
          ? "refused"
          : "absent";
    let publicName: string | undefined;
    try {
      const bootstrap = await (await fetch("https://data.iana.org/rdap/dns.json")).json();
      const [server] = rdapServers(bootstrap, zone);
      if (server !== undefined) {
        const answer = await fetch(`${server.replace(/\/?$/, "/")}domain/${zone}`, {
          headers: { accept: "application/rdap+json" },
        });
        publicName = rdapRegistrar(await answer.json());
      }
    } catch (error) {
      pass.log(`the public registration record was not read: ${String(error)}`);
    }
    const found = registrarFinding({
      cloudflare,
      publicName,
      configured: configuredRegistrars(ENV),
    });
    state.registrar = found;
    state.figures["L0 registrar"] =
      `A's token on Cloudflare Registrar: HTTP ${read.status}; the public record: ${publicName ?? "not read"}; ${found.registrar}, ${found.leg ?? found.why}`;
    pass.log(state.figures["L0 registrar"]);
    if (found.leg === undefined) throw new Error(`The switch has no leg: ${found.why}.`);
  });

  leg.step(
    "DNSSEC: A's status, and whether the registry still publishes a DS record",
    minutes(5),
    async () => {
      const state = pass.pass();
      const dnssec = await result<{ status?: string }>(pass.a, `/zones/${zoneId}/dnssec`);
      const status = "unreadable" in dnssec ? dnssec.unreadable : String(dnssec.value?.status);
      const published = (await doh(zone, "DS")).some((record) => record.type === 43);
      state.dnssec = { status, dsPublished: published };
      state.figures["L0 DNSSEC"] =
        `A's DNSSEC: ${status}; the registry ${published ? "still publishes a DS record" : "publishes no DS record"}`;
      pass.log(state.figures["L0 DNSSEC"]);
    },
  );

  leg.step(
    "both accounts' inventories, what OpsCrew didn't make among them (plan 14.), for the lead's checklist",
    minutes(15),
    async () => {
      const a = await pass.inventory("a");
      const b = await pass.inventory("b");
      expect(b.inventory.zone, "B's zone").toBeUndefined();
      const file = await pass.writeInventory("inventory-L0", {
        a: { ...a.inventory, rawRecords: a.records },
        b: b.inventory,
      });
      for (const line of [
        ...inventoryLines("A", a.inventory),
        ...inventoryLines("B", b.inventory),
      ]) {
        pass.log(line);
      }
      const kinds = recordKinds(a.records);
      pass.log(
        `A's records: ${kinds.opscrew.length} OpsCrew's, ${kinds.emailRouting.length} Email Routing's, ${kinds.workersDomains.length} Workers custom domains', ${kinds.otherManaged.length} other Cloudflare-managed, ${kinds.user.length} the user's (${[...new Set(kinds.user.map((r) => r.type))].join(", ")})`,
      );
      pass.log(
        `Email Routing in A: ${a.inventory.settings["email routing"]}; set it up in B right after the activation (the switch doesn't copy it)`,
      );
      pass.log(`the inventories for the lead's checklist: ${file}`);
    },
  );
});

// ---------------------------------------------------------------------------------------------

const L1 = legTitle("L1", "P and Q in A, their data seeded; the load answers");

describe.skipIf(L1.skip)(L1.title, () => {
  const pass = new MovePass(ENV);
  const leg = new Leg(pass, "L1");
  const { p, q, pEnvs, qEnvs } = pass;
  const runId = () => pass.pass().runId;

  leg.step(
    "P: examples/s3-uploads at Hetzner in A, proxied with origin TLS, its files in R2",
    minutes(90),
    async () => {
      const state = pass.pass();
      if (state.apps.p !== undefined || state.apps.q !== undefined) {
        throw new Error(
          "L1 ran before and left P or Q: run L6 to remove them, then L0 and L1 again.",
        );
      }
      // Every name of the pass (hostnames, Hetzner labels) is this process's run id.
      state.runId = p.runId;
      await pass.inPassFolder(async () =>
        p.prepareRepo({
          commit: "e2e: examples/s3-uploads, moved to another Cloudflare account",
          env: await pass.accountEnv(),
        }),
      );
      // The run's environment without the pass's folder as its temporary one.
      p.env = await pass.cliEnv(p);
      await pass.record("p");
      await pEnvs.snapshotGithub();
      await designProd(p, pEnvs, pass.settings.region);
      const name = `e2e-move-${runId()}-p`;
      await nameApp(p, pEnvs, name);
      await writeArtifact("plan", p.paths().files.plan, withBucket(await p.readPlan(), "r2", name));
      await p.opscrewOk("design");
      await pEnvs.designed("prod");
      await pass.record("p");
      await p.adaptAndMerge();
      const ageKey = await recoveryCopy(p);
      await pEnvs.provision("prod", "P in the current account");
      await p.rememberSecretFile(ageKey, "age-identity");
      await p.deployAny("P's first deploy");
      await p.waitForHealth(minutes(10), true, await pass.healthUrl("p"));
      await pass.record("p", { ageKey });
    },
  );

  leg.step(
    "Q: examples/flask-sqlite on a throwaway server, the user's own, in tunnel mode in A, its snapshots copied off to R2",
    minutes(120),
    async () => {
      await pass.inPassFolder(async () =>
        q.prepareRepo({
          commit: "e2e: examples/flask-sqlite, moved to another Cloudflare account",
          env: await pass.accountEnv(),
        }),
      );
      q.env = await pass.cliEnv(q);
      await pass.record("q");
      await qEnvs.snapshotGithub();
      const fingerprint = await q.createServer();
      await pass.record("q");
      await q.initFix();
      await q.opscrewOk("analyze", "--no-ai");
      const answers = join(q.work, "answers.json");
      await writeFile(
        answers,
        JSON.stringify({
          provider: "own",
          expectedMonthlyUsers: "<1k",
          budgetMonthly: 20,
          uptime: "best-effort",
          dataCriticality: "important",
          dnsProvider: "cloudflare",
          domain: q.appHost,
          keepExternalServices: { s3: false },
          "server.host": q.ipv4(),
          "server.port": 22,
          "server.user": "root",
          "server.key": q.keyFile,
          "server.reachable": true,
          "server.serve": "tunnel",
        }),
      );
      await q.opscrewOk("interview", "--answers", answers);
      await q.opscrewOk("design", "--host-key", fingerprint);
      await qEnvs.designed("prod");
      await nameApp(q, qEnvs, `e2e-move-${runId()}-q`, ["--host-key", fingerprint]);
      await pass.record("q");
      await q.adaptAndMerge();
      const ageKey = await recoveryCopy(q);
      await q.opscrewOk("snapshot", "offsite", "on", "--to", "r2");
      await qEnvs.provision("prod", "Q in the current account");
      await q.rememberSecretFile(ageKey, "age-identity");
      await q.rememberOutputs(TUNNEL_OUTPUTS);
      await q.deployAny("Q's first deploy");
      await q.waitForHealth(minutes(10), true, await pass.healthUrl("q"));
      const value = `value-${runId()}`;
      await writeValue(`https://${q.appHost}`, value);
      await pass.record("q", { value, ageKey });
    },
  );

  leg.step(
    `P's bucket holds ${OBJECTS} objects; Q has two snapshot copies in A's bucket`,
    minutes(45),
    async () => {
      await requireDocker("The pass reads Q's copies with rclone, from its pinned image in Docker");
      const project = composeProjectOf(await p.readPlan());
      const objects = await execOn(await keptShell(p, pEnvs, "p-seed"))(
        objectsCommand(project, true, runId()),
      );
      expect(objects.split("\n").filter((line) => line !== "").length, "P's objects").toBe(OBJECTS);
      await pass.record("p", { objects });
      const snapshots: string[] = [];
      for (const which of ["first", "second"]) {
        const taken = await q.opscrewOk("snapshot");
        const id = takenSnapshotId(taken.output);
        if (id === undefined)
          throw new Error(`Q's ${which} snapshot printed no id:\n${q.tail(taken.output)}`);
        await waitFor(
          `Q's ${which} snapshot copied off the server`,
          minutes(10),
          async () => (snapshotOf(await listSnapshots(q), id).offsite ? true : undefined),
          30_000,
        );
        snapshots.push(id);
      }
      const copies = await pass.copies("a");
      expect(Object.keys(copies).length, "the objects of Q's copies in A's bucket").toBeGreaterThan(
        0,
      );
      await pass.record("q", { snapshots, copies });
    },
  );

  leg.step(
    "the load answers on P, Q and every real app; the SSH hostname behind Access with A's service token",
    minutes(10),
    async () => {
      const { failures } = await pass.underLoad("L1", () => sleep(60_000));
      const own = failures.filter((failure) => /^[PQ]:/.test(failure.what));
      expect(own, "P's and Q's requests that failed").toEqual([]);
      const state = pass.pass();
      state.figures["L1 SSH probe, A's service token"] = await pass.sshProbe();
      pass.log(state.figures["L1 SSH probe, A's service token"]);
    },
  );
});

// ---------------------------------------------------------------------------------------------

const L2 = legTitle("L2", "the rehearsal: prepare P and Q, then abort both, under load");

describe.skipIf(L2.skip)(L2.title, () => {
  const pass = new MovePass(ENV);
  const leg = new Leg(pass, "L2");
  const { p, q } = pass;
  let before: Awaited<ReturnType<MovePass["inventory"]>>["inventory"] | undefined;

  leg.step("A's inventory before the rehearsal", minutes(10), async () => {
    before = (await pass.inventory("a")).inventory;
  });

  leg.step(
    "prepare P, then Q, into B; `opscrew status` shows them; abort P (B's zone stays for Q's mark), then Q (B's zone goes)",
    hours(4),
    async () => {
      const to = ["--to", pass.pass().accounts.b];
      const { failures } = await pass.underLoad("L2", async () => {
        await pass.moveDone(p, to, { label: "P's prepare", names: await pass.typedNames("p") });
        expect((await p.readPlan()).cloudflareMove?.step, "P's move").toBe("prepared");
        await pass.moveDone(q, to, { label: "Q's prepare", names: await pass.typedNames("q") });
        expect((await q.readPlan()).cloudflareMove?.step, "Q's move").toBe("prepared");
        const status = await p.opscrewOk("status");
        expect(status.output.includes("prepared in the new account"), p.tail(status.output)).toBe(
          true,
        );
        await pass.moveDone(p, ["--abort"], {
          label: "P's abort",
          names: await pass.typedNames("p"),
        });
        expect((await p.readPlan()).cloudflareMove, "P's move after its abort").toBeUndefined();
        expect(await pass.zoneIn("b"), "B's zone, with Q's mark in it").toBeDefined();
        await pass.moveDone(q, ["--abort"], {
          label: "Q's abort",
          names: await pass.typedNames("q"),
        });
        expect((await q.readPlan()).cloudflareMove, "Q's move after its abort").toBeUndefined();
      });
      expect(failures, "requests that failed during the rehearsal (SC-2806)").toEqual([]);
    },
  );

  leg.step(
    "B holds nothing of P or Q and no zone of the name; A's inventory is unchanged (SC-2806)",
    minutes(15),
    async () => {
      expect(await pass.zoneIn("b"), "B's zone after both aborts").toBeUndefined();
      expect(await pass.leftovers("b", false), "what B holds of P and Q").toEqual([]);
      const after = (await pass.inventory("a")).inventory;
      expect(inventoryChanges(before as NonNullable<typeof before>, after), "A's changes").toEqual(
        [],
      );
    },
  );
});

// ---------------------------------------------------------------------------------------------

const L3 = legTitle("L3", "prepare P, Q and every real app in B, under load");

describe.skipIf(L3.skip)(L3.title, () => {
  const pass = new MovePass(ENV);
  const leg = new Leg(pass, "L3");
  const { p, q, pEnvs } = pass;
  const to = () => ["--to", pass.pass().accounts.b];

  leg.step(
    "prepare P; until Q is prepared, --switch refuses and names Q's hostname",
    hours(3),
    async () => {
      const { failures } = await pass.underLoad("L3 prepare P", async () => {
        await pass.moveDone(p, to(), { label: "P's prepare", names: await pass.typedNames("p") });
        if ((await q.readPlan()).cloudflareMove?.step === "prepared") {
          pass.log(
            "Q is prepared already (L3 ran before): the switch's refusal is not checked again",
          );
          return;
        }
        const refused = await p.opscrew("cloudflare", "move", "--switch");
        expect(refused.exitCode, p.tail(refused.output)).toBe(1);
        expect(
          refused.output.includes(pass.app("q").hostname),
          `the switch's refusal names Q's hostname:\n${p.tail(refused.output)}`,
        ).toBe(true);
        const real = (await pass.realHosts()).filter((host) => refused.output.includes(host));
        pass.log(`the switch refused, naming Q's hostname and ${real.length} real app hostname(s)`);
      });
      expect(failures, "requests that failed while P was prepared (SC-2802)").toEqual([]);
    },
  );

  leg.step(
    "prepare Q while P's app writes objects; `opscrew status` shows both prepared",
    hours(3),
    async () => {
      const { failures } = await pass.underLoad("L3 prepare Q", async () => {
        const project = composeProjectOf(await p.readPlan());
        const writes = execOn(await keptShell(p, pEnvs, "p-l3"))(
          objectsCommand(project, true, `${pass.pass().runId}-l3`),
        );
        await pass.moveDone(q, to(), { label: "Q's prepare", names: await pass.typedNames("q") });
        await writes;
        for (const run of [p, q]) {
          const status = await run.opscrewOk("status");
          expect(
            status.output.includes("prepared in the new account"),
            `opscrew status:\n${run.tail(status.output)}`,
          ).toBe(true);
        }
      });
      expect(failures, "requests that failed while Q was prepared (SC-2802)").toEqual([]);
    },
  );

  leg.step(
    "B's pending zone: Email Routing there (read only, never turned on), records made from data, both apps' marks",
    minutes(10),
    async () => {
      const state = pass.pass();
      const zone = await pass.zoneIn("b");
      expect(zone?.status, "B's zone").toBe("pending");
      const id = zone?.id ?? "";
      const answers: string[] = [];
      for (const path of ["email/routing", "email/routing/dns"]) {
        const got = await pass.b.call("GET", `/zones/${id}/${path}`);
        const body = got.json as
          | {
              success?: boolean;
              errors?: { code?: number; message?: string }[];
              result?: { enabled?: boolean; status?: string } | unknown[];
            }
          | undefined;
        const error = body?.errors?.[0];
        const shown = Array.isArray(body?.result)
          ? `${body.result.length} record(s)`
          : `enabled ${String((body?.result as { enabled?: boolean } | undefined)?.enabled)}, status ${String((body?.result as { status?: string } | undefined)?.status)}`;
        answers.push(
          `GET ${path}: HTTP ${got.status}${error === undefined ? "" : `, code ${error.code}: ${error.message}`}; ${shown}`,
        );
      }
      state.figures["L3 Email Routing on B's pending zone"] = pass.scrub(answers.join("; "));
      pass.log(state.figures["L3 Email Routing on B's pending zone"]);
      const { records } = await pass.inventory("b");
      const fromData = dataRecords(records);
      state.figures["L3 records made from data in B"] =
        fromData.length === 0
          ? "none"
          : fromData
              .map((r) => `${r.type}: content ${r.contentFilled ? "filled" : "empty"}`)
              .join("; ");
      pass.log(`records made from data in B: ${state.figures["L3 records made from data in B"]}`);
      const marks = recordKinds(records).marks.map((record) => record.name);
      for (const which of ["p", "q"] as const) {
        const app = pass.app(which).appName as string;
        expect(
          marks.some((name) => name.includes(app)),
          `${which.toUpperCase()}'s mark in B`,
        ).toBe(true);
      }
    },
  );

  leg.step(
    "every real app prepared by the lead from its repository: the switch's coverage names no hostname",
    minutes(30),
    async (): Promise<StepWait | undefined> => {
      const { result: ran, failures } = await pass.underLoad("L3 coverage", () =>
        p.opscrew("cloudflare", "move", "--switch"),
      );
      expect(failures, "requests that failed during the coverage check (SC-2802)").toEqual([]);
      if (nextMoveCommand(ran.output) !== undefined) {
        pass.log(
          "the switch's coverage holds every OpsCrew name in the zone: it shows its plan, not approved here",
        );
        return undefined;
      }
      pass.log(`the switch refused:\n${p.tail(ran.output, 30)}`);
      return {
        wait: `the switch's coverage names hostnames no prepared app holds (above, masked): prepare each real app from its repository (\`opscrew cloudflare move --to <B>\`).`,
      };
    },
  );
});

// ---------------------------------------------------------------------------------------------

for (const name of ["L4a", "L4b"] as const) {
  const at =
    name === "L4a"
      ? "at a registrar OpsCrew drives"
      : "at Cloudflare Registrar (its dashboard move between accounts)";
  const L4 = legTitle(name, `the switch ${at}, under load, with the probes`);

  describe.skipIf(L4.skip)(L4.title, () => {
    const pass = new MovePass(ENV);
    const leg = new Leg(pass, name);
    const { p, q } = pass;
    const outputs: string[] = [];

    leg.step(
      "--switch: the zone typed, DNSSEC's wait when it is on, the nameservers, the activation, the certificates; the gap measured",
      hours(12),
      async (): Promise<StepWait | undefined> => {
        const state = pass.pass();
        if (name === "L4a") Object.assign(p.env, pass.settings.registrarEnv);
        const zone = zoneName(pass.settings.domain);
        const started = Date.now();
        const switched = async (): Promise<StepWait | undefined> => {
          for (let round = 1; round <= 6; round++) {
            const outcome = await pass.move(p, ["--switch"], {
              label: "the switch",
              names: [zone],
            });
            outputs.push(...outcome.outputs);
            if (outcome.kind === "done") return undefined;
            const wait = waitOf(outcome.steps);
            pass.log(`the switch stopped:\n${pass.scrub(outcome.steps.join("\n"))}`);
            if (wait.kind === "time") return { wait: `DNSSEC's wait: after ${wait.after}.` };
            if (wait.kind === "measuring") continue;
            if (wait.kind === "other")
              throw new Error("The switch stopped on something it doesn't wait for (above).");
            pass.log(
              "waiting up to 6 hours for the delegation to name the new account's nameservers",
            );
            const seen = await waitFor(
              "the delegation naming the new account's nameservers",
              hours(6),
              async () => ((await pass.delegatedToB()) ? true : undefined),
              60_000,
            ).catch(() => false);
            if (!seen) {
              return {
                wait: "the registrar's change: once the new account's nameservers are set (at Cloudflare Registrar, the move accepted in B's dashboard).",
              };
            }
          }
          return { wait: "the switch's measuring, which goes on with the times it kept." };
        };
        const probed = await pass.withProbes(() => pass.underLoad(`${name} switch`, switched));
        const since = probed.delegatedAt ?? started;
        state.figures[`${name} probes`] = probeFigures(probed.samples, since).join("; ");
        pass.log(`the probes, from the delegation's change: ${state.figures[`${name} probes`]}`);
        const all = outputs.join("\n");
        state.figures[`${name} the switch plan names Email Routing`] = all.includes("Email Routing")
          ? "yes"
          : "no (T2828)";
        state.figures[`${name} the registrar told from B's zone's record`] = all.includes(
          "told the registrar of",
        )
          ? "yes"
          : "no";
        const times = (outputs.at(-1) ?? "")
          .split(/\r?\n/)
          .filter((line) => /switched|answered over HTTPS/.test(line));
        if (times.length > 0)
          state.figures[`${name} the switch's times`] = pass.scrub(times.join(" "));
        const refusals = all
          .split(/\r?\n/)
          .filter((line) => /Worker/.test(line) && /refus|assigned/i.test(line));
        if (refusals.length > 0) {
          state.figures[`${name} Workers custom domain refusals`] = pass.scrub(
            refusals.join(" | "),
          );
        }
        return probed.result.result;
      },
    );

    leg.step(
      "after the switch: B's zone active, A's moved, DNSSEC in B as at the start; P's answer before its finish (O2)",
      minutes(30),
      async () => {
        const state = pass.pass();
        const b = await pass.zoneIn("b");
        expect(b?.status, "B's zone").toBe("active");
        const a = await pass.zoneIn("a");
        state.figures[`${name} A's zone after the switch`] = a?.status ?? "gone";
        if (state.dnssec?.dsPublished === true) {
          const dnssec = await result<{ status?: string }>(pass.b, `/zones/${b?.id}/dnssec`);
          state.figures[`${name} B's DNSSEC`] =
            "unreadable" in dnssec ? dnssec.unreadable : String(dnssec.value?.status);
        }
        const answer = await fetch(await pass.healthUrl("p"), {
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        }).catch((error: unknown) => error);
        state.figures[`${name} P between the switch and its finish (O2)`] =
          answer instanceof Response ? `HTTP ${answer.status}` : String(answer);
        pass.log(
          `P before its finish: ${state.figures[`${name} P between the switch and its finish (O2)`]}`,
        );
      },
    );

    leg.step(
      "a deploy of Q between the switch and its finish goes through B's Access (the deploy's _NEW fallback)",
      minutes(45),
      async () => {
        await q.mergeChange("e2e: a deploy between the switch and the finish");
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------

const L5 = legTitle("L5", "every finish; the data in B; a restore and a deploy each; A empty");

describe.skipIf(L5.skip)(L5.title, () => {
  const pass = new MovePass(ENV);
  const leg = new Leg(pass, "L5");
  const { p, q, pEnvs } = pass;

  leg.step(
    "P's finish: the R2 window (--allow-downtime), B's secrets and a deploy, the states, A's pieces after the typed names; P's objects in B (SC-2804)",
    hours(2),
    async () => {
      const project = composeProjectOf(await p.readPlan());
      const inA = await execOn(await keptShell(p, pEnvs, "p-before"))(
        objectsCommand(project, false, pass.pass().runId),
      );
      await pass.underLoad("L5 P's finish", async () =>
        pass.moveDone(p, ["--finish"], {
          label: "P's finish",
          names: await pass.typedNames("p"),
          downtime: true,
        }),
      );
      expect((await p.readPlan()).cloudflareMove, "P's move after its finish").toBeUndefined();
      await pass.commitMoved(p);
      await pass.markMoved("p");
      await p.waitForHealth(minutes(10), true, await pass.healthUrl("p"));
      const inB = await execOn(await keptShell(p, pEnvs, "p-after"))(
        objectsCommand(project, false, pass.pass().runId),
      );
      expect(inB, "P's objects in B's bucket, as the app lists them").toBe(inA);
    },
  );

  leg.step(
    "Q's finish: the connector takes B's token, B's Access credentials, the states; Q's copies in B with the same checksums (SC-2804)",
    hours(2),
    async () => {
      await requireDocker("The pass reads Q's copies with rclone, from its pinned image in Docker");
      await pass.underLoad("L5 Q's finish", async () =>
        pass.moveDone(q, ["--finish"], {
          label: "Q's finish",
          names: await pass.typedNames("q"),
          downtime: true,
        }),
      );
      expect((await q.readPlan()).cloudflareMove, "Q's move after its finish").toBeUndefined();
      await pass.commitMoved(q);
      await pass.markMoved("q");
      await q.rememberOutputs(TUNNEL_OUTPUTS);
      await q.waitForHealth(minutes(10), true, await pass.healthUrl("q"));
      const inB = await pass.copies("b");
      const missing = Object.entries(pass.app("q").copies ?? {})
        .filter(([object, sha]) => inB[object] !== sha)
        .map(([object]) => object);
      expect(missing, "Q's copies missing in B's bucket or with another checksum").toEqual([]);
    },
  );

  leg.step("a restore of Q from its copy in B's bucket works (SC-2804)", minutes(30), async () => {
    const app = pass.app("q");
    const [id] = app.snapshots ?? [];
    if (id === undefined || app.ageKey === undefined || app.value === undefined) {
      throw new Error("L1 recorded no snapshot, age key or value of Q.");
    }
    const args = [id, "--from", "offsite", "--key-file", app.ageKey];
    const first = await q.opscrew("restore", ...args);
    if (first.output.includes("--allow-other-version")) args.push("--allow-other-version");
    await approvedRestore(q, args);
    await readValue(`https://${app.hostname}`, app.value);
  });

  leg.step(
    "a deploy after the finish succeeds for P and Q (Q's through B's Access); the SSH hostname with B's service token",
    hours(1),
    async () => {
      await p.mergeChange("e2e: P's deploy after the move");
      await q.mergeChange("e2e: Q's deploy after the move");
      const state = pass.pass();
      state.figures["L5 SSH probe, B's service token"] = await pass.sshProbe();
      pass.log(state.figures["L5 SSH probe, B's service token"]);
    },
  );

  leg.step(
    "A holds nothing of P or Q but the moved zone, the Zero Trust organization and the PIN login (SC-2805); A's origin certificates as Cloudflare lists them",
    minutes(15),
    async () => {
      const state = pass.pass();
      expect(await pass.leftovers("a", false), "what A holds of P and Q").toEqual([]);
      const a = await pass.zoneIn("a");
      state.figures["L5 A's zone"] = a?.status ?? "gone";
      if (a !== undefined) {
        const certificates = await pass.a.call("GET", `/certificates?zone_id=${a.id}`);
        const body = certificates.json as
          | { result?: unknown[]; errors?: { code?: number }[] }
          | undefined;
        state.figures["L5 A's origin certificates for the moved zone"] =
          `HTTP ${certificates.status}${body?.errors?.[0]?.code === undefined ? "" : ` code ${body.errors[0].code}`}, ${body?.result?.length ?? 0} listed`;
      }
      const zeroTrust = await pass.a.zeroTrust(state.accounts.a);
      state.figures["L5 A's Zero Trust"] =
        `organization ${zeroTrust.organization === undefined ? "none" : "kept"}, ${zeroTrust.oneTimePins.length} PIN login(s)`;
      for (const key of [
        "L5 A's zone",
        "L5 A's origin certificates for the moved zone",
        "L5 A's Zero Trust",
      ]) {
        pass.log(`${key}: ${state.figures[key]}`);
      }
    },
  );

  leg.step("every real app answers from B, once the lead finished each", minutes(10), async () => {
    expect((await pass.servingZone()).side, "the account serving the zone").toBe("b");
    const failing: string[] = [];
    for (const [at, host] of (await pass.realHosts()).entries()) {
      const answer = await fetch(`https://${host}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
      if (answer === undefined || answer.status >= 500) {
        failing.push(
          `real ${at + 1}: ${answer === undefined ? "no answer" : `HTTP ${answer.status}`}`,
        );
      }
    }
    expect(failing, "the real apps that don't answer from B").toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

const L6 = legTitle("L6", "the leak search over the whole pass; P and Q destroyed; the cleanup");

describe.skipIf(L6.skip)(L6.title, () => {
  const pass = new MovePass(ENV);
  const leg = new Leg(pass, "L6");
  const apps = () =>
    (["p", "q"] as const).flatMap((which) => {
      const app = pass.state?.apps[which];
      return app?.appName === undefined
        ? []
        : [{ which, app, run: which === "p" ? pass.p : pass.q }];
    });

  leg.step(
    "a move a failed leg left is finished (after the switch) or aborted (before it)",
    hours(3),
    async () => {
      for (const { which, run } of apps()) {
        if ((await run.readPlan()).cloudflareMove === undefined) continue;
        const label = `${which.toUpperCase()}'s move left half-way`;
        if ((await pass.zoneIn("b"))?.status === "active") {
          await pass.moveDone(run, ["--finish"], {
            label,
            names: await pass.typedNames(which),
            downtime: true,
          });
          await pass.commitMoved(run);
          await pass.markMoved(which);
        } else {
          await pass.moveDone(run, ["--abort"], { label, names: await pass.typedNames(which) });
        }
      }
    },
    { always: true },
  );

  leg.step(
    "no secret, key or address in any output, commit, pull request, plan, audit entry or state file of the whole pass (SC-2807)",
    minutes(20),
    async () => {
      if (pass.state === undefined) return;
      const problems = await pass.leaks();
      for (const problem of problems) pass.log(`leak: ${problem}`);
      expect(problems, "nothing leaked").toEqual([]);
    },
    { always: true },
  );

  leg.step(
    "P and Q destroyed with their data, in the account that serves the zone",
    hours(1),
    async () => {
      if (pass.state === undefined) return;
      const { side } = await pass.servingZone();
      for (const { which, app, run } of apps()) {
        if (app.destroyed === true) continue;
        run.env = await pass.cliEnv(run, { moved: side === "b" });
        await (which === "p" ? pass.pEnvs : pass.qEnvs).destroy("prod", undefined, [
          "--delete-data",
        ]);
        app.destroyed = true;
        await pass.save();
      }
    },
    { always: true },
  );

  leg.step(
    "the throwaway server deleted; what is left of P and Q in either account removed and listed; the repositories reset; A's moved zone left to Cloudflare",
    minutes(30),
    async () => {
      const state = pass.state;
      if (state === undefined) return;
      const problems: string[] = [];
      const { hcloudToken } = pass.settings;
      problems.push(
        ...(await deleteThrowaway({
          token: hcloudToken,
          runId: state.runId,
          ids: state.apps.q?.server === undefined ? {} : { serverId: state.apps.q.server.id },
        })),
      );
      const pName = state.apps.p?.appName;
      if (pName !== undefined && (await hetznerAppLeft(hcloudToken, pName)).length > 0) {
        pass.log("P's server was left at Hetzner: deleting it");
        await deleteHetznerApp(hcloudToken, pName);
        problems.push(
          ...(await hetznerAppLeft(hcloudToken, pName)).map((left) => `Hetzner: ${left}`),
        );
      }
      for (const side of ["a", "b"] as const) {
        for (const left of await pass.leftovers(side, true))
          pass.log(`removed what was left: ${left}`);
        problems.push(...(await pass.leftovers(side, false)));
      }
      const serving = await pass.servingZone().catch(() => undefined);
      if (serving !== undefined) {
        const hosts = apps().flatMap(({ app }) => [app.hostname, `www.${app.hostname}`]);
        const cf = serving.side === "a" ? pass.a : pass.b;
        problems.push(
          ...(await cf.removeRulesOfRun(serving.zone, await cf.sharedEntrypoints(serving.zone), {
            hostnames: hosts,
            log: pass.log,
          })),
        );
      }
      for (const { run } of apps()) {
        await run
          .restoreMain()
          .catch((error: unknown) => problems.push(`main of ${run.github.name}: ${String(error)}`));
        await run.github
          .reset()
          .catch((error: unknown) => problems.push(`reset ${run.github.name}: ${String(error)}`));
      }
      for (const problem of problems) pass.log(`left: ${problem}`);
      expect(problems, "what the cleanup left").toEqual([]);
      pass.log("nothing of the pass is left; its folder goes");
      await pass.removeFolder();
    },
    { always: true },
  );
});

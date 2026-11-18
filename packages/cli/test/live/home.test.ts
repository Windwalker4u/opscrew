/**
 * The live pass of feature 029 (docs/e2e.md "Hosting at home"), with `OPSCREW_E2E_HOME=1`: a
 * Hetzner Arm server set up as the user's server at home (examples/flask-sqlite, PostgreSQL added),
 * a Hetzner Cloud firewall on it as the router, a second throwaway server as the outside scanner,
 * and everything else real: Cloudflare, GitHub's machines, the address updater, the deploys. In
 * legs run one at a time with `-t "H<n>:"`, each its own process; the pass keeps its state in its
 * folder under `OPSCREW_TEST_TMP` (`home-support.ts`).
 * - **H0** preflight: the zone, no `e2e-` record left, both updater tokens (the inverse probes),
 *   the repository private.
 * - **H1** proxied over IPv4: the server, interview, design, adapt, provision, the first deploy on
 *   the server's runner, verify; the minutes (SC-2901).
 * - **H2** a new address behind the proxy: the updater's write, the edge (SC-2902, O10), status.
 * - **H3** 443 closed at the router: verify names it and changes nothing; 443 back.
 * - **H4** DNS only: the switch, the certificate, SSH forwarded by mistake and the scanner
 *   (SC-2904), a new address again.
 * - **H5** the AAAA record goes with the server's IPv6 address and comes back with it.
 * - **H6** behind the proxy over IPv6 (`target.home.ipv4: false`), O9, the scanner.
 * - **H8** a restore drill and the database check in `advise` (before H7, which removes the server).
 * - **H7** rotate the updater's token, the switch to the tunnel, destroy, the leak scan and the
 *   cleanup, its last two steps run even after a failure.
 * Every command runs as a script runs it: each printed hash approved, each typed name checked.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AccountPermissionNeed,
  CloudflareClient,
  type ZonePermissionNeed,
} from "@opscrew/connector-cloudflare";
import { Redactor } from "@opscrew/core";
import { OUTSIDE_CHECK_WORKFLOW_FILE, runnerLabel, usesTunnel } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { httpRequest, minutes, servedCertificate, sleep, waitFor } from "./cloud";
import { leakSearchValues } from "./cloudflare-move-support";
import { expectNoRunner, jobsOnRunner, TESTER_LABEL, waitForRunner } from "./environment-checks";
import { destroyConfirmArgs } from "./harness";
import {
  adviceOf,
  HOME_EXAMPLE,
  HOME_GATE,
  type HomeLeg,
  HomePass,
  Leg,
  legSkip,
  routerRules,
  type ScanResult,
  sha256,
  testNetAddress,
  withPostgres,
} from "./home-support";
import { publicIpv4, repoInfo } from "./portainer-cloud";
import { inContainer, MOVE_SERVICES, psql } from "./retarget-anywhere-support";
import { takenSnapshotId } from "./snapshots-support";
import { addressLinesOutsidePurpose, duration, printedHash, runHostname } from "./support";

const ENV = process.env;
/** The tunnel's and the Access service token's secrets, for the leak scan (H7's switch). */
const TUNNEL_OUTPUTS = [
  "tunnel_token",
  "deploy_service_token_client_secret",
  "deploy_service_token_client_id",
];
/** The zone permissions the updater's token must not have (OpsCrew's probes), besides DNS. */
const OTHER_ZONE_NEEDS: readonly ZonePermissionNeed[] = [
  "http_config_settings",
  "http_request_firewall_custom",
  "http_request_dynamic_redirect",
  "ssl",
  "settings",
];
/** The account permissions the updater's token must not have. */
const ACCOUNT_NEEDS: readonly AccountPermissionNeed[] = [
  "tunnel",
  "access-apps",
  "access-service-tokens",
  "access-organization",
  "r2",
  "workers",
];
/** The table H8 locks, in the app's PostgreSQL. */
const LOCKED_TABLE = "e2e_home_rows";
/** H8's script on the server that holds the lock and waits for it. */
const LOCKS_SCRIPT = "/root/opscrew-e2e-locks.sh";
/** Where H5 keeps the server's IPv6 addresses while they are off its interface. */
const SAVED_IPV6 = "/root/opscrew-e2e-ipv6";

/** The leg's describe title, or why it is skipped (logged too when the gate is set). */
function legTitle(leg: HomeLeg, title: string): { skip: boolean; title: string } {
  const why = legSkip(ENV);
  const full = `live home hosting, ${leg}: ${title}`;
  if (why === undefined) return { skip: false, title: full };
  if (ENV[HOME_GATE] === "1") {
    console.warn(`OpsCrew E2E (home, ${leg}): skipped, ${why} (docs/e2e.md).`);
  }
  return { skip: true, title: `${full} (skipped: ${why})` };
}

/** The plan's `target.home`, absent when the server isn't at home (or serves through the tunnel). */
function homeOf(plan: DeployPlan): { ipv4: boolean } | undefined {
  return plan.target.provider === "own" ? plan.target.home : undefined;
}

/** The scanner's results as one line for the figures. */
function scanLine(found: Record<string, ScanResult>): string {
  return Object.entries(found)
    .map(([port, result]) => `${port} ${result}`)
    .join(", ");
}

/**
 * A new home address, as the stand-in makes one: the updater's A record set to a TEST-NET address,
 * then the time until the updater writes the server's address back, and from there until the site
 * answers again (through Cloudflare when `proxied`, else from the server). No address is printed.
 */
async function addressChange(
  pass: HomePass,
  proxied: boolean,
): Promise<{ write: string; site: string }> {
  const ipv4 = pass.run.ipv4();
  const record = (await pass.updaterRecords()).find((one) => one.type === "A");
  if (record?.content !== ipv4) {
    throw new Error("The updater's A record doesn't hold the server's address before the change.");
  }
  await pass.setRecordContent(record, testNetAddress());
  const changed = Date.now();
  pass.log("the A record holds a TEST-NET address now; waiting for the updater (every 2 minutes)");
  await pass.waitForRecords(
    "the updater writing the server's address back",
    minutes(10),
    (records) => records.some((one) => one.type === "A" && one.content === ipv4),
  );
  const written = Date.now();
  const url = await pass.healthUrl();
  await waitFor(
    `${url} answering 200 ${proxied ? "through Cloudflare" : "from the server"}`,
    minutes(10),
    async () => {
      const answer = await httpRequest(url, { timeoutMs: 10_000 });
      return answer.status === 200 && (answer.headers["cf-ray"] !== undefined) === proxied
        ? true
        : undefined;
    },
    3_000,
  );
  return { write: duration(written - changed), site: duration(Date.now() - written) };
}

// ---------------------------------------------------------------------------------------------

const H0 = legTitle("H0", "preflight: the zone, both updater tokens, the repository");

describe.skipIf(H0.skip)(H0.title, () => {
  const pass = new HomePass(ENV);
  const leg = new Leg(pass, "H0");
  const { run, settings } = pass;

  leg.step(
    "the zone of the pass's hostname, this computer's address, and no e2e record left in the zone",
    minutes(5),
    async () => {
      const probe = runHostname(settings.domain, "probe", "home");
      const zone = await pass.cloudflare.zoneOf(probe);
      if (probe !== `${probe.split(".")[0]}.${zone.name}`) {
        throw new Error(
          "The pass's hostname must be directly below the Cloudflare zone, which its free edge certificate covers: set OPSCREW_E2E_DOMAIN to the zone or a name directly below it.",
        );
      }
      const tester = await publicIpv4();
      run.scrubber.add(tester, TESTER_LABEL);
      pass.startPass(tester, zone);
      const records = await pass.cloudflare.list<{ name: string }>(`/zones/${zone.id}/dns_records`);
      const left = [
        ...new Set(
          records
            .map((record) => record.name)
            .filter((name) => name.split(".").some((label) => label.startsWith("e2e-"))),
        ),
      ];
      expect(left, "records of earlier e2e runs left in the zone").toEqual([]);
    },
  );

  leg.step(
    "both updater tokens: active user tokens, not OpsCrew's, each reading the zone's DNS and nothing else OpsCrew probes (the inverse probes)",
    minutes(5),
    async () => {
      const zone = pass.zone();
      const redactor = new Redactor();
      const client = (token: string) => new CloudflareClient({ token, fetch, redactor });
      const own = await client(settings.cloudflareToken).verifyToken();
      const ids: string[] = [];
      for (const [label, token] of [
        ["first", settings.updaterTokens.a],
        ["second", settings.updaterTokens.b],
      ] as const) {
        redactor.addLiteral(token, `${label} updater token`);
        expect(token === settings.cloudflareToken, `the ${label} updater token is OpsCrew's`).toBe(
          false,
        );
        const cf = client(token);
        const check = await cf.verifyToken();
        expect(check.ok, `the ${label} updater token works: ${check.message}`).toBe(true);
        expect(check.id, `the ${label} updater token is a user token`).toBeDefined();
        expect(check.status, `the ${label} updater token`).toBe("active");
        expect(check.id === own.id, `the ${label} updater token is OpsCrew's`).toBe(false);
        ids.push(check.id as string);
        expect(
          (await cf.zonePermissions(zone.id, ["dns"])).missing,
          `the ${label} updater token reading the zone's DNS`,
        ).toEqual([]);
        const reached: string[] = [];
        const refused: string[] = [];
        for (const need of OTHER_ZONE_NEEDS) {
          const { missing } = await cf.zonePermissions(zone.id, [need]);
          (missing.length === 0 ? reached : refused).push(need);
        }
        for (const need of ACCOUNT_NEEDS) {
          try {
            const { missing } = await cf.accountPermissions(zone.accountId, [need]);
            (missing.length === 0 ? reached : refused).push(need);
          } catch (error) {
            // An account without Access gives no token any Access permission.
            if ((error as { code?: string }).code !== "PHASE_PRECONDITION") throw error;
            refused.push(`${need} (no Access in the account)`);
          }
        }
        pass.figure(
          `H0 the ${label} updater token's inverse probes`,
          `the zone's DNS read; refused: ${refused.join(", ")}${reached.length === 0 ? "" : `; reached: ${reached.join(", ")}`}${check.expiresOn === undefined ? "" : `; expires ${check.expiresOn}`}`,
        );
        expect(reached, `what else the ${label} updater token reaches`).toEqual([]);
      }
      expect(ids[0] === ids[1], "the two updater tokens are one token").toBe(false);
    },
  );

  leg.step(
    "the throwaway repository is private: a self-hosted runner never serves a public one",
    minutes(2),
    async () => {
      expect((await repoInfo(run.github)).private, "OPSCREW_E2E_GITHUB_REPO is private").toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------------------------

const H1 = legTitle(
  "H1",
  "proxied over IPv4: the home server, interview, design, provision, the first deploy, verify",
);

describe.skipIf(H1.skip)(H1.title, () => {
  const pass = new HomePass(ENV);
  const leg = new Leg(pass, "H1");
  const { run, settings } = pass;
  /** When the interview started (SC-2901 counts from there, the human steps aside). */
  let interviewed = 0;

  leg.step(
    "the home server, the cheapest Arm type, behind the router's firewall: 80 and 443 from anywhere, SSH from this computer only",
    minutes(30),
    async () => {
      const state = pass.pass();
      if (state.app !== undefined) {
        throw new Error(
          "H1 ran before and left its server: run H7 to remove it, then H0 and H1 again.",
        );
      }
      // Every name of the pass (the hostname, the app, the Hetzner labels) is this process's run id.
      state.runId = run.runId;
      const hostname = runHostname(settings.domain, run.runId, "home");
      await pass.inPassFolder(() =>
        run.prepareRepo({
          commit: `e2e: examples/${HOME_EXAMPLE} at home`,
          env: pass.accountEnv(),
        }),
      );
      await pass.recordApp({ hostname });
      const fingerprint = await run.createServer(routerRules(state.testerIpv4), "arm");
      await pass.recordApp({ fingerprint });
      await pass.recordApp({ firewallId: await pass.routerFirewallId() });
      state.tlsBefore = await pass.cloudflare.zoneTls(pass.zone(), [hostname, `www.${hostname}`]);
      const server = pass.app().server;
      pass.figure(
        "H1 the home server",
        `${server?.serverType} in ${server?.location}, ${server?.hourlyGross.toFixed(4)} EUR an hour`,
      );
    },
  );

  leg.step(
    "interview at home (server.home yes, server.serve proxy, server.sshFrom this computer) and design: no forwards needed, the server's runner; PostgreSQL added in plan.yaml",
    minutes(20),
    async () => {
      interviewed = Date.now();
      await run.initFix();
      await run.opscrewOk("analyze", "--no-ai");
      // examples/flask-sqlite has no project name: the app is named after the run instead.
      const name = `e2e-home-${pass.pass().runId}`;
      const file = run.paths().files.architecture;
      const architecture = await readArtifact("architecture", file);
      await writeArtifact("architecture", file, {
        ...architecture,
        facts: { ...architecture.facts, name },
      });
      await pass.interview("proxy");
      const designed = await run.opscrewOk("design", "--host-key", pass.app().fingerprint ?? "");
      expect(
        designed.output.includes("your router needs no forwards"),
        `design says the server needs no forwards:\n${run.tail(designed.output)}`,
      ).toBe(true);
      const plan = await run.readPlan();
      expect(plan.app.name, "the app's name").toBe(name);
      run.appName = name;
      await pass.recordApp();
      expect(homeOf(plan), "the plan's server at home").toEqual({ ipv4: true });
      expect(plan.environment?.runner, "deploys on the server's runner").toBe("server");
      expect(plan.dns.proxied, "behind Cloudflare's proxy").toBe(true);
      await writeArtifact("plan", run.paths().files.plan, withPostgres(plan));
      await run.opscrewOk("design");
      expect(
        (await run.readPlan()).services.map((service) => service.name),
        "design keeps PostgreSQL",
      ).toContain(MOVE_SERVICES.postgres);
    },
  );

  leg.step(
    "adapt, provision (the SSH table, the address updater, the web filter), the merges and the first deploy on the server's runner",
    minutes(90),
    async () => {
      await run.adaptAndMerge();
      await pass.provision("proxied over IPv4");
      await run.rememberSecretFile(run.paths().files.deployKey, "deploy-private-key");
      await run.rememberSecretFile(run.paths().files.statePassphrase, "state-passphrase");
      await run.rememberGeneratedValues();
      const deployed = await run.deployAny("the first deploy at home");
      const label = runnerLabel(await run.readPlan());
      const runner = await waitForRunner(run.github, label);
      const jobs = await jobsOnRunner(run.github, deployed, runner, label);
      expect(jobs.length, "the first deploy's jobs on the server's runner").toBeGreaterThan(0);

      const shell = run.shell();
      const app = run.app();
      const table = await shell.ok("nft list table inet opscrew");
      expect(
        table.includes(pass.pass().testerIpv4) && table.includes("dport 22"),
        "OpsCrew's SSH table lets this computer reach port 22",
      ).toBe(true);
      expect(
        await shell.ok(`systemctl is-active opscrew-dns-updater@${app}.timer`),
        "the updater's timer",
      ).toBe("active");
      expect(
        await shell.ok(`stat -c '%a %U' /etc/opscrew/dns-updater/${app}.token`),
        "the updater's token file, readable by root alone",
      ).toBe("600 root");
      const ipv4 = run.ipv4();
      await pass.waitForRecords(
        "the updater's proxied A record with the server's address, and no AAAA",
        minutes(10),
        (records) =>
          records.some((one) => one.type === "A" && one.proxied && one.content === ipv4) &&
          !records.some((one) => one.type === "AAAA"),
      );
    },
  );

  leg.step(
    "verify: the outside check from GitHub's machines and the updater pass; the minutes from the interview to a working site (SC-2901)",
    minutes(30),
    async () => {
      await run.waitForHealth(minutes(10), true, await pass.healthUrl());
      pass.figure(
        "H1 from the interview to a working site, the human steps aside (SC-2901)",
        duration(Date.now() - interviewed),
      );
      await run.opscrewOk("verify");
      expect(await pass.outsideCheck(), "the outside check").toEqual({
        mode: "proxied",
        http: "ok",
        https: "ok",
      });
    },
  );
});

// ---------------------------------------------------------------------------------------------

const H2 = legTitle("H2", "a new home address behind the proxy: the updater writes it back");

describe.skipIf(H2.skip)(H2.title, () => {
  const pass = new HomePass(ENV);
  const leg = new Leg(pass, "H2");
  const { run } = pass;

  leg.step(
    "the A record set to a TEST-NET address: the updater writes the server's back, and the site answers through Cloudflare again (SC-2902, O10)",
    minutes(25),
    async () => {
      const times = await addressChange(pass, true);
      pass.figure("H2 a new address to the updater's write, proxied (SC-2902)", times.write);
      pass.figure("H2 the write to Cloudflare's edge using the restored origin (O10)", times.site);
    },
  );

  leg.step(
    "status shows the updater's last write, and no address (SC-2905)",
    minutes(5),
    async () => {
      const status = await run.opscrewOk("status");
      for (const said of ["last write", "hidden: behind Cloudflare's proxy"]) {
        expect(
          status.output.includes(said),
          `status says "${said}":\n${run.tail(status.output)}`,
        ).toBe(true);
      }
      const { addresses } = leakSearchValues(run.scrubber.entries());
      expect(
        addressLinesOutsidePurpose(
          status.output,
          addresses.map(({ value }) => value),
        ),
        "the lines of status with the server's address",
      ).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------------------------

const H3 = legTitle("H3", "a port not answering: verify names it and changes nothing");

describe.skipIf(H3.skip)(H3.title, () => {
  const pass = new HomePass(ENV);
  const leg = new Leg(pass, "H3");
  const { run } = pass;

  leg.step(
    "443 closed at the router: verify names port 443 and offers the tunnel, and the host plan's and the states' hashes don't change",
    minutes(30),
    async () => {
      const hostPlan = async () =>
        printedHash(
          (await run.opscrewOk("provision", "--plan-only", "--yes")).output,
          "Host plan hash",
        );
      const before = { host: await hostPlan(), states: await pass.stateHashes() };
      await pass.setRouter({ https: false });
      const verified = await run.opscrew("verify");
      expect(
        verified.exitCode,
        `verify fails while 443 doesn't answer:\n${run.tail(verified.output)}`,
      ).not.toBe(0);
      for (const said of [
        "Port 443 didn't answer from outside your home.",
        "a Cloudflare Tunnel works on any connection",
      ]) {
        expect(
          verified.output.includes(said),
          `verify says "${said}":\n${run.tail(verified.output)}`,
        ).toBe(true);
      }
      expect((await pass.outsideCheck()).https, "the outside check's port 443").toBe("failed");
      expect(await pass.stateHashes(), "the states' hashes after verify").toEqual(before.states);
      expect(await hostPlan(), "the host plan's hash after verify").toBe(before.host);
    },
  );

  leg.step(
    "443 open again at the router: verify passes",
    minutes(20),
    async () => {
      await pass.setRouter();
      await run.opscrewOk("verify");
      expect(await pass.outsideCheck(), "the outside check").toMatchObject({
        http: "ok",
        https: "ok",
      });
    },
    { always: true },
  );
});

// ---------------------------------------------------------------------------------------------

const H4 = legTitle(
  "H4",
  "DNS only: the switch, a public certificate, SSH forwarded by mistake, a new address",
);

describe.skipIf(H4.skip)(H4.title, () => {
  const pass = new HomePass(ENV);
  const leg = new Leg(pass, "H4");
  const { run } = pass;

  leg.step(
    "the switch from the proxy to DNS only (the app's name typed): 60-second records, a Let's Encrypt certificate, the deploy's health check through --resolve, the outside check",
    minutes(75),
    async () => {
      await pass.interview("dns-only");
      await run.opscrewOk("design");
      expect((await run.readPlan()).dns.proxied, "DNS only").toBe(false);
      await pass.provision("the switch to DNS only");
      await run.deployAny("DNS only at home");
      const { ipv4, ipv6 } = pass.app().server ?? {};
      await pass.waitForRecords(
        "the updater's 60-second A and AAAA records with the server's addresses, not proxied",
        minutes(10),
        (records) =>
          (["A", "AAAA"] as const).every((type) =>
            records.some(
              (one) =>
                one.type === type &&
                !one.proxied &&
                one.ttl === 60 &&
                one.content === (type === "A" ? ipv4 : ipv6),
            ),
          ),
      );
      await run.waitForHealth(minutes(10), false, await pass.healthUrl());
      const certificate = await servedCertificate(pass.app().hostname);
      expect(certificate.issuer, "the site's certificate").toMatch(/Let's Encrypt/);
      const workflow = await readFile(
        join(run.repo, (await run.readPlan()).cicd.workflowPath),
        "utf8",
      );
      expect(
        workflow.includes("--resolve"),
        "the deploy's health check goes through --resolve",
      ).toBe(true);
      await run.opscrewOk("verify");
      expect(await pass.outsideCheck(), "the outside check").toEqual({
        mode: "direct",
        http: "ok",
        https: "ok",
      });
    },
  );

  leg.step(
    "SSH forwarded by mistake at the router: the scanner over IPv4 and IPv6 finds 80 and 443 open and 22 closed by OpsCrew's table, and this computer still logs in (SC-2904, FR-2909)",
    minutes(40),
    async () => {
      await pass.setRouter({ sshFromAnywhere: true });
      const found = await pass.scan([22, 80, 443]);
      pass.figure("H4 the scanner's ports, DNS only, SSH forwarded by mistake", scanLine(found));
      for (const family of ["IPv4", "IPv6"]) {
        expect(found[`${family} 80`], `${family} port 80 from the scanner`).toBe("open");
        expect(found[`${family} 443`], `${family} port 443 from the scanner`).toBe("open");
        expect(found[`${family} 22`], `${family} port 22 from the scanner`).toMatch(
          /^(filtered|refused)$/,
        );
      }
      await run.shell().ok("true");
    },
  );

  leg.step("SSH from this computer only at the router again", minutes(5), () => pass.setRouter(), {
    always: true,
  });

  leg.step(
    "the A record set to a TEST-NET address with DNS only: the updater writes it back and the site answers from the server again (SC-2902)",
    minutes(25),
    async () => {
      const times = await addressChange(pass, false);
      pass.figure("H4 a new address to the updater's write, DNS only (SC-2902)", times.write);
      pass.figure("H4 the write to the site answering from the server, DNS only", times.site);
    },
  );
});

// ---------------------------------------------------------------------------------------------

const H5 = legTitle("H5", "the AAAA record follows the server's IPv6 address");

describe.skipIf(H5.skip)(H5.title, () => {
  const pass = new HomePass(ENV);
  const leg = new Leg(pass, "H5");
  const { run } = pass;
  const ipv6 = () => pass.app().server?.ipv6;

  leg.step(
    "the AAAA record holds the server's IPv6 address; with the address off the server's interface, the AAAA goes on the updater's next run",
    minutes(20),
    async () => {
      await pass.waitForRecords(
        "the updater's AAAA record with the server's IPv6 address",
        minutes(5),
        (records) => records.some((one) => one.type === "AAAA" && one.content === ipv6()),
      );
      await run
        .shell()
        .ok(
          `ip -6 -o addr show scope global | awk '{print $2" "$4}' > ${SAVED_IPV6} && test -s ${SAVED_IPV6} && while read dev address; do ip -6 addr del "$address" dev "$dev"; done < ${SAVED_IPV6}`,
        );
      const removed = Date.now();
      await pass.waitForRecords(
        "the updater removing the AAAA record and keeping the A record",
        minutes(10),
        (records) =>
          !records.some((one) => one.type === "AAAA") && records.some((one) => one.type === "A"),
      );
      pass.figure(
        "H5 the address off the interface to the AAAA record gone",
        duration(Date.now() - removed),
      );
    },
  );

  leg.step(
    "the server's IPv6 address back on its interface: the AAAA returns",
    minutes(20),
    async () => {
      await run
        .shell()
        .ok(
          `if [ -s ${SAVED_IPV6} ]; then while read dev address; do ip -6 addr add "$address" dev "$dev" 2> /dev/null || true; done < ${SAVED_IPV6}; ip -6 route show default | grep -q . || ip -6 route add default via fe80::1 dev "$(awk 'NR == 1 {print $1}' ${SAVED_IPV6})"; rm -f ${SAVED_IPV6}; fi`,
        );
      const back = Date.now();
      await pass.waitForRecords(
        "the updater writing the AAAA record with the server's IPv6 address again",
        minutes(10),
        (records) => records.some((one) => one.type === "AAAA" && one.content === ipv6()),
      );
      pass.figure("H5 the address back to the AAAA record back", duration(Date.now() - back));
    },
    { always: true },
  );
});

// ---------------------------------------------------------------------------------------------

const H6 = legTitle("H6", "behind the proxy over IPv6: an AAAA record only, the IPv6 web filter");

describe.skipIf(H6.skip)(H6.title, () => {
  const pass = new HomePass(ENV);
  const leg = new Leg(pass, "H6");
  const { run } = pass;

  leg.step(
    "behind the proxy over IPv6 (target.home.ipv4: false in plan.yaml), designed and provisioned: an AAAA record only, the IPv6 web filter on",
    minutes(75),
    async () => {
      await pass.interview("proxy");
      await run.opscrewOk("design");
      const plan = await run.readPlan();
      if (plan.target.provider !== "own" || plan.target.home === undefined) {
        throw new Error("design planned no server at home.");
      }
      await writeArtifact("plan", run.paths().files.plan, {
        ...plan,
        target: { ...plan.target, home: { ...plan.target.home, ipv4: false } },
      });
      await run.opscrewOk("design");
      const designed = await run.readPlan();
      expect(homeOf(designed), "design keeps target.home.ipv4: false").toEqual({ ipv4: false });
      expect(designed.dns.proxied, "behind Cloudflare's proxy").toBe(true);
      await pass.provision("behind the proxy over IPv6");
      await run.deployAny("behind the proxy over IPv6");
      const ipv6 = pass.app().server?.ipv6;
      await pass.waitForRecords(
        "the updater's proxied AAAA record with the server's IPv6 address, and no A record",
        minutes(10),
        (records) =>
          records.some((one) => one.type === "AAAA" && one.proxied && one.content === ipv6) &&
          !records.some((one) => one.type === "A"),
      );
      await run.shell().ok("nft list table inet opscrew-web");
    },
  );

  leg.step(
    "the site answers through Cloudflare over IPv4 to GitHub's machines and this computer (O9); the scanner over IPv6 finds 443 filtered",
    minutes(30),
    async () => {
      await run.waitForHealth(minutes(10), true, await pass.healthUrl());
      await run.opscrewOk("verify");
      expect(await pass.outsideCheck(), "the outside check").toMatchObject({
        mode: "proxied",
        https: "ok",
      });
      pass.figure(
        "H6 IPv4 visitors reached the AAAA-only proxied origin (O9)",
        "yes: GitHub's machines and this computer, through Cloudflare",
      );
      const found = await pass.scan([443], ["IPv6", "IPv4"]);
      pass.figure("H6 the scanner's ports, behind the proxy over IPv6", scanLine(found));
      expect(found["IPv6 443"], "IPv6 port 443 from the scanner").toBe("filtered");
    },
  );
});

// ---------------------------------------------------------------------------------------------

const H8 = legTitle(
  "H8",
  "a restore drill and the database check, on the home server with PostgreSQL",
);

describe.skipIf(H8.skip)(H8.title, () => {
  const pass = new HomePass(ENV);
  const leg = new Leg(pass, "H8");
  const { run } = pass;
  const app = () => run.app();
  const exec = (command: string) => run.shell().ok(command, minutes(5));
  const db = MOVE_SERVICES.postgres;
  let snapshot = "";

  /** Production's containers (id and start) and volumes, sorted. */
  const production = async () => ({
    containers: await exec(
      `docker ps -aq --no-trunc --filter label=com.docker.compose.project=${app()} | xargs -r docker inspect -f '{{.Id}} {{.State.StartedAt}}' | sort`,
    ),
    volumes: await exec(
      `docker volume ls -q --filter label=com.docker.compose.project=${app()} | sort`,
    ),
  });
  /** The drill's containers, volumes and networks still on the server. */
  const drillLeft = () => {
    const label = `label=com.docker.compose.project=${app()}-drill`;
    return exec(
      `docker ps -aq --filter ${label}; docker volume ls -q --filter ${label}; docker network ls -q --filter ${label}`,
    );
  };
  /** The test's own PostgreSQL sessions: `<name> <state> <wait event type>` each. */
  const sessions = () =>
    exec(
      inContainer(
        app(),
        db,
        psql(
          "select application_name || ' ' || state || ' ' || coalesce(wait_event_type, '-') from pg_stat_activity where application_name like 'opscrew-e2e-%' order by 1",
        ),
      ),
    );

  leg.step("a table in PostgreSQL, and a snapshot of the app", minutes(15), async () => {
    await waitFor(
      "PostgreSQL taking the test's table",
      minutes(5),
      () =>
        exec(
          inContainer(
            app(),
            db,
            psql(
              `create table if not exists ${LOCKED_TABLE} (id int primary key, v text); insert into ${LOCKED_TABLE} values (1, 'home') on conflict do nothing`,
            ),
          ),
        ),
      10_000,
    );
    const taken = await run.opscrewOk("snapshot");
    const id = takenSnapshotId(taken.output);
    if (id === undefined)
      throw new Error(`opscrew snapshot printed no id:\n${run.tail(taken.output)}`);
    snapshot = id;
  });

  leg.step(
    "restore --drill, approved by its hash: the parts restored, the app healthy on them, the copy removed; production's containers and volumes unchanged",
    minutes(30),
    async () => {
      const before = await production();
      const report = await pass.drill([snapshot]);
      expect(report.outcome, report.summary).toBe("healthy");
      expect(report.removal, "the copy").toBe("removed");
      expect(
        report.parts.map((part) => part.name),
        "the parts restored",
      ).toContain(db);
      expect(
        report.tables.find((table) => table.service === db)?.count ?? 0,
        "the restored PostgreSQL's tables",
      ).toBeGreaterThan(0);
      expect(await production(), "production's containers and volumes").toEqual(before);
      expect(await drillLeft(), "what is left of the drill's copy").toBe("");
      pass.figure(
        "H8 the drill",
        `${report.outcome}, healthy after ${report.health?.seconds ?? "?"} s; parts ${report.parts.map((part) => part.name).join(", ")}`,
      );
    },
  );

  leg.step(
    "restore --drill --keep: the copy's networks are internal and a request from it to the internet fails; --drill --remove removes it; status shows the last drill",
    minutes(30),
    async () => {
      const report = await pass.drill([snapshot, "--keep"]);
      expect(report.outcome, report.summary).toBe("healthy");
      expect(report.removal, "the copy").toBe("kept");
      const project = `${app()}-drill`;
      const internal = (
        await exec(
          `docker network ls -q --filter label=com.docker.compose.project=${project} | xargs -r docker network inspect -f '{{.Internal}}'`,
        )
      )
        .split(/\s+/)
        .filter((flag) => flag !== "");
      expect(
        internal.length > 0 && internal.every((flag) => flag === "true"),
        "every network of the copy is internal",
      ).toBe(true);
      expect(
        await exec(inContainer(project, "app", `python -c "print('ok')"`)),
        "python in the copy",
      ).toBe("ok");
      const outbound = await run
        .shell()
        .run(
          inContainer(
            project,
            "app",
            `python -c "import urllib.request; urllib.request.urlopen('https://1.1.1.1', timeout=5)"`,
          ),
          minutes(2),
        );
      expect(outbound.exitCode, "a request from the copy to the internet").not.toBe(0);
      await pass.removeDrill();
      expect(await drillLeft(), "what is left of the kept copy").toBe("");
      const status = await run.opscrewOk("status");
      expect(
        status.output.includes(`Last restore drill: ${snapshot}`),
        `status shows the last drill:\n${run.tail(status.output)}`,
      ).toBe(true);
    },
  );

  leg.step(
    "a session holding a lock another waits for, and a transaction left open: advise names both, its database check within 20 seconds, and changes nothing",
    minutes(20),
    async () => {
      const script = [
        `c=$(docker ps -q --filter label=com.docker.compose.project=${app()} --filter label=com.docker.compose.service=${db})`,
        `( printf 'BEGIN;\\nLOCK TABLE ${LOCKED_TABLE} IN ACCESS EXCLUSIVE MODE;\\n'; sleep 1500 ) | timeout 1600 docker exec -i -e PGAPPNAME=opscrew-e2e-holder "$c" psql -X -q -U app -d app &`,
        "sleep 5",
        `timeout 1600 docker exec -e PGAPPNAME=opscrew-e2e-waiter "$c" psql -X -q -U app -d app -c 'SELECT count(*) FROM ${LOCKED_TABLE}' &`,
        "wait",
      ].join("\n");
      await exec(
        `echo ${Buffer.from(script).toString("base64")} | base64 -d > ${LOCKS_SCRIPT} && setsid -f sh ${LOCKS_SCRIPT} > /dev/null 2>&1 < /dev/null`,
      );
      const started = Date.now();
      const held = (text: string) =>
        text.includes("opscrew-e2e-holder idle in transaction") &&
        text.includes("opscrew-e2e-waiter active Lock");
      await waitFor(
        "the test's two sessions in PostgreSQL",
        minutes(2),
        async () => (held(await sessions()) ? true : undefined),
        5_000,
      );
      // Advise names a transaction left open from 5 minutes on (and a lock wait from 30 seconds).
      await sleep(Math.max(0, started + 330_000 - Date.now()));
      const before = { production: await production(), states: await pass.stateHashes() };
      const asked = Date.now();
      const advised = await run.opscrewOk("advise", "--json");
      const took = Date.now() - asked;
      const ids = adviceOf(advised.stdout).proposals.map((proposal) => proposal.id);
      pass.figure(
        "H8 advise with the database check",
        `${Math.round(took / 1000)} s in all; ${ids.filter((id) => id.startsWith("db.")).join(", ") || "no database finding"}`,
      );
      expect(
        ids.some((id) => /^db\..+\.blocked$/.test(id)),
        `advise names the lock wait:\n${ids.join("\n")}`,
      ).toBe(true);
      expect(
        ids.some((id) => /^db\..+\.idle-transaction$/.test(id)),
        `advise names the transaction left open:\n${ids.join("\n")}`,
      ).toBe(true);
      expect(
        ids.some((id) => /^db\..+\.timeout$/.test(id)),
        "the database check stopped at its time limit",
      ).toBe(false);
      expect(await production(), "production's containers and volumes after advise").toEqual(
        before.production,
      );
      expect(await pass.stateHashes(), "the states after advise").toEqual(before.states);
      expect(held(await sessions()), "the test's sessions after advise").toBe(true);
    },
  );

  leg.step(
    "the test's PostgreSQL sessions ended",
    minutes(5),
    async () => {
      if (pass.state?.app?.appName === undefined || run.root === undefined) return;
      await run.shell().run(`pkill -f '[o]pscrew-e2e-locks' ; rm -f ${LOCKS_SCRIPT}`);
      await run
        .shell()
        .run(
          inContainer(
            app(),
            db,
            psql(
              "select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name like 'opscrew-e2e-%'",
            ),
          ),
        );
    },
    { always: true },
  );
});

// ---------------------------------------------------------------------------------------------

const H7 = legTitle(
  "H7",
  "rotate, the switch to the tunnel, destroy, the leak scan and the cleanup",
);

describe.skipIf(H7.skip)(H7.title, () => {
  const pass = new HomePass(ENV);
  const leg = new Leg(pass, "H7");
  const { run } = pass;

  leg.step(
    "rotate dns-updater with the second token: the host plan approved by its hash, the server's copy replaced, the page to delete the old token named",
    minutes(20),
    async () => {
      const second = pass.updaterToken("b");
      const rotated = await pass.untilApproved(["rotate", "dns-updater"], {
        OPSCREW_DNS_UPDATER_TOKEN: second,
      });
      pass.pass().updaterToken = "b";
      run.env = pass.cliEnv();
      await pass.save();
      expect(
        rotated.output.includes("dash.cloudflare.com/profile/api-tokens"),
        `rotate names the page where the old token is deleted:\n${run.tail(rotated.output)}`,
      ).toBe(true);
      const onServer = await run
        .shell()
        .ok(`sha256sum /etc/opscrew/dns-updater/${run.app()}.token | cut -d ' ' -f 1`);
      expect(
        [sha256(second), sha256(`${second}\n`)].includes(onServer),
        "the server holds the second token",
      ).toBe(true);
    },
  );

  leg.step(
    "the switch from home to the tunnel: the host plan that removes the updater, the records' deletion with the app's name typed, then the tunnel serving",
    minutes(75),
    async () => {
      await pass.interview("tunnel");
      await run.opscrewOk("design");
      const plan = await run.readPlan();
      expect(usesTunnel(plan), "served through the tunnel").toBe(true);
      expect(homeOf(plan), "the plan's server at home").toBeUndefined();
      const provisioned = await pass.provision("the switch to the tunnel");
      expect(
        provisioned.includes("the address updater's records"),
        `provision deletes the address updater's records:\n${run.tail(provisioned)}`,
      ).toBe(true);
      await run.rememberOutputs(TUNNEL_OUTPUTS);
      await run.deployAny("the tunnel");
      await run.waitForHealth(minutes(10), true, await pass.healthUrl());
      expect(await pass.updaterRecords(), "the updater's records").toEqual([]);
      const token = await run.shell().run(`test -e /etc/opscrew/dns-updater/${run.app()}.token`);
      expect(token.exitCode, "the updater's token file on the server").not.toBe(0);
      expect(
        existsSync(join(run.repo, ".github", "workflows", OUTSIDE_CHECK_WORKFLOW_FILE)),
        "the outside check's workflow on main",
      ).toBe(false);
    },
  );

  leg.step(
    "destroy: the app, its tunnel and records and the server's runner removed; the deploy user stays",
    minutes(30),
    async () => {
      const plan = await run.readPlan();
      const label = runnerLabel(plan);
      await pass.untilApproved(["destroy", ...destroyConfirmArgs(plan), "--no-snapshot"]);
      await pass.recordApp({ destroyed: true });
      await expectNoRunner(run.github, label);
      const containers = await run
        .shell()
        .ok(`docker ps -aq --filter label=com.docker.compose.project=${run.app()}`);
      expect(containers, "the app's containers").toBe("");
      expect((await run.shell().run("id -u deploy")).exitCode, "the deploy user").toBe(0);
    },
  );

  leg.step(
    "destroy --undo-host: the deploy user, OpsCrew's SSH table and the IPv6 web filter removed; root still logs in",
    minutes(30),
    async () => {
      const plan = await run.readPlan();
      await pass.untilApproved([
        "destroy",
        ...destroyConfirmArgs(plan),
        "--no-snapshot",
        "--undo-host",
      ]);
      const shell = run.shell();
      expect((await shell.run("id -u deploy")).exitCode, "the deploy user").not.toBe(0);
      for (const table of ["inet opscrew", "inet opscrew-web"]) {
        expect(
          (await shell.run(`nft list table ${table}`)).exitCode,
          `the table ${table}`,
        ).not.toBe(0);
      }
      await shell.ok("true");
    },
  );

  leg.step(
    "the leak scan over every output, commit, pull request, audit entry, saved plan, state file, server.json and the outside check's run logs: no token, and no address outside DNS only (SC-2906)",
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
    "the servers and the firewall deleted; what is left of the app at Cloudflare and GitHub removed and listed; the repository reset",
    minutes(30),
    async () => {
      if (pass.state === undefined) return;
      const { removed, left } = await pass.cleanup();
      for (const what of removed) pass.log(`removed what was left: ${what}`);
      pass.figure(
        "H7 what the cleanup found left and removed",
        removed.length === 0 ? "nothing" : removed.join("; "),
      );
      for (const what of left) pass.log(`left: ${what}`);
      expect(left, "what the cleanup left").toEqual([]);
      pass.log("the pass's figures for docs/e2e-coverage.md:");
      for (const [name, figure] of Object.entries(pass.pass().figures)) {
        pass.log(`  ${name}: ${figure}`);
      }
      pass.log("nothing of the pass is left; its folder goes");
      await pass.removeFolder();
    },
    { always: true },
  );
});

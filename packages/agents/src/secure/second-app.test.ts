/**
 * `opscrew secure` of a second app on the server OpsCrew created for the first app (feature 030,
 * plan 8.): the server's hardening (SSH, the firewall, Lynis and ssh-audit) is the first app's,
 * said in one skipped check; the app's own checks (its services, its site) still run.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandResult, Scanner } from "@opscrew/contracts";
import { writeArtifact } from "@opscrew/plan-schema";
import type { LocalDocker, TcpConnect } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { inventoryPlan } from "../provision/__fixtures__/second-app";
import { recordOwnServer, recordServerAddress } from "../shared";
import { createTestPhaseDeps, ED25519_FINGERPRINT, ScriptedRunner, SERVER_IPV4 } from "../testing";
import { firstAppHardening, ownSecureTarget } from "./own";
import { runSecure } from "./run";

const NOW = "2026-10-14T12:00:00.000Z";

/** The deploy login's shell on the shared server: only the app's own service checks answer. */
function serverScript(command: string, args: readonly string[]): CommandResult {
  const ok = (stdout: string): CommandResult => ({
    exitCode: 0,
    stdout: `${stdout}\n`,
    stderr: "",
  });
  if (command !== "ssh") return { exitCode: 1, stdout: "", stderr: "not a git repository" };
  // The app's Postgres (`db`): no published port, its password set.
  if (args.at(-1)?.includes("{{.Ports}}")) return ok("5432/tcp");
  if (args.at(-1)?.includes("docker inspect")) return ok("POSTGRES_PASSWORD");
  return { exitCode: 127, stdout: "", stderr: "unexpected command" };
}

/** A provisioned second app `inventory` beside `shop`, joined, with its deploy key here. */
async function secondApp() {
  const root = await mkdtemp(join(tmpdir(), "opscrew-secure-second-"));
  const runner = new ScriptedRunner(serverScript);
  const deps = await createTestPhaseDeps({ root, runner, clock: { now: () => new Date(NOW) } });
  await writeArtifact("plan", deps.paths.files.plan, {
    ...inventoryPlan(),
    deployment: { lastApplyAt: NOW },
  });
  await recordOwnServer(deps.paths, {
    host: SERVER_IPV4,
    port: 22,
    user: "deploy",
    agent: false,
    keyPath: deps.paths.files.deployKey,
    hostKey: ED25519_FINGERPRINT,
    publicIpv4: SERVER_IPV4,
    shares: { root: join(root, "elsewhere", "shop") },
    joined: true,
  });
  await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
  await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
  await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
  return Object.assign(deps, { runner });
}

/** The outside view: every probed port is closed; the probes are kept. */
function closed(): TcpConnect & { probed: string[] } {
  const probed: string[] = [];
  return Object.assign(
    async (host: string, port: number) => {
      probed.push(`${host}:${port}`);
      return false;
    },
    { probed },
  );
}

const noScanners: Scanner[] = [];

describe("runSecure of a second app", () => {
  it("names the first app's server hardening once and runs only the app's own checks", async () => {
    const deps = await secondApp();
    expect((await ownSecureTarget(deps, inventoryPlan()))?.firstApp).toBe("shop");
    const connect = closed();
    const docker: LocalDocker = {
      run: async () => {
        throw new Error("Could not run docker: it is not installed or not on PATH.");
      },
    };
    const result = await runSecure(deps, {
      scanners: noScanners,
      tcpConnect: connect,
      deep: true,
      docker,
    });

    const { message, hint } = firstAppHardening("shop");
    expect(message).toBe(
      "The server's hardening (SSH, the firewall, Lynis and ssh-audit) belongs to \"shop\", which OpsCrew created the server for; only this app's own checks run here.",
    );
    expect(hint).toBe('Run `opscrew secure` in the repository of "shop" to check it.');
    const ids = result.hostChecks.map((check) => check.id);
    expect(result.hostChecks[0]).toMatchObject({
      id: "server-hardening",
      status: "skip",
      message,
      remediation: hint,
    });
    // The server's checks are the first app's: none of them ran here.
    for (const id of ["ssh-hardening", "ufw", "listening-ports", "setup-finished"]) {
      expect(ids).not.toContain(id);
    }
    const ran = deps.runner.calls.map((call) => call.args.at(-1) ?? "");
    expect(ran.some((command) => command.includes("sshd_config"))).toBe(false);
    expect(ran.some((command) => command.includes("{{.Ports}}"))).toBe(true);
    // No probe of the server's SSH or its password logins; its services' ports are probed.
    const probes = result.probes.map((check) => check.id);
    expect(probes).not.toContain("ssh-password-login-disabled");
    expect(probes).not.toContain("ssh-port-open");
    expect(connect.probed).toContain(`${SERVER_IPV4}:5432`);
    expect(connect.probed).not.toContain(`${SERVER_IPV4}:22`);
    // Lynis and ssh-audit are the first app's too; the site's TLS audit stays the app's.
    const [lynis, sshAudit, testssl] = result.deep ?? [];
    for (const run of [lynis, sshAudit]) {
      expect(run?.results).toEqual([expect.objectContaining({ status: "skip", message })]);
    }
    expect(testssl?.results).toEqual([
      expect.objectContaining({
        status: "skip",
        message: expect.stringContaining("Docker is not installed on this computer"),
      }),
    ]);

    // Neither the report nor the terminal names the server's address.
    const report = await readFile(deps.paths.files.securityReport, "utf8");
    expect(report).toContain(message);
    expect(`${report}\n${deps.reporter.text()}`).not.toContain(SERVER_IPV4);
  });
});

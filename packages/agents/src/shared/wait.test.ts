import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import type { PhaseDeps } from "../context";
import { providerProfile, VPS_PROVIDERS } from "../providers";
import {
  createTestPhaseDeps,
  FakeFirstBoot,
  FIRST_BOOT_SERVER_ID,
  type FirstBootOptions,
  firstBootErrors,
  HOST_KEY,
  NEW_HOST_KEY,
  ScriptedApprovalHandler,
} from "../testing";
import {
  confirmChangedHostKey,
  failedSetupSteps,
  isNewServerRepairRequest,
  type NewServerRepair,
  readyNewServer,
} from "./wait";

describe("confirmChangedHostKey", () => {
  it("names the server in the details only: the title goes to the approvals record and the audit log", async () => {
    const seen: ApprovalRequest[] = [];
    const approvals = {
      async request(request: ApprovalRequest) {
        seen.push(request);
        return { approved: true };
      },
    } as unknown as PhaseDeps["approvals"];
    const confirm = confirmChangedHostKey({ approvals });
    const approved = await confirm({
      host: "203.0.113.10",
      previous: ["ssh-ed25519 AAAAold"],
      current: ["ssh-ed25519 AAAAnew"],
    });
    expect(approved).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toBe("Trust the server's new SSH host key");
    expect(seen[0]?.title).not.toContain("203.0.113.10");
    expect(seen[0]?.details).toContain("Server: 203.0.113.10");
  });
});

const HOST = "203.0.113.10";
const AGAIN = "run `opscrew provision` again; it continues where it stopped.";
/** A marker cloud-init's errors quote, which no output, audit entry or approval may show. */
const QUOTED = fakeSecret("hcloud-token", "first-boot");
const USER_DATA = "#cloud-config\n# the first-boot file the module renders\n";

/**
 * A new server's first boot (`server`), waited for by `readyNewServer` with a repair through its
 * provider's fake API unless `repair` is false; `answer` decides each approval (default: the
 * app's name typed). The clock is the test's.
 */
async function firstBoot(
  provider: (typeof VPS_PROVIDERS)[number],
  options: FirstBootOptions & {
    answer?: (request: ApprovalRequest) => boolean;
    repair?: boolean;
  } = {},
) {
  const server = new FakeFirstBoot({ errors: firstBootErrors(QUOTED), ...options });
  const handler = new ScriptedApprovalHandler(options.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    runner: server.runner(),
  });
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  let clock = 0;
  const repair: NewServerRepair = {
    servers: server.servers,
    serverId: FIRST_BOOT_SERVER_ID,
    app: "shop",
    image: providerProfile(provider).defaultImage,
    userData: async () => USER_DATA,
    command: "opscrew provision",
    script: "run `opscrew provision --confirm shop`",
  };
  const result = await readyNewServer(deps, {
    host: HOST,
    server: "server",
    profile: providerProfile(provider),
    keyFile: deps.paths.files.deployKey,
    again: AGAIN,
    services: {
      tcpConnect: server.tcpConnect,
      remote: server.remote,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    ...(options.repair === false ? {} : { repair }),
  }).catch((error: unknown) => error);
  /** Every text the run showed or kept, and the error's. */
  const everything = [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify(handler.requests),
    result instanceof OpsCrewError ? `${result.message}\n${result.hint ?? ""}` : "",
  ].join("\n");
  return { server, deps, handler, result, everything };
}

/** The leak check: cloud-init's errors (their quoted commands) and the first-boot file never show. */
function expectNoLeak(everything: string) {
  expect(everything).not.toContain(QUOTED);
  for (const raw of [
    "apt-get",
    "Exit code",
    "ProcessExecutionError",
    "Runparts",
    "#cloud-config",
  ]) {
    expect(everything).not.toContain(raw);
  }
}

describe.each(VPS_PROVIDERS)("a new server's first boot on %s", (provider) => {
  const profile = providerProfile(provider);
  const named = `the new ${profile.displayName} ${profile.serverNoun} shop`;

  it("names the failed steps in plain words when no repair is offered", async () => {
    const { result, server, handler, everything } = await firstBoot(provider, { repair: false });
    expect(result).toMatchObject({
      code: "PROVIDER_ERROR",
      message: `The server at ${HOST} did not finish its first-boot setup: the provider's first-boot command, the package install and OpsCrew's setup script failed.`,
    });
    expect((result as OpsCrewError).hint).toContain("cloud-init status --long");
    expect(handler.requests).toEqual([]);
    expect(server.calls).toEqual([]);
    expectNoLeak(everything);
  });

  it("restarts a server that never opened SSH, after the app's name, then goes on", async () => {
    const { result, server, handler, deps, everything } = await firstBoot(provider, {
      network: false,
      setup: "ready",
    });
    expect(result).toMatchObject({ created: true, changed: false });
    expect(server.calls).toEqual([`restart ${FIRST_BOOT_SERVER_ID}`]);
    expect(handler.requests).toHaveLength(1);
    const request = handler.requests[0] as ApprovalRequest;
    expect(request).toMatchObject({
      kind: "remote-exec",
      title: `Restart ${named}`,
      confirmPhrase: "shop",
    });
    expect(request.allowDestroy).toBeUndefined();
    expect(isNewServerRepairRequest(request)).toBe(true);
    expect(request.details).toContain(`The server at ${HOST} did not open SSH within 5 minutes.`);
    expect(request.details).toContain("It holds nothing yet");
    expect(request.details).toContain(
      `OpsCrew restarts ${named} through ${profile.displayName}'s API`,
    );
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "provider-call",
        action: "restart server",
        target: `${profile.displayName} ${profile.serverNoun} ${FIRST_BOOT_SERVER_ID}`,
      }),
    );
    expect(deps.reporter.text()).toContain(`success: The server at ${HOST} is ready.`);
    // The title is kept in the approvals record and the audit log: no address there.
    expect(request.title).not.toContain(HOST);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(HOST);
    expectNoLeak(everything);
  });

  it("installs a server whose setup failed again, after the app's name, and pins its new key with no question", async () => {
    const { result, server, handler, deps, everything } = await firstBoot(provider);
    expect(server.calls).toEqual([`reinstall ${FIRST_BOOT_SERVER_ID}`]);
    expect(server.installed).toEqual({ image: profile.defaultImage, userData: USER_DATA });
    // One approval: the install's; the changed host key asks nothing (FR-3110).
    expect(handler.requests.map((r) => r.title)).toEqual([`Install ${named} again`]);
    const request = handler.requests[0] as ApprovalRequest;
    expect(request).toMatchObject({
      kind: "remote-exec",
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(request.details).toContain(
      `The server at ${HOST} did not finish its first-boot setup: the provider's first-boot command, the package install and OpsCrew's setup script failed.`,
    );
    expect(request.details).toContain("It holds nothing yet");
    expect(request.details).toContain("its disk is wiped");
    expect(result).toMatchObject({ knownHostsLines: `${HOST} ${NEW_HOST_KEY}\n`, created: true });
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(`${HOST} ${NEW_HOST_KEY}\n`);
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({ kind: "provider-call", action: "reinstall server" }),
    );
    expectNoLeak(everything);
  });

  it("repairs the live case: a restart, then an install, at most one of each", async () => {
    const { result, server, handler } = await firstBoot(provider, { network: false });
    expect(server.calls).toEqual([
      `restart ${FIRST_BOOT_SERVER_ID}`,
      `reinstall ${FIRST_BOOT_SERVER_ID}`,
    ]);
    expect(handler.requests.map((r) => r.title)).toEqual([
      `Restart ${named}`,
      `Install ${named} again`,
    ]);
    expect(result).toMatchObject({ knownHostsLines: `${HOST} ${NEW_HOST_KEY}\n` });

    // A server that fails again after the install is not installed a second time.
    const again = await firstBoot(provider, { network: false, setupAfterInstall: "failed" });
    expect(again.server.calls).toEqual([
      `restart ${FIRST_BOOT_SERVER_ID}`,
      `reinstall ${FIRST_BOOT_SERVER_ID}`,
    ]);
    expect(again.result).toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("did not finish its first-boot setup"),
    });
  });

  it("restarts once: a server still without SSH after it stops plainly", async () => {
    const stuck = new FakeFirstBoot({ network: false });
    // A restart that brings no network.
    const stays = {
      ...stuck.servers,
      restart: async (id: string) => {
        stuck.calls.push(`restart ${id}`);
      },
    };
    const deps = await createTestPhaseDeps({ runner: stuck.runner() });
    await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
    let clock = 0;
    const error = await readyNewServer(deps, {
      host: HOST,
      server: "server",
      profile,
      keyFile: deps.paths.files.deployKey,
      again: AGAIN,
      services: {
        tcpConnect: stuck.tcpConnect,
        remote: stuck.remote,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
      repair: {
        servers: stays,
        serverId: FIRST_BOOT_SERVER_ID,
        app: "shop",
        image: profile.defaultImage,
        userData: async () => USER_DATA,
        command: "opscrew provision",
        script: "run `opscrew provision --confirm shop`",
      },
    }).catch((e: unknown) => e);
    expect(stuck.calls).toEqual([`restart ${FIRST_BOOT_SERVER_ID}`]);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message: `The server at ${HOST} did not open SSH within 5 minutes after OpsCrew restarted it.`,
    });
  });

  it("without the approval restarts and installs nothing, and says how to approve it", async () => {
    for (const network of [false, true]) {
      const { result, server } = await firstBoot(provider, { network, answer: () => false });
      expect(server.calls).toEqual([]);
      expect(result).toMatchObject({ code: "APPROVAL_REFUSED" });
      const error = result as OpsCrewError;
      expect(error.message).toContain(
        network ? "did not finish its first-boot setup" : "did not open SSH",
      );
      expect(error.message).toContain(`OpsCrew did not ${network ? "install" : "restart"} it`);
      expect(error.message).toContain("Nothing was changed.");
      expect(error.hint).toBe(
        "To repair it, run `opscrew provision` again and type shop when asked; in a script, run `opscrew provision --confirm shop`.",
      );
    }
  });

  it("waits for the new system's key while the old one still answers, and stops when it never comes", async () => {
    const slow = await firstBoot(provider, { oldScans: 5 });
    expect(slow.result).toMatchObject({ knownHostsLines: `${HOST} ${NEW_HOST_KEY}\n` });
    const scans = (slow.deps.runner as ReturnType<FakeFirstBoot["runner"]>).calls.filter(
      (call) => call.command === "ssh-keyscan",
    );
    // The pin before the install, five scans of the old system, the new one, and its pin.
    expect(scans).toHaveLength(8);

    const never = await firstBoot(provider, { oldScans: 1_000 });
    expect(never.result).toMatchObject({
      code: "PROVIDER_ERROR",
      message: `The server at ${HOST} still had its old SSH host key 10 minutes after ${profile.displayName} accepted its install: the install did not take effect.`,
    });
    // The old pin stays.
    expect(await readFile(never.deps.paths.files.knownHosts, "utf8")).toBe(`${HOST} ${HOST_KEY}\n`);
  });

  it("offers nothing where the provider's connector cannot restart or install", async () => {
    const { result, server, handler } = await firstBoot(provider, { repairs: false });
    expect(result).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(handler.requests).toEqual([]);
    expect(server.calls).toEqual([]);
  });
});

describe("failedSetupSteps", () => {
  const answering = (stdout: string, exitCode = 0) => ({
    host: HOST,
    run: async () => ({ exitCode, stdout, stderr: "" }),
  });

  it("names each module once, others by their name, and reads nothing it cannot parse", async () => {
    const result = JSON.stringify({
      v1: {
        errors: [
          "('scripts_user', RuntimeError('Runparts: 1 failures (runcmd)'))",
          "('runcmd', OSError('x'))",
          "('write_files', OSError('y'))",
          "Something without a module",
        ],
      },
    });
    expect(await failedSetupSteps(answering(result))).toEqual([
      "OpsCrew's setup script",
      "cloud-init's write_files step",
      "a step cloud-init does not name",
    ]);
    for (const remote of [answering("not json"), answering("{}"), answering(result, 1)]) {
      expect(await failedSetupSteps(remote)).toEqual([]);
    }
  });
});

it("asks nothing again over the private network, where a server was set up long ago", async () => {
  const server = new FakeFirstBoot({ errors: firstBootErrors(QUOTED) });
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({ approvalHandler: handler, runner: server.runner() });
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  await writeFile(deps.paths.files.knownHosts, `[10.0.0.2]:22 ${HOST_KEY}\n`);
  let clock = 0;
  const error = await readyNewServer(deps, {
    host: HOST,
    server: "server",
    profile: providerProfile("contabo"),
    keyFile: deps.paths.files.deployKey,
    again: AGAIN,
    services: {
      tcpConnect: server.tcpConnect,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    network: { host: "10.0.0.2", port: 22, remote: server.remote("10.0.0.2") },
    repair: {
      servers: server.servers,
      serverId: FIRST_BOOT_SERVER_ID,
      app: "shop",
      image: "image",
      userData: async () => USER_DATA,
      command: "opscrew provision",
      script: "run `opscrew provision --confirm shop`",
    },
  }).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
  expect(handler.requests).toEqual([]);
  expect(server.calls).toEqual([]);
});

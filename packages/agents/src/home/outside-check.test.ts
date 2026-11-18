import type { RunJob } from "@opscrew/connector-github";
import { OpsCrewError } from "@opscrew/core";
import { OUTSIDE_CHECK_WORKFLOW_FILE } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { readOwnServer, recordOwnServer } from "../shared/server-record";
import { createTestPhaseDeps, HOME_IPV4, HOME_IPV6, LAN_IPV4 } from "../testing";
import type { HomeForwardsInput } from "./forwards";
import {
  type OutsideCheckRepository,
  type OutsideCheckResult,
  outsideCheckLines,
  runOutsideCheck,
} from "./outside-check";

const RUN_URL = "https://github.com/acme/shop/actions/runs/77";
const INPUT = { host: "shop.example.com", path: "/healthz", mode: "direct" as const };

/** GitHub's three calls the check makes, scripted, with what they were given. */
class FakeActions {
  readonly dispatches: {
    workflowFile: string;
    ref: string;
    inputs: Record<string, string> | undefined;
  }[] = [];
  readonly waits: { workflowFile: string; ref: string; runId: number; timeoutMs?: number }[] = [];
  readonly jobReads: { runId: number; attempt: number }[] = [];
  dispatchStatus: "ok" | 404 | 422 | "credentials" = "ok";
  waitTimesOut = false;
  jobs: RunJob[] = [
    { name: "http", conclusion: "success" },
    { name: "https", conclusion: "success" },
  ];

  async dispatchWorkflow(
    _owner: string,
    _repo: string,
    workflowFile: string,
    ref: string,
    inputs?: Record<string, string>,
    onAccepted?: () => Promise<void>,
  ) {
    this.dispatches.push({ workflowFile, ref, inputs });
    if (this.dispatchStatus === 404 || this.dispatchStatus === 422) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `GitHub cannot start the workflow ${workflowFile} on ${ref}: HTTP ${this.dispatchStatus}.`,
      );
    }
    if (this.dispatchStatus === "credentials") {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        "GitHub refused to start the workflow: the token needs Actions: Read and write.",
      );
    }
    await onAccepted?.();
    return { runId: 77, url: RUN_URL };
  }

  async waitForWorkflowRun(
    _owner: string,
    _repo: string,
    options: { workflowFile: string; ref: string; runId: number; timeoutMs?: number },
  ) {
    this.waits.push(options);
    if (this.waitTimesOut) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `The ${options.workflowFile} run on ${options.ref} did not finish within 10 minutes.`,
      );
    }
    return {
      id: options.runId,
      status: "completed" as const,
      conclusion: "success",
      htmlUrl: RUN_URL,
      headSha: "a".repeat(40),
    };
  }

  async runAttemptJobs(_owner: string, _repo: string, runId: number, attempt: number) {
    this.jobReads.push({ runId, attempt });
    return this.jobs;
  }
}

/** A home server's record, with no outside check yet. */
async function setup(options: { proxied?: boolean } = {}) {
  const deps = await createTestPhaseDeps();
  // A proxied app's home address is a secret: nothing the check does may carry it.
  deps.redactor.addLiteral(HOME_IPV4);
  await recordOwnServer(deps.paths, {
    host: LAN_IPV4,
    port: 22,
    user: "ana",
    agent: true,
    ...(options.proxied ? { serve: "proxy" as const } : {}),
    home: { sshFrom: ["192.168.1.0/24", "fe80::/10"] },
  });
  const actions = new FakeActions();
  const github: OutsideCheckRepository = {
    api: actions,
    owner: "acme",
    repo: "shop",
    defaultBranch: "main",
  };
  return { deps, actions, github };
}

/** Everything the check's fakes saw, and what it wrote, as one text. */
async function everything(
  deps: Awaited<ReturnType<typeof setup>>["deps"],
  actions: FakeActions,
): Promise<string> {
  return JSON.stringify({
    dispatches: actions.dispatches,
    waits: actions.waits,
    audit: deps.audit.entries,
    reporter: deps.reporter.lines,
    record: await readOwnServer(deps.paths),
  });
}

describe("runOutsideCheck", () => {
  it("starts the workflow on the default branch with the hostname, path and mode, audited", async () => {
    const { deps, actions, github } = await setup();
    await runOutsideCheck(deps, github, INPUT);
    expect(actions.dispatches).toEqual([
      {
        workflowFile: OUTSIDE_CHECK_WORKFLOW_FILE,
        ref: "main",
        inputs: { host: "shop.example.com", path: "/healthz", mode: "direct" },
      },
    ]);
    const dispatch = deps.audit.entries.find((entry) => entry.action === "dispatch workflow");
    expect(dispatch).toMatchObject({ kind: "provider-call", target: "acme/shop" });
    expect(dispatch?.detail).toContain("shop.example.com");
    expect(dispatch?.detail).toContain("/healthz");
    expect(dispatch?.detail).toContain("direct");
  });

  it("waits 10 minutes for the run and reads the jobs of its first attempt", async () => {
    const { deps, actions, github } = await setup();
    await runOutsideCheck(deps, github, INPUT);
    expect(actions.waits).toEqual([
      { workflowFile: OUTSIDE_CHECK_WORKFLOW_FILE, ref: "main", runId: 77, timeoutMs: 600_000 },
    ]);
    expect(actions.jobReads).toEqual([{ runId: 77, attempt: 1 }]);
  });

  it("records the result in own.home.outsideCheck and audits it", async () => {
    const { deps, github } = await setup();
    const result = await runOutsideCheck(deps, github, INPUT);
    const expected: OutsideCheckResult = {
      at: "2026-10-11T12:00:00.000Z",
      host: "shop.example.com",
      mode: "direct",
      http: "ok",
      https: "ok",
      runUrl: RUN_URL,
    };
    expect(result).toEqual(expected);
    const own = await readOwnServer(deps.paths);
    expect(own?.home?.outsideCheck).toEqual(expected);
    expect(own?.home?.sshFrom).toEqual(["192.168.1.0/24", "fe80::/10"]);
    const entry = deps.audit.entries.find((e) => e.action === "outside check result");
    expect(entry).toMatchObject({ kind: "provider-call", target: RUN_URL });
    expect(entry?.detail).toContain("shop.example.com");
  });

  it.each([
    ["success", "ok"],
    ["failure", "failed"],
    ["cancelled", "unfinished"],
    ["timed_out", "unfinished"],
    ["skipped", "skipped"],
  ] as const)("reads a job's %s as %s", async (conclusion, expected) => {
    const { deps, actions, github } = await setup();
    actions.jobs = [
      { name: "http", conclusion },
      { name: "https", conclusion: "success" },
    ];
    const result = await runOutsideCheck(deps, github, INPUT);
    expect(result.http).toBe(expected);
    expect(result.https).toBe("ok");
  });

  it("reads a missing job as skipped", async () => {
    const { deps, actions, github } = await setup();
    actions.jobs = [{ name: "https", conclusion: "failure" }];
    const result = await runOutsideCheck(deps, github, INPUT);
    expect(result).toMatchObject({ http: "skipped", https: "failed" });
  });

  it("reads a wait that timed out as unfinished, recorded with the run's link", async () => {
    const { deps, actions, github } = await setup();
    actions.waitTimesOut = true;
    const result = await runOutsideCheck(deps, github, INPUT);
    expect(result).toMatchObject({ http: "unfinished", https: "unfinished", runUrl: RUN_URL });
    expect(actions.jobReads).toEqual([]);
    expect((await readOwnServer(deps.paths))?.home?.outsideCheck).toEqual(result);
  });

  it.each([404, 422] as const)(
    "a %s on dispatch says to merge the deploy-setup pull request first",
    async (status) => {
      const { deps, actions, github } = await setup();
      actions.dispatchStatus = status;
      const error = await runOutsideCheck(deps, github, INPUT).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).code).toBe("PHASE_PRECONDITION");
      expect((error as OpsCrewError).hint).toBe(
        "Merge the deploy-setup pull request first, then run `npx opscrew verify` again.",
      );
      expect((await readOwnServer(deps.paths))?.home?.outsideCheck).toBeUndefined();
      expect(deps.audit.entries).toEqual([]);
    },
  );

  it("passes a refused token on unchanged, naming the permission, and records nothing", async () => {
    const { deps, actions, github } = await setup();
    actions.dispatchStatus = "credentials";
    const error = await runOutsideCheck(deps, github, INPUT).catch((e: unknown) => e);
    expect((error as OpsCrewError).code).toBe("CREDENTIALS_INVALID");
    expect((error as OpsCrewError).message).toContain("Actions: Read and write");
    expect((await readOwnServer(deps.paths))?.home?.outsideCheck).toBeUndefined();
  });

  it("never carries the home's address, behind the proxy or not", async () => {
    for (const proxied of [false, true]) {
      const { deps, actions, github } = await setup({ proxied });
      actions.jobs = [
        { name: "http", conclusion: "failure" },
        { name: "https", conclusion: "success" },
      ];
      const result = await runOutsideCheck(deps, github, {
        ...INPUT,
        mode: proxied ? "proxied" : "direct",
      });
      const text = `${await everything(deps, actions)}\n${outsideCheckLines(result, FORWARDS).join("\n")}`;
      expect(text).not.toContain(HOME_IPV4);
      expect(text).not.toContain(HOME_IPV6);
      expect(deps.redactor.redact(text)).toBe(text);
    }
  });
});

const FORWARDS: HomeForwardsInput = { lanAddress: LAN_IPV4, ipv4: true, noNat: false, aaaa: false };

function result(over: Partial<OutsideCheckResult> = {}): OutsideCheckResult {
  return {
    at: "2026-10-11T12:00:00.000Z",
    host: "shop.example.com",
    mode: "direct",
    http: "ok",
    https: "ok",
    runUrl: RUN_URL,
    ...over,
  };
}

describe("outsideCheckLines", () => {
  it("says both ports answered from outside, with no failure text", () => {
    const lines = outsideCheckLines(result(), FORWARDS);
    expect(lines).toEqual([
      "Port 80 answered from outside your home.",
      "Port 443 answered from outside your home, with a valid certificate and your app's health path.",
    ]);
  });

  it("behind the proxy, port 80 reads that Cloudflare answered", () => {
    const lines = outsideCheckLines(result({ mode: "proxied" }), FORWARDS);
    expect(lines[0]).toBe("Cloudflare answered on port 80.");
    expect(lines[1]).toBe(
      "Port 443 answered from outside your home: Cloudflare reached your app's health path.",
    );
  });

  it("a failure names the port, the forwards, the fixed LAN address, the causes and the tunnel", () => {
    const lines = outsideCheckLines(result({ https: "failed" }), FORWARDS);
    expect(lines).toEqual([
      "Port 80 answered from outside your home.",
      "Port 443 didn't answer from outside your home.",
      "Possible causes: not forwarded, blocked by your provider, or no public IPv4 address; OpsCrew can't tell which.",
      `On your router, forward TCP 80 and TCP 443 to ${LAN_IPV4}.`,
      `Reserve ${LAN_IPV4} for this server in the router's DHCP settings so it stays fixed.`,
      "Don't forward SSH.",
      "Instead: a Cloudflare Tunnel works on any connection (answer server.serve tunnel).",
      `The check's run: ${RUN_URL}`,
    ]);
  });

  it("an unfinished check isn't a port failure: run verify again, with the run's link", () => {
    const lines = outsideCheckLines(result({ http: "unfinished", https: "unfinished" }), FORWARDS);
    expect(lines).toEqual([
      `The check didn't finish: run \`npx opscrew verify\` again. Its run: ${RUN_URL}`,
    ]);
  });

  it("a skipped port says it wasn't checked", () => {
    const lines = outsideCheckLines(result({ http: "skipped" }), FORWARDS);
    expect(lines[0]).toBe(`Port 80 wasn't checked: see ${RUN_URL}`);
    expect(lines).toHaveLength(2);
  });
});

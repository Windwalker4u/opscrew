/**
 * `opscrew cloudflare move`: its flags, its help, and the approvals a script gives with
 * `--approve`, `--confirm` and `--allow-downtime` (the whole run with fakes is
 * `test/e2e/cloudflare-move.test.ts`).
 */
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { withAllowDowntime } from "../approval";
import { createTestContext } from "../test-context";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import { flagProblems, MoveApprovalHandler } from "./cloudflare";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const clock = { now: () => new Date("2026-11-20T10:00:00.000Z") };

/** A base handler that refuses everything and records what reached it. */
class RefusingBase implements ApprovalHandler {
  readonly seen: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(request);
    return { approved: false, approver: "base", decidedAt: clock.now().toISOString() };
  }
}

function handler(options: { approve?: string; names?: string[]; interactive?: boolean } = {}) {
  const base = new RefusingBase();
  const printed: string[] = [];
  const approvals = new MoveApprovalHandler(base, {
    interactive: options.interactive ?? false,
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    names: options.names ?? [],
    print: (text) => printed.push(text),
    clock,
  });
  return { base, printed, approvals };
}

const SWITCH: ApprovalRequest = {
  kind: "domain-settings",
  title: "Switch example.com to the Cloudflare account New",
  details: "",
  planHash: HASH,
  confirmPhrase: "example.com",
};

describe("flagProblems", () => {
  it("refuses --env plainly, since the move covers every environment in the zone", () => {
    expect(flagProblems({ env: "staging" }).join(" ")).toContain(
      "The move takes no --env: it moves every environment of the app whose domain is in the zone",
    );
  });

  it("takes one step at a time, --to only when preparing, --allow-downtime only with --finish", () => {
    expect(flagProblems({ switch: true, finish: true })).toEqual([
      "Use one of --switch, --finish at a time.",
    ]);
    expect(flagProblems({ to: "New", abort: true })).toEqual([
      "--to only applies when preparing the move, not with --abort.",
    ]);
    expect(flagProblems({ allowDowntime: true, switch: true })).toEqual([
      "--allow-downtime is only used with --finish (the bucket's maintenance window).",
    ]);
    expect(flagProblems({ approve: "abc" })[0]).toContain("64-character SHA-256 plan hash");
    expect(flagProblems({ to: "New", approve: HASH, confirm: ["shop"] })).toEqual([]);
    expect(flagProblems({ finish: true, allowDowntime: true, approve: HASH })).toEqual([]);
  });
});

describe("MoveApprovalHandler in a script", () => {
  it("approves the switch with --confirm <zone> and --approve <its hash>, and nothing less", async () => {
    const both = handler({ approve: HASH, names: ["example.com"] });
    const decision = await both.approvals.request(SWITCH);
    expect(decision).toMatchObject({ approved: true, confirmation: "example.com" });
    expect(both.printed.join("")).toContain("(approved with --confirm example.com --approve");

    const noName = await handler({ approve: HASH }).approvals.request(SWITCH);
    expect(noName.approved).toBe(false);
    expect(noName.reason).toContain(`add --confirm example.com --approve ${HASH}`);
    const otherHash = await handler({ approve: OTHER, names: ["example.com"] }).approvals.request(
      SWITCH,
    );
    expect(otherHash.approved).toBe(false);
    const wrongName = await handler({ approve: HASH, names: ["example.org"] }).approvals.request(
      SWITCH,
    );
    expect(wrongName.approved).toBe(false);
  });

  it("approves the abort's typed confirmation of the nameservers with --confirm alone", async () => {
    const request: ApprovalRequest = {
      kind: "domain-settings",
      title: "Abort the move of example.com",
      details: "",
      confirmPhrase: "example.com",
    };
    expect((await handler({ names: ["example.com"] }).approvals.request(request)).approved).toBe(
      true,
    );
    const refused = await handler().approvals.request(request);
    expect(refused.approved).toBe(false);
    expect(refused.reason).toContain("add --confirm example.com, or run the command in a terminal");
  });

  it("approves a bucket's emptying, the app's deletions and B's zone only with the name and the hash", async () => {
    for (const [kind, phrase] of [
      ["remote-exec", "shop-uploads"],
      ["iac-apply", "shop"],
      ["cloudflare-apply", "example.com"],
    ] as const) {
      const request: ApprovalRequest = {
        kind,
        title: `Delete ${phrase}`,
        details: "",
        planHash: HASH,
        allowDestroy: true,
        confirmPhrase: phrase,
      };
      const approved = await handler({ approve: HASH, names: [phrase] }).approvals.request(request);
      expect(approved, kind).toMatchObject({ approved: true, confirmation: phrase });
      const hashOnly = await handler({ approve: HASH }).approvals.request(request);
      expect(hashOnly.approved, kind).toBe(false);
      const nameOnly = await handler({ names: [phrase] }).approvals.request(request);
      expect(nameOnly.approved, kind).toBe(false);
    }
  });

  it("approves a copy (remote-exec without a typed name) by its hash; anything else goes to the base", async () => {
    const copy: ApprovalRequest = {
      kind: "remote-exec",
      title: "Copy the buckets",
      details: "",
      planHash: HASH,
    };
    const { approvals, base } = handler({ approve: HASH });
    expect((await approvals.request(copy)).approved).toBe(true);
    expect((await approvals.request({ ...copy, planHash: OTHER })).approved).toBe(false);
    const plan: ApprovalRequest = {
      kind: "iac-apply",
      title: "B's pieces",
      details: "",
      planHash: HASH,
    };
    await approvals.request(plan);
    expect(base.seen).toEqual([{ ...copy, planHash: OTHER }, plan]);
  });

  it("asks the base handler for everything in a terminal, which asks for the typed name", async () => {
    const { approvals, base } = handler({
      interactive: true,
      approve: HASH,
      names: ["example.com"],
    });
    expect((await approvals.request(SWITCH)).approved).toBe(false);
    expect(base.seen).toEqual([SWITCH]);
  });

  it("the finish's maintenance window takes --allow-downtime around it", async () => {
    const ctx = createTestContext({ isInteractive: false });
    const { approvals } = handler();
    const window: ApprovalRequest = {
      kind: "remote-exec",
      title: "Maintenance window: stop shop on your server for about 3 minutes",
      details: "",
    };
    expect((await withAllowDowntime(ctx, true, approvals, clock).request(window)).approved).toBe(
      true,
    );
    expect(
      (await withAllowDowntime(ctx, undefined, approvals, clock).request(window)).approved,
    ).toBe(false);
  });
});

describe("opscrew cloudflare move", () => {
  let project: TempProject | undefined;
  afterEach(async () => {
    await project?.cleanup();
    project = undefined;
  });

  it("refuses --env plainly before anything runs", async () => {
    project = await tempProject();
    const ctx = projectContext(project);
    const code = await run(ctx, "cloudflare", "move", "--finish", "--env", "staging");
    expect(code).toBe(2);
    expect(ctx.errors).toContain("The move takes no --env");
    expect(ctx.errors).toContain("opscrew cloudflare move --help");
    expect(ctx.fetchUrls).toEqual([]);
  });

  it("--help explains each step and the flags a script needs", async () => {
    const ctx = createTestContext();
    await run(ctx, "cloudflare", "move", "--help");
    const help = ctx.output;
    for (const text of [
      "--to <account>",
      "--switch",
      "--finish",
      "--abort",
      "--approve <hash>",
      "--confirm <name>",
      "--allow-downtime",
      "--engine <name>",
      "prepare: B's zone (pending)",
      "once every app in the zone is prepared",
      "maintenance window",
      "before the switch changed anything",
      "OPSCREW_NEW_CLOUDFLARE_API_TOKEN",
    ]) {
      expect(help).toContain(text);
    }
    expect(help).not.toContain("--env");
  });
});

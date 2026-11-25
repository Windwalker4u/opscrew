// Feature 048 (T4803): `opscrew values set|unset|list`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FAKE_SOPS, FakeGitHub, FakeSops, testPlan } from "@opscrew/agents/testing";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { type DeployProject, DeployRunner, deployProject } from "../ui/__fixtures__/deploy";
import {
  auditText,
  CANCEL,
  GIT,
  projectContext,
  run,
  ScriptedPrompts,
} from "../ui/__fixtures__/harness";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Approves everything, and keeps what it was asked. */
class ApproveAll implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: true, approver: "test", decidedAt: "2026-11-25T12:00:00.000Z" };
  }
}

const KEY = fakeSecret("stripe-live-key", "cli-values-key");
const NEW_KEY = fakeSecret("stripe-live-key", "cli-values-new");
const SESSION = fakeSecret("generic-password", "cli-values-session");
const PEM = fakeSecret("private-key-pem", "cli-values-pem");

/** A deployed Hetzner app with STRIPE_SECRET_KEY, and the record provision leaves for it. */
async function setup() {
  project = await deployProject(testPlan({ deployed: true }));
  project.env.OPSCREW_SOPS_BIN = FAKE_SOPS;
  const home = resolveProjectPaths(project.root, { env: project.env }).projectHomeDir;
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, "app_values.json"),
    `${JSON.stringify({ app: { SESSION_SECRET: SESSION, STRIPE_SECRET_KEY: KEY }, build: {} })}\n`,
  );
  return project;
}

/** A script's run with `stdin` piped in (a terminal's prompt with `prompts`). */
function context(p: DeployProject, options: { stdin?: string; prompts?: ScriptedPrompts } = {}) {
  const github = new FakeGitHub();
  const approvals = new ApproveAll();
  const ctx = projectContext(p, {
    services: {
      runner: new FakeSops().runner(new DeployRunner()),
      approvalHandler: approvals,
      provision: { github },
      valueInput:
        options.prompts === undefined
          ? { isTTY: false, read: async () => options.stdin ?? "" }
          : { isTTY: true, read: async () => "" },
      ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    },
  });
  return { ctx, github, approvals };
}

/** Everything the run showed or recorded: output, errors, the audit log and the approvals. */
async function everything(p: DeployProject, c: ReturnType<typeof context>): Promise<string> {
  return [
    c.ctx.output,
    c.ctx.errors,
    await auditText(p),
    JSON.stringify(c.approvals.requests),
    await readFile(path.join(p.root, "opscrew", "plan.yaml"), "utf8"),
  ].join("\n");
}

describe.skipIf(!GIT)("opscrew values", () => {
  it("sets a value piped in, dropping the line end, and shows it nowhere", async () => {
    const p = await setup();
    const c = context(p, { stdin: `${NEW_KEY}\n` });
    expect(await run(c.ctx, "values", "set", "STRIPE_SECRET_KEY"), c.ctx.errors).toBe(0);
    expect(c.github.secrets.get("OPSCREW_APP_ENV")).toBe(
      `SESSION_SECRET=${SESSION}\nSTRIPE_SECRET_KEY=${NEW_KEY}\n`,
    );
    const all = await everything(p, c);
    for (const value of [NEW_KEY, KEY, SESSION]) expect(all).not.toContain(value);
    expect(c.ctx.output).toContain("The app gets the new values at its next deploy");
  });

  it("keeps a multi-line PEM exactly, and adds its new name to the plan", async () => {
    const p = await setup();
    const c = context(p, { stdin: PEM });
    expect(await run(c.ctx, "values", "set", "TLS_KEY"), c.ctx.errors).toBe(0);
    const appEnv = c.github.secrets.get("OPSCREW_APP_ENV") ?? "";
    expect(appEnv).toContain(`TLS_KEY="${PEM.replace(/\n/g, "\\n")}"`);
    const plan = await readArtifact("plan", path.join(p.root, "opscrew", "plan.yaml"));
    expect(plan.app.env.at(-1)).toEqual({ name: "TLS_KEY", secret: true, source: "user" });
    // The plan's change goes in the deploy pull request.
    expect(c.github.pulls).toHaveLength(1);
    expect(c.ctx.output).toContain("Pull request: ");
    expect(await everything(p, c)).not.toContain(PEM.split("\n")[1]);
  });

  it("asks a terminal for the value without showing it", async () => {
    const p = await setup();
    const prompts = new ScriptedPrompts([NEW_KEY]);
    const c = context(p, { prompts });
    expect(await run(c.ctx, "values", "set", "STRIPE_SECRET_KEY"), c.ctx.errors).toBe(0);
    expect(prompts.calls).toEqual([
      {
        kind: "password",
        message:
          "The value of STRIPE_SECRET_KEY for prod (it isn't shown; pipe a value with line ends in instead)",
      },
    ]);
    expect(c.github.secrets.get("OPSCREW_APP_ENV")).toContain(NEW_KEY);
    expect(c.ctx.output).not.toContain(NEW_KEY);
  });

  it("changes nothing when the terminal's prompt is cancelled", async () => {
    const p = await setup();
    const c = context(p, { prompts: new ScriptedPrompts([CANCEL]) });
    expect(await run(c.ctx, "values", "set", "STRIPE_SECRET_KEY")).toBe(1);
    expect(c.github.secrets.size).toBe(0);
  });

  it("refuses NAME=value on the command line without echoing it", async () => {
    const p = await setup();
    const c = context(p);
    expect(await run(c.ctx, "values", "set", `STRIPE_SECRET_KEY=${NEW_KEY}`)).toBe(2);
    expect(c.ctx.errors).toContain(
      "A value never goes on the command line, where your shell's history keeps it, so OpsCrew took none of STRIPE_SECRET_KEY's. Nothing was changed.",
    );
    expect(c.ctx.errors).not.toContain(NEW_KEY);
    expect(c.github.secrets.size).toBe(0);
  });

  it("sets every value of a dotenv file, a quoted multi-line one too", async () => {
    const p = await setup();
    const file = path.join(p.root, "staging-values.env");
    await writeFile(file, `STRIPE_SECRET_KEY=${NEW_KEY}\nTLS_KEY="${PEM.replace(/\n/g, "\\n")}"\n`);
    const c = context(p);
    expect(
      await run(c.ctx, "values", "set", "--from-file", "staging-values.env"),
      c.ctx.errors,
    ).toBe(0);
    const appEnv = c.github.secrets.get("OPSCREW_APP_ENV") ?? "";
    expect(appEnv).toContain(`STRIPE_SECRET_KEY=${NEW_KEY}`);
    expect(appEnv).toContain(`TLS_KEY="${PEM.replace(/\n/g, "\\n")}"`);
    const all = await everything(p, c);
    for (const value of [NEW_KEY, PEM.split("\n")[1] as string]) expect(all).not.toContain(value);
  });

  it("refuses an empty value, and names with --from-file", async () => {
    const p = await setup();
    const empty = context(p, { stdin: "\n" });
    expect(await run(empty.ctx, "values", "set", "STRIPE_SECRET_KEY")).toBe(2);
    expect(empty.ctx.errors).toContain("The value of STRIPE_SECRET_KEY is empty.");
    const both = context(p);
    expect(await run(both.ctx, "values", "set", "A", "--from-file", "x.env")).toBe(2);
    expect(both.ctx.errors).toContain("--from-file sets every value of its file");
  });

  it("removes a value and its name, and lists names without values", async () => {
    const p = await setup();
    const c = context(p);
    expect(await run(c.ctx, "values", "unset", "STRIPE_SECRET_KEY"), c.ctx.errors).toBe(0);
    expect(c.github.secrets.get("OPSCREW_APP_ENV")).toBe(`SESSION_SECRET=${SESSION}\n`);
    const listed = context(p);
    expect(await run(listed.ctx, "values", "list"), listed.ctx.errors).toBe(0);
    expect(listed.ctx.output).toBe(
      [
        "Name            Secret  From",
        "DATABASE_URL    yes     derived",
        "SESSION_SECRET  yes     generated",
        "",
      ].join("\n"),
    );
  });

  it("starts the deploy with --redeploy", async () => {
    const p = await setup();
    const c = context(p, { stdin: NEW_KEY });
    expect(await run(c.ctx, "values", "set", "STRIPE_SECRET_KEY", "--redeploy"), c.ctx.errors).toBe(
      0,
    );
    expect(c.github.dispatches).toEqual([{ workflowFile: "opscrew-deploy.yml", ref: "main" }]);
    expect(c.ctx.output).toContain("https://github.com/acme/shop/actions/runs/42");
  });
});

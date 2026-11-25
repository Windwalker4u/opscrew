import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ApprovalRequest,
  AuditEntry,
  AuditInput,
  AuditLog,
  CommandResult,
  CommandRunner,
  PhaseName,
  RuntimeEvent,
} from "@opscrew/contracts";
import { DefaultToolPolicy, nodeRealpath, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_OPENAI_ANALYST_MODEL,
  DEFAULT_OPENAI_MODEL,
  OpenAIAgentRuntime,
  type OpenAIResponseLike,
  type ResponsesCreateFn,
} from "./runtime";

class MemoryAudit implements AuditLog {
  entries: AuditInput[] = [];
  async append(entry: AuditInput): Promise<void> {
    this.entries.push(entry);
  }
  async readAll(): Promise<AuditEntry[]> {
    return this.entries.map((e) => ({ ...e, at: e.at ?? "2026-11-25T00:00:00.000Z" }));
  }
}

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
  result: CommandResult = { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
  async run(
    command: string,
    args: string[],
    options?: { env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.calls.push({
      command,
      args,
      ...(options?.env === undefined ? {} : { env: options.env }),
    });
    return this.result;
  }
}

const tempDirs: string[] = [];

async function makeTempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-openai-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

function msg(text: string): ResponseOutputItem {
  return {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function fnCall(callId: string, name: string, args: Record<string, unknown>): ResponseOutputItem {
  return {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
}

function makeRuntime(opts: {
  responsesCreate?: ResponsesCreateFn;
  env?: Record<string, string | undefined>;
  approvals?: { request(request: ApprovalRequest): Promise<{ approved: boolean }> };
  costLedger?: {
    append(entry: { phase: PhaseName; model?: string; costUsd: number }): Promise<void>;
  };
  defaultModel?: string;
  runner?: CommandRunner;
  redactor?: Redactor;
}) {
  const audit = new MemoryAudit();
  const redactor = opts.redactor ?? new Redactor();
  const runtime = new OpenAIAgentRuntime({
    policy: new DefaultToolPolicy({ realpath: nodeRealpath }),
    audit,
    redact: redactor.redact,
    env: opts.env ?? { OPENAI_API_KEY: fakeSecret("openai-key") },
    ...(opts.responsesCreate === undefined ? {} : { responsesCreate: opts.responsesCreate }),
    ...(opts.approvals === undefined ? {} : { approvals: opts.approvals }),
    ...(opts.costLedger === undefined ? {} : { costLedger: opts.costLedger }),
    ...(opts.defaultModel === undefined ? {} : { defaultModel: opts.defaultModel }),
    ...(opts.runner === undefined ? {} : { runner: opts.runner }),
  });
  return { runtime, audit, redactor };
}

describe("OpenAIAgentRuntime configuration and defaults", () => {
  it("reports availability cleanly and names OPENAI_API_KEY when absent", async () => {
    const { runtime: missing } = makeRuntime({ env: {} });
    const status = await missing.isConfigured();
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("OpenAI");
    expect(status.hint).toContain("OPENAI_API_KEY");

    const { runtime: blank } = makeRuntime({ env: { OPENAI_API_KEY: "   " } });
    expect((await blank.isConfigured()).ok).toBe(false);

    const { runtime: configured } = makeRuntime({
      env: { OPENAI_API_KEY: fakeSecret("openai-key") },
    });
    expect(await configured.isConfigured()).toEqual({ ok: true });
  });

  it("picks gpt-5-mini for analyze, gpt-5 for adapt, and honours explicit defaultModel", () => {
    const { runtime } = makeRuntime({});
    expect(runtime.id).toBe("openai-responses");
    expect(runtime.defaultModelFor("analyze")).toBe(DEFAULT_OPENAI_ANALYST_MODEL);
    expect(runtime.defaultModelFor("adapt")).toBe(DEFAULT_OPENAI_MODEL);

    const { runtime: custom } = makeRuntime({ defaultModel: "openai/gpt-4.1" });
    expect(custom.defaultModelFor("analyze")).toBe("openai/gpt-4.1");
    expect(custom.defaultModelFor("adapt")).toBe("openai/gpt-4.1");
  });
});

describe("OpenAIAgentRuntime execution loop", () => {
  it("runs a multi-turn read-only phase, validates structured output, and records cost", async () => {
    const root = await makeTempProject();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo-app" }));
    const seenParams: ResponseCreateParamsNonStreaming[] = [];
    const ledger: Array<{ phase: PhaseName; model?: string; costUsd: number }> = [];

    const turns: OpenAIResponseLike[] = [
      {
        id: "resp_1",
        model: "gpt-5-mini-2026-03-01",
        status: "completed",
        output: [fnCall("call_1", "Read", { file_path: "package.json" })],
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
      {
        id: "resp_2",
        model: "gpt-5-mini-2026-03-01",
        status: "completed",
        output: [msg(JSON.stringify({ summary: "Node app demo-app", risks: ["No health check"] }))],
        usage: {
          input_tokens: 2000,
          input_tokens_details: { cached_tokens: 1000 },
          output_tokens: 300,
        },
      },
    ];
    let turn = 0;
    const { runtime, audit } = makeRuntime({
      responsesCreate: async (params) => {
        seenParams.push(params);
        return turns[turn++] as OpenAIResponseLike;
      },
      costLedger: {
        append: async (entry) => {
          ledger.push(entry);
        },
      },
    });

    const schema = z.object({ summary: z.string(), risks: z.array(z.string()) });
    const result = await runtime.runPhase({
      phase: "analyze",
      systemPrompt: "Inspect the repo.",
      prompt: "Summarize this app.",
      projectRoot: root,
      profile: "read-only",
      output: { name: "architecture_summary", schema },
      effort: "medium",
    });

    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.output).toEqual({ summary: "Node app demo-app", risks: ["No health check"] });
    expect(result.turns).toBe(2);
    expect(result.sessionId).toBe("resp_1");
    expect(result.costUsd).toBeGreaterThan(0);
    expect(seenParams).toHaveLength(2);
    expect(seenParams[0]?.store).toBe(false);
    expect(seenParams[0]?.reasoning).toEqual({ effort: "medium" });
    expect(seenParams[0]?.tools?.map((t) => (t.type === "function" ? t.name : ""))).toEqual([
      "Read",
      "Glob",
      "Grep",
    ]);
    expect(seenParams[0]?.text?.format?.type).toBe("json_schema");
    // Turn 2 includes the tool result with package.json content
    const secondInput = seenParams[1]?.input as Array<{ type?: string; output?: string }>;
    const toolOut = secondInput.find((item) => item.type === "function_call_output");
    expect(toolOut?.output).toContain("demo-app");

    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.costUsd).toBeCloseTo(result.costUsd, 9);
    expect(audit.entries.some((e) => e.kind === "tool-call" && e.action === "Read")).toBe(true);
    expect(audit.entries.some((e) => e.kind === "phase" && e.action === "analyze")).toBe(true);
  });

  it("enforces ToolPolicy denials and never executes forbidden tools or reads .env", async () => {
    const root = await makeTempProject();
    await writeFile(path.join(root, ".env"), "SECRET=super-secret-value\n");
    const events: RuntimeEvent[] = [];
    const seenInputs: unknown[] = [];

    const turns: OpenAIResponseLike[] = [
      {
        id: "resp_1",
        model: "gpt-5-mini",
        status: "completed",
        output: [
          fnCall("c1", "Read", { file_path: ".env" }),
          fnCall("c2", "Write", { file_path: "hacked.txt", content: "bad" }),
        ],
        usage: { input_tokens: 500, output_tokens: 100 },
      },
      {
        id: "resp_2",
        model: "gpt-5-mini",
        status: "completed",
        output: [msg("Done without secrets.")],
        usage: { input_tokens: 500, output_tokens: 50 },
      },
    ];
    let i = 0;
    const { runtime, audit } = makeRuntime({
      responsesCreate: async (params) => {
        seenInputs.push(params.input);
        return turns[i++] as OpenAIResponseLike;
      },
    });

    const res = await runtime.runPhase({
      phase: "analyze",
      systemPrompt: "Read-only.",
      prompt: "Check.",
      projectRoot: root,
      profile: "read-only",
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(JSON.stringify(seenInputs)).not.toContain("super-secret-value");
    expect(audit.entries.filter((e) => e.kind === "tool-denied")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "tool-denied")).toHaveLength(2);
    await expect(readFile(path.join(root, "hacked.txt"), "utf8")).rejects.toThrow();
  });

  it("asks ApprovalHandler on policy ask (including .github workflow preview) and redacts tool outputs", async () => {
    const root = await makeTempProject();
    const secret = fakeSecret("hcloud-token");
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(path.join(root, "notes.txt"), `leaked ${secret}\n`);
    const redactor = new Redactor();
    redactor.addLiteral(secret, "HCLOUD_TOKEN");

    const approvalRequests: ApprovalRequest[] = [];
    const seenParams: ResponseCreateParamsNonStreaming[] = [];

    const turns: OpenAIResponseLike[] = [
      {
        id: "resp_1",
        model: "gpt-5",
        status: "completed",
        output: [
          fnCall("c1", "Read", { file_path: "notes.txt" }),
          fnCall("c2", "Write", {
            file_path: ".github/workflows/ci.yml",
            content: `name: ci\nenv:\n  TOKEN: ${secret}\n`,
          }),
        ],
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
      {
        id: "resp_2",
        model: "gpt-5",
        status: "completed",
        output: [msg("All done.")],
        usage: { input_tokens: 1200, output_tokens: 50 },
      },
    ];
    let i = 0;
    const { runtime, audit } = makeRuntime({
      redactor,
      approvals: {
        request: async (req) => {
          approvalRequests.push(req);
          return { approved: false };
        },
      },
      responsesCreate: async (params) => {
        seenParams.push(params);
        return turns[i++] as OpenAIResponseLike;
      },
    });

    const res = await runtime.runPhase({
      phase: "adapt",
      systemPrompt: "Edit repo.",
      prompt: `Prepare repo (ignore ${secret}).`,
      projectRoot: root,
      profile: "edit-repo",
    });

    expect(res.ok).toBe(true);
    // Secret must never appear in prompts, tool outputs sent to OpenAI, or approval previews
    expect(JSON.stringify(seenParams)).not.toContain(secret);
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]?.details).toContain("The new content:");
    expect(approvalRequests[0]?.details).not.toContain(secret);
    expect(audit.entries.some((e) => e.kind === "tool-denied" && e.decision === "refused")).toBe(
      true,
    );
    await expect(readFile(path.join(root, ".github/workflows/ci.yml"), "utf8")).rejects.toThrow();
  });

  it("maps invalid_output, max_turns, budget_exceeded, refused, aborted, and 401 auth errors", async () => {
    const root = await makeTempProject();

    // 1. invalid_output
    {
      const { runtime } = makeRuntime({
        responsesCreate: async () => ({
          id: "r1",
          model: "gpt-5-mini",
          status: "completed",
          output: [msg('{"wrong": true}')],
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      });
      const res = await runtime.runPhase({
        phase: "analyze",
        systemPrompt: "sys",
        prompt: "p",
        projectRoot: root,
        profile: "none",
        output: { name: "out", schema: z.object({ summary: z.string() }) },
      });
      expect(res.ok).toBe(false);
      expect(res.stopReason).toBe("invalid_output");
    }

    // 2. max_turns
    {
      const { runtime } = makeRuntime({
        responsesCreate: async () => ({
          id: "r2",
          model: "gpt-5-mini",
          status: "completed",
          output: [fnCall("c1", "Glob", { pattern: "*.ts" })],
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      });
      const res = await runtime.runPhase({
        phase: "analyze",
        systemPrompt: "sys",
        prompt: "p",
        projectRoot: root,
        profile: "read-only",
        maxTurns: 2,
      });
      expect(res.ok).toBe(false);
      expect(res.stopReason).toBe("max_turns");
      expect(res.turns).toBe(2);
    }

    // 3. budget_exceeded
    {
      const { runtime } = makeRuntime({
        responsesCreate: async () => ({
          id: "r3",
          model: "gpt-5",
          status: "completed",
          output: [fnCall("c1", "Glob", { pattern: "*.ts" })],
          usage: { input_tokens: 1_000_000, output_tokens: 100_000 }, // $2.25
        }),
      });
      const res = await runtime.runPhase({
        phase: "adapt",
        systemPrompt: "sys",
        prompt: "p",
        projectRoot: root,
        profile: "edit-repo",
        maxBudgetUsd: 1.0,
      });
      expect(res.ok).toBe(false);
      expect(res.stopReason).toBe("budget_exceeded");
      expect(res.costUsd).toBeGreaterThan(1.0);
    }

    // 4. refused
    {
      const { runtime } = makeRuntime({
        responsesCreate: async () => ({
          id: "r4",
          model: "gpt-5",
          status: "completed",
          output: [
            {
              type: "message",
              id: "m1",
              role: "assistant",
              status: "completed",
              content: [{ type: "refusal", refusal: "Cannot comply." }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      });
      const res = await runtime.runPhase({
        phase: "analyze",
        systemPrompt: "sys",
        prompt: "p",
        projectRoot: root,
        profile: "none",
      });
      expect(res.ok).toBe(false);
      expect(res.stopReason).toBe("refused");
    }

    // 5. aborted
    {
      const controller = new AbortController();
      controller.abort();
      const { runtime } = makeRuntime({
        responsesCreate: async () => {
          throw new Error("should not run");
        },
      });
      const res = await runtime.runPhase({
        phase: "analyze",
        systemPrompt: "sys",
        prompt: "p",
        projectRoot: root,
        profile: "none",
        signal: controller.signal,
      });
      expect(res.ok).toBe(false);
      expect(res.stopReason).toBe("aborted");
    }

    // 6. 401 auth error
    {
      const authError = Object.assign(new Error("Incorrect API key provided"), { status: 401 });
      const { runtime } = makeRuntime({
        env: {
          OPENAI_API_KEY: fakeSecret("openai-key"),
          OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
        },
        responsesCreate: async () => {
          throw authError;
        },
      });
      const res = await runtime.runPhase({
        phase: "analyze",
        systemPrompt: "sys",
        prompt: "p",
        projectRoot: root,
        profile: "none",
      });
      expect(res.ok).toBe(false);
      expect(res.stopReason).toBe("error");
      expect(res.error).toContain("OPENAI_API_KEY");
      expect(res.error).toContain("https://openrouter.ai/api/v1");
    }
  });

  it("forwards OPENAI_BASE_URL through the OpenAI SDK client using injected fetch", async () => {
    const root = await makeTempProject();
    const urls: string[] = [];
    const authHeaders: Array<string | null> = [];
    const key = fakeSecret("openai-key");
    const redactor = new Redactor();
    redactor.addLiteral(key, "OPENAI_API_KEY");

    const runtime = new OpenAIAgentRuntime({
      policy: new DefaultToolPolicy({ realpath: nodeRealpath }),
      audit: new MemoryAudit(),
      redact: redactor.redact,
      env: { OPENAI_API_KEY: key, OPENAI_BASE_URL: "https://gateway.example.test/v1" },
      runner: new FakeRunner(),
      fetch: async (input, init) => {
        urls.push(typeof input === "string" ? input : input.toString());
        const headers = new Headers(init?.headers);
        authHeaders.push(headers.get("authorization"));
        return new Response(
          JSON.stringify({
            id: "resp_gw",
            object: "response",
            model: "gpt-5-mini",
            status: "completed",
            output: [msg("Gateway works.")],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const res = await runtime.runPhase({
      phase: "analyze",
      systemPrompt: "sys",
      prompt: "hello",
      projectRoot: root,
      profile: "none",
    });
    expect(res.ok).toBe(true);
    expect(res.text).toBe("Gateway works.");
    expect(urls[0]).toBe("https://gateway.example.test/v1/responses");
    expect(authHeaders[0]).toBe(`Bearer ${key}`);
  });
});

import path from "node:path";
import type {
  AgentRuntime,
  ApprovalRequest,
  AuditLog,
  BuiltinTool,
  CommandRunner,
  FetchLike,
  PhaseName,
  PhaseRequest,
  PhaseResult,
  PhaseStopReason,
  RuntimeAvailability,
  RuntimeEvent,
  ToolPolicy,
} from "@opscrew/contracts";
import {
  errorMessage,
  isRecord,
  modelOutputMismatch,
  NodeCommandRunner,
  PROFILE_TOOLS,
  redactDeep,
} from "@opscrew/core";
import OpenAI from "openai";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { z } from "zod";
import {
  calculateUsageCost,
  type ModelPrice,
  resolveModelPrice,
  supportsReasoningEffort,
} from "./pricing";
import { executeBuiltinTool, toolDefinitionsFor } from "./tools";

/** Default OpenAI model for the Code-change agent and general phases (`gpt-6.2-sol`). */
export const DEFAULT_OPENAI_MODEL = "gpt-6.2-sol";

/** Default OpenAI model for the read-only Analyst (`analyze` phase: `gpt-6-luna`). */
export const DEFAULT_OPENAI_ANALYST_MODEL = "gpt-6-luna";

const DEFAULT_MAX_TURNS = 40;
const SHOWN_CONTENT = 4000;

const CREDENTIAL_HINT =
  "Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL for an OpenAI-compatible gateway such as OpenRouter), or set ANTHROPIC_API_KEY to use Claude.";

/**
 * Subset of `client.responses.create` used by the runtime. Injected in unit tests so no network
 * calls happen.
 */
export type ResponsesCreateFn = (
  params: ResponseCreateParamsNonStreaming,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

export interface OpenAIAgentRuntimeOptions {
  /** Decides every tool call (normally `DefaultToolPolicy`). */
  policy: ToolPolicy;
  audit: AuditLog;
  /** Applied to prompts, streamed events, tool results, audit details and final text. */
  redact: (text: string) => string;
  /** Asked when the policy returns `ask`. Without it, such calls are denied. */
  approvals?: { request(request: ApprovalRequest): Promise<{ approved: boolean }> };
  costLedger?: {
    append(entry: { phase: PhaseName; model?: string; costUsd: number }): Promise<void>;
  };
  /** Explicit default model overriding the per-phase defaults (`gpt-6-luna` / `gpt-6.2-sol`). */
  defaultModel?: string;
  /** Parent environment. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Subprocess runner for `Bash` tool calls. Defaults to `NodeCommandRunner`. */
  runner?: CommandRunner;
  /** Custom `fetch` implementation passed to the OpenAI SDK client (for tests or proxies). */
  fetch?: FetchLike;
  /** Direct Responses API transport override for deterministic unit tests. */
  responsesCreate?: ResponsesCreateFn;
  /** Pricing lookup override (defaults to the dated OpenAI list-price table). */
  resolvePrice?: (model: string) => ModelPrice | undefined;
  /** Host platform override for `Bash` shell resolution (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** File-existence check override for `Bash` shell resolution (defaults to `existsSync`). */
  fileExists?: (filePath: string) => boolean;
  /** Executable lookup override for `Bash` shell resolution (defaults to `findExecutable`). */
  findBin?: (name: string, env: Record<string, string | undefined>) => string | undefined;
}

// =============================================================================================
// Responses API response validation (constitution V)
// =============================================================================================

const OutputTextPartSchema = z.looseObject({
  type: z.literal("output_text"),
  text: z.string(),
});

const OutputRefusalPartSchema = z.looseObject({
  type: z.literal("refusal"),
  refusal: z.string(),
});

const OtherContentPartSchema = z.looseObject({
  type: z.string().refine((t) => t !== "output_text" && t !== "refusal", {
    message: "Malformed message content part",
  }),
});

const MessageOutputItemSchema = z.looseObject({
  type: z.literal("message"),
  content: z.array(
    z.union([OutputTextPartSchema, OutputRefusalPartSchema, OtherContentPartSchema]),
  ),
});

const FunctionCallOutputItemSchema = z.looseObject({
  type: z.literal("function_call"),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

const ReasoningSummaryPartSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});

const ReasoningOutputItemSchema = z.looseObject({
  type: z.literal("reasoning"),
  id: z.string().optional(),
  encrypted_content: z.string().nullable().optional(),
  summary: z.array(ReasoningSummaryPartSchema).optional(),
});

const OtherOutputItemSchema = z.looseObject({
  type: z.string().refine((t) => t !== "function_call" && t !== "message" && t !== "reasoning", {
    message: "Malformed output item",
  }),
});

const OutputItemSchema = z.union([
  FunctionCallOutputItemSchema,
  MessageOutputItemSchema,
  ReasoningOutputItemSchema,
  OtherOutputItemSchema,
]);

const UsageSchema = z.looseObject({
  input_tokens: z.number().nullable().optional(),
  output_tokens: z.number().nullable().optional(),
  input_tokens_details: z
    .looseObject({ cached_tokens: z.number().nullable().optional() })
    .nullable()
    .optional(),
  cost: z.number().nullable().optional(),
});

const OpenAIResponseSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  status: z.string().nullable().optional(),
  output: z.array(OutputItemSchema).optional(),
  output_text: z.string().optional(),
  usage: UsageSchema.nullable().optional(),
  incomplete_details: z
    .looseObject({ reason: z.string().nullable().optional() })
    .nullable()
    .optional(),
  error: z.looseObject({ message: z.string().nullable().optional() }).nullable().optional(),
});

type ValidatedResponse = z.infer<typeof OpenAIResponseSchema>;
type ValidatedOutputItem = z.infer<typeof OutputItemSchema>;
type ValidatedFunctionCall = z.infer<typeof FunctionCallOutputItemSchema>;

/**
 * `AgentRuntime` backed by the official `openai` SDK's Responses API (`responses.create`, stateless
 * `store: false`). Every tool call is executed locally by OpsCrew after passing through
 * `ToolPolicy` and `ApprovalHandler`, with all inputs and tool results redacted before leaving the
 * machine.
 */
export class OpenAIAgentRuntime implements AgentRuntime {
  readonly id = "openai-responses";
  readonly #options: OpenAIAgentRuntimeOptions;
  readonly #explicitDefaultModel: string | undefined;

  constructor(options: OpenAIAgentRuntimeOptions) {
    this.#options = options;
    const trimmed = options.defaultModel?.trim();
    this.#explicitDefaultModel = trimmed === "" ? undefined : trimmed;
  }

  defaultModelFor(phase: PhaseName): string {
    if (this.#explicitDefaultModel !== undefined) return this.#explicitDefaultModel;
    return phase === "analyze" ? DEFAULT_OPENAI_ANALYST_MODEL : DEFAULT_OPENAI_MODEL;
  }

  async isConfigured(): Promise<RuntimeAvailability> {
    const key = (this.#env().OPENAI_API_KEY ?? "").trim();
    if (key !== "") return { ok: true };
    return {
      ok: false,
      reason: "No OpenAI API key was found, so OpsCrew cannot run its AI agents.",
      hint: CREDENTIAL_HINT,
    };
  }

  async runPhase<T>(request: PhaseRequest<T>): Promise<PhaseResult<T>> {
    const env = this.#env();
    return new OpenAIPhaseRun(
      this.#options,
      env,
      this.defaultModelFor(request.phase),
      request,
    ).run();
  }

  #env(): Record<string, string | undefined> {
    return this.#options.env ?? process.env;
  }
}

class OpenAIPhaseRun<T> {
  #sessionId: string | undefined;
  #model: string;
  #lastText = "";
  #costUsd = 0;
  #turns = 0;

  constructor(
    private readonly options: OpenAIAgentRuntimeOptions,
    private readonly env: Record<string, string | undefined>,
    defaultModel: string,
    private readonly request: PhaseRequest<T>,
  ) {
    this.#model = request.model ?? defaultModel;
  }

  async run(): Promise<PhaseResult<T>> {
    const { request } = this;
    if (this.#isAborted()) return this.#finish(this.#aborted());

    const createResponse = this.#resolveTransport();
    if (typeof createResponse === "string") {
      return this.#finish(this.#failed(createResponse));
    }

    const hasGatewayBaseUrl = (this.env.OPENAI_BASE_URL ?? "").trim() !== "";
    const lookupPrice = this.options.resolvePrice ?? resolveModelPrice;
    if (
      request.maxBudgetUsd !== undefined &&
      !hasGatewayBaseUrl &&
      lookupPrice(this.#model) === undefined
    ) {
      return this.#finish(this.#failed(unpricedModelMessage(this.#model)));
    }

    const profileTools = PROFILE_TOOLS[request.profile] ?? [];
    const builtins = profileTools.filter(
      (name) => request.builtinTools === undefined || request.builtinTools.includes(name),
    );
    const enabledSet = new Set<string>(builtins);
    const toolDefs = toolDefinitionsFor(builtins);
    const instructions = this.#redact(request.systemPrompt);
    const input: ResponseInputItem[] = [{ role: "user", content: this.#redact(request.prompt) }];
    const maxTurns = request.maxTurns ?? DEFAULT_MAX_TURNS;
    const runner = this.options.runner ?? new NodeCommandRunner();

    this.#emit({ kind: "status", message: `Agent session started (${this.#model}).` });

    let result: PhaseResult<T> | undefined;

    while (true) {
      if (this.#isAborted()) {
        result = this.#aborted();
        break;
      }

      const params = this.#buildParams(instructions, [...input], toolDefs);
      let rawResponse: unknown;
      try {
        rawResponse = await createResponse(
          params,
          request.signal === undefined ? undefined : { signal: request.signal },
        );
      } catch (error) {
        if (this.#isAborted() || isAbortError(error)) {
          result = this.#aborted();
        } else {
          result = this.#failed(this.#formatApiError(error));
        }
        break;
      }

      const validated = OpenAIResponseSchema.safeParse(rawResponse);
      if (!validated.success) {
        result = this.#failed(
          `OpenAI returned an unexpected response format (${validated.error.issues[0]?.message ?? "invalid payload"}).`,
        );
        break;
      }
      const response = validated.data;

      if (response.id !== undefined) this.#sessionId ??= response.id;
      if (typeof response.model === "string" && response.model.trim() !== "") {
        this.#model = response.model;
      }
      this.#turns += 1;

      const usageCost = calculateUsageCost(this.#model, response.usage, lookupPrice);
      this.#costUsd += usageCost.costUsd;

      if (request.maxBudgetUsd !== undefined && !usageCost.priced) {
        result = this.#failed(unpricedModelMessage(this.#model));
        break;
      }

      const outputItems = response.output ?? [];
      const refusal = extractRefusal(outputItems, response);
      if (refusal !== undefined) {
        result = this.#result("refused", this.#errorText("refused", refusal));
        break;
      }

      const turnText = extractText(outputItems, response.output_text);
      if (turnText !== "") {
        this.#lastText = turnText;
        this.#emit({ kind: "assistant-text", message: turnText });
      }

      const toolCalls = outputItems.filter(
        (item): item is ValidatedFunctionCall =>
          item.type === "function_call" &&
          "call_id" in item &&
          "name" in item &&
          "arguments" in item,
      );

      if (
        request.maxBudgetUsd !== undefined &&
        (this.#costUsd > request.maxBudgetUsd ||
          (toolCalls.length > 0 && this.#costUsd >= request.maxBudgetUsd))
      ) {
        result = this.#result("budget_exceeded", this.#errorText("budget_exceeded"));
        break;
      }

      if (toolCalls.length === 0) {
        if (response.status === "failed") {
          const detail = response.error?.message ?? "The OpenAI agent reported a failure.";
          result = this.#failed(detail);
          break;
        }
        result = this.#finalizeAnswer(turnText);
        break;
      }

      if (this.#turns >= maxTurns) {
        result = this.#result("max_turns", this.#errorText("max_turns"));
        break;
      }

      for (const item of outputItems) {
        const forwarded = this.#forwardOutputItem(item);
        if (forwarded !== undefined) input.push(forwarded);
      }

      for (const call of toolCalls) {
        if (this.#isAborted()) {
          result = this.#aborted();
          break;
        }
        const toolOutput = await this.#handleToolCall(call, enabledSet, runner);
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: toolOutput,
        });
      }
      if (result !== undefined) break;
    }

    if (this.#turns > 0 || this.#costUsd > 0) {
      await this.options.costLedger?.append({
        phase: request.phase,
        model: result.model ?? this.#model,
        costUsd: result.costUsd,
      });
    }
    return this.#finish(result);
  }

  /**
   * Converts a response output item for stateless multi-turn replay (`store: false`).
   * - Reasoning items require `encrypted_content` (requested via `include: ["reasoning.encrypted_content"]`);
   *   `encrypted_content` is kept unredacted so the API can verify it, while any summary text is redacted.
   *   Reasoning items without `encrypted_content` are dropped so OpenAI never returns 404 for `rs_...`.
   * - Function calls and assistant messages are redacted and replayed without server-stored ids.
   */
  #forwardOutputItem(item: ValidatedOutputItem): ResponseInputItem | undefined {
    if (item.type === "reasoning") {
      const id = "id" in item ? item.id : undefined;
      const encrypted = "encrypted_content" in item ? item.encrypted_content : undefined;
      if (
        typeof id !== "string" ||
        id === "" ||
        typeof encrypted !== "string" ||
        encrypted === ""
      ) {
        return undefined;
      }
      const summary =
        "summary" in item && Array.isArray(item.summary)
          ? redactDeep(item.summary, (text) => this.#redact(text))
          : [];
      return {
        type: "reasoning",
        id,
        summary,
        encrypted_content: encrypted,
      } as ResponseInputItem;
    }
    if (
      item.type === "function_call" &&
      "call_id" in item &&
      typeof item.call_id === "string" &&
      "name" in item &&
      typeof item.name === "string" &&
      "arguments" in item &&
      typeof item.arguments === "string"
    ) {
      return {
        type: "function_call",
        call_id: item.call_id,
        name: item.name,
        arguments: this.#redact(item.arguments),
      } as ResponseInputItem;
    }
    if (item.type === "message" && "content" in item && Array.isArray(item.content)) {
      const text = extractText([item], undefined);
      if (text === "") return undefined;
      return {
        role: "assistant",
        content: this.#redact(text),
      } as ResponseInputItem;
    }
    return undefined;
  }

  #resolveTransport(): ResponsesCreateFn | string {
    if (this.options.responsesCreate !== undefined) return this.options.responsesCreate;
    const apiKey = (this.env.OPENAI_API_KEY ?? "").trim();
    if (apiKey === "") {
      return `No OpenAI API key was found. ${CREDENTIAL_HINT}`;
    }
    const baseURL = this.env.OPENAI_BASE_URL?.trim();
    const client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch as unknown as typeof globalThis.fetch }),
      maxRetries: 2,
    });
    return (params, options) =>
      client.responses.create(
        params,
        options?.signal === undefined ? undefined : { signal: options.signal },
      );
  }

  #buildParams(
    instructions: string,
    input: ResponseInputItem[],
    toolDefs: ReturnType<typeof toolDefinitionsFor>,
  ): ResponseCreateParamsNonStreaming {
    const { request } = this;
    const reasoningModel = supportsReasoningEffort(this.#model);
    const params: ResponseCreateParamsNonStreaming = {
      model: this.#model,
      instructions,
      input,
      store: false,
    };
    if (toolDefs.length > 0) params.tools = toolDefs;
    if (reasoningModel) {
      params.include = ["reasoning.encrypted_content"];
      if (request.effort !== undefined) {
        params.reasoning = { effort: request.effort };
      }
    }
    if (request.output !== undefined) {
      params.text = {
        format: {
          type: "json_schema",
          name: sanitizeSchemaName(request.output.name),
          ...(request.output.description === undefined
            ? {}
            : { description: request.output.description }),
          schema: z.toJSONSchema(request.output.schema, { target: "draft-07" }) as Record<
            string,
            unknown
          >,
          strict: false,
        },
      };
    }
    return params;
  }

  async #handleToolCall(
    call: ValidatedFunctionCall,
    enabledTools: ReadonlySet<string>,
    runner: CommandRunner,
  ): Promise<string> {
    const toolName = call.name;
    let parsedInput: unknown;
    try {
      parsedInput = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
    } catch {
      const reason = `Invalid JSON arguments for tool \`${toolName}\`.`;
      await this.#deny(toolName, undefined, "deny", reason);
      return `Tool call denied: ${this.#redact(reason)}`;
    }
    if (!isRecord(parsedInput)) {
      const reason = `Tool \`${toolName}\` requires a JSON object of arguments.`;
      await this.#deny(toolName, undefined, "deny", reason);
      return `Tool call denied: ${this.#redact(reason)}`;
    }

    const target = describeInput(toolName, parsedInput);
    if (!enabledTools.has(toolName)) {
      const reason = `${toolName} is not enabled for this phase (${this.request.profile} profile).`;
      await this.#deny(toolName, target, "deny", reason);
      return `Tool call denied: ${this.#redact(reason)}`;
    }

    const decision = this.options.policy.evaluate({
      tool: toolName,
      input: parsedInput,
      phase: this.request.phase,
      profile: this.request.profile,
      projectRoot: this.request.projectRoot,
    });

    let auditDecision: "allow" | "approved";
    if (decision.decision === "allow") {
      auditDecision = "allow";
    } else if (decision.decision === "deny") {
      await this.#deny(toolName, target, "deny", decision.reason);
      return `Tool call denied: ${this.#redact(decision.reason)}`;
    } else {
      const approvals = this.options.approvals;
      if (approvals === undefined) {
        const reason = `${decision.reason} No one is available to approve it in this run, so it was denied.`;
        await this.#deny(toolName, target, "deny", reason);
        return `Tool call denied: ${this.#redact(reason)}`;
      }
      let details = this.#redact(
        [target ? `${toolName}: ${target}` : toolName, decision.reason].join("\n"),
      );
      const content = actionsFileContent(toolName, parsedInput, this.request.projectRoot);
      if (content !== undefined) {
        const shown = this.#redact(content);
        const left = shown.length - SHOWN_CONTENT;
        details += `\n\nThe new content:\n${shown.slice(0, SHOWN_CONTENT)}`;
        if (left > 0) details += `\n… ${left} more characters not shown`;
      }
      let approved = false;
      try {
        const answer = await approvals.request({
          kind: "tool-call",
          title: `Allow the ${this.request.phase} agent to use ${toolName}?`,
          details,
        });
        approved = answer.approved === true;
      } catch {
        approved = false;
      }
      if (!approved) {
        const reason = `${decision.reason} The request was not approved.`;
        await this.#deny(toolName, target, "refused", reason);
        return `Tool call denied: ${this.#redact(reason)}`;
      }
      auditDecision = "approved";
    }

    this.#emit({
      kind: "tool-call",
      tool: toolName,
      message: target ? `${toolName}: ${target}` : toolName,
    });

    const exec = await executeBuiltinTool(toolName as BuiltinTool, parsedInput, {
      projectRoot: this.request.projectRoot,
      env: this.env,
      runner,
      ...(this.request.signal === undefined ? {} : { signal: this.request.signal }),
      ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
      ...(this.options.fileExists === undefined ? {} : { fileExists: this.options.fileExists }),
      ...(this.options.findBin === undefined ? {} : { findBin: this.options.findBin }),
    });

    try {
      await this.options.audit.append({
        kind: "tool-call",
        actor: "agent",
        ...this.#toolFields(toolName, target),
        decision: auditDecision,
        ...(exec.ok ? {} : { detail: this.#redact(`failed: ${shorten(exec.output, 300)}`) }),
      });
    } catch {
      // A failed audit write must not break the agent loop after the tool already ran.
    }

    this.#emit({
      kind: "tool-result",
      tool: toolName,
      message: exec.ok ? `${toolName} finished` : `${toolName} failed`,
    });

    // Constitution IV: redact every tool output before it is sent back to the model.
    return this.#redact(exec.output);
  }

  #finalizeAnswer(text: string): PhaseResult<T> {
    const redactedText = this.#redact(text);
    const base = this.#baseResult(redactedText);
    if (this.request.output === undefined) {
      return { ...base, ok: true, stopReason: "completed" };
    }
    const candidate = parseJson(text);
    const parsed = this.request.output.schema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ...base,
        ok: false,
        stopReason: "invalid_output",
        error: this.#redact(modelOutputMismatch(this.request.output.name, parsed.error)),
      };
    }
    return { ...base, ok: true, stopReason: "completed", output: parsed.data };
  }

  async #deny(
    tool: string,
    target: string | undefined,
    decision: "deny" | "refused",
    rawReason: string,
  ): Promise<void> {
    const reason = this.#redact(rawReason);
    try {
      await this.options.audit.append({
        kind: "tool-denied",
        actor: "opscrew",
        ...this.#toolFields(tool, target),
        decision,
        detail: reason,
      });
    } catch {
      // Denial still stands if audit append fails.
    }
    this.#emit({ kind: "tool-denied", tool, message: `${tool} denied: ${reason}` });
  }

  #toolFields(tool: string, target: string | undefined) {
    return {
      action: tool,
      phase: this.request.phase,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(target === undefined ? {} : { target: shorten(this.#redact(target)) }),
    };
  }

  #formatApiError(error: unknown): string {
    const status = getHttpStatus(error);
    if (status === 401 || status === 403) {
      const baseURL = this.env.OPENAI_BASE_URL?.trim();
      const where = baseURL ? ` (using OPENAI_BASE_URL=${baseURL})` : "";
      return `OpenAI rejected OPENAI_API_KEY (HTTP ${status})${where}. Check that the key is valid and has access to model "${this.#model}", then try again.`;
    }
    return `The OpenAI agent failed: ${errorMessage(error)}`;
  }

  #errorText(stopReason: PhaseStopReason, detail?: string): string {
    const { request } = this;
    switch (stopReason) {
      case "max_turns":
        return `The ${request.phase} phase stopped after reaching its limit of ${request.maxTurns ?? DEFAULT_MAX_TURNS} turns. Try again with a higher limit or a narrower request.`;
      case "budget_exceeded":
        return `The ${request.phase} phase stopped because it reached its spending limit${request.maxBudgetUsd === undefined ? "" : ` of $${request.maxBudgetUsd}`}. Raise the budget to continue.`;
      case "invalid_output":
        return `The model could not produce output in the expected ${request.output?.name ?? "structured"} format.`;
      case "refused":
        return detail && detail.trim() !== ""
          ? this.#redact(`The model declined to complete the ${request.phase} phase: ${detail}`)
          : `The model declined to complete the ${request.phase} phase.`;
      case "aborted":
        return `The ${request.phase} phase was cancelled.`;
      default:
        return this.#redact(detail ?? "The OpenAI agent stopped because of an error.");
    }
  }

  #baseResult(text: string): PhaseResult<T> {
    const result: PhaseResult<T> = {
      ok: false,
      stopReason: "error",
      text,
      costUsd: this.#costUsd,
      turns: this.#turns,
      model: this.#model,
    };
    if (this.#sessionId !== undefined) result.sessionId = this.#sessionId;
    return result;
  }

  #result(stopReason: PhaseStopReason, error: string): PhaseResult<T> {
    return {
      ...this.#baseResult(this.#redact(this.#lastText)),
      stopReason,
      error: this.#redact(error),
    };
  }

  #aborted(): PhaseResult<T> {
    return this.#result("aborted", this.#errorText("aborted"));
  }

  #failed(message: string): PhaseResult<T> {
    return this.#result("error", message);
  }

  async #finish(result: PhaseResult<T>): Promise<PhaseResult<T>> {
    try {
      await this.options.audit.append({
        kind: "phase",
        actor: "agent",
        action: this.request.phase,
        phase: this.request.phase,
        ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        detail: `${result.stopReason}; ${result.turns} turns; $${result.costUsd.toFixed(4)}`,
      });
    } catch {
      // The phase result matters more than its summary line in the audit log.
    }
    this.#emit({ kind: "status", message: `Phase ${this.request.phase}: ${result.stopReason}.` });
    return result;
  }

  #emit(event: RuntimeEvent): void {
    const handler = this.request.onEvent;
    if (handler === undefined) return;
    try {
      handler({ ...event, message: shorten(this.#redact(event.message), 500) });
    } catch {
      // A failing progress listener must not break the agent loop.
    }
  }

  #redact(text: string): string {
    return this.options.redact(text);
  }

  #isAborted(): boolean {
    return this.request.signal?.aborted === true;
  }
}

function unpricedModelMessage(model: string): string {
  return `OpsCrew does not have a list price for model "${model}" and the API did not report a turn cost, so it cannot enforce the spending limit. Pick a priced OpenAI model (such as ${DEFAULT_OPENAI_ANALYST_MODEL} or ${DEFAULT_OPENAI_MODEL}) or a gateway that reports usage.cost.`;
}

function sanitizeSchemaName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned === "" ? "phase_output" : cleaned;
}

function extractRefusal(
  output: readonly ValidatedOutputItem[],
  response: ValidatedResponse,
): string | undefined {
  for (const item of output) {
    if (item.type !== "message" || !("content" in item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === "refusal" && "refusal" in part && typeof part.refusal === "string") {
        return part.refusal;
      }
    }
  }
  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "content_filter"
  ) {
    return "blocked by content filter";
  }
  return undefined;
}

function extractText(
  output: readonly ValidatedOutputItem[],
  fallbackOutputText: string | undefined,
): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== "message" || !("content" in item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (
        part.type === "output_text" &&
        "text" in part &&
        typeof part.text === "string" &&
        part.text.trim() !== ""
      ) {
        parts.push(part.text);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n");
  return typeof fallbackOutputText === "string" ? fallbackOutputText : "";
}

function describeInput(tool: string, input: Record<string, unknown>): string | undefined {
  const pick = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;
  return tool === "Bash" ? pick("command") : (pick("file_path") ?? pick("pattern") ?? pick("path"));
}

function actionsFileContent(
  tool: string,
  input: Record<string, unknown>,
  root: string,
): string | undefined {
  if (typeof input.file_path !== "string") return undefined;
  const segments = path
    .relative(root, path.resolve(root, input.file_path))
    .toLowerCase()
    .split(/[\\/]+/);
  const base = segments.at(-1);
  if (segments[0] !== ".github" && base !== "action.yml" && base !== "action.yaml") {
    return undefined;
  }
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (tool === "Write") return text(input.content);
  if (tool === "Edit") return text(input.new_string);
  return undefined;
}

function shorten(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    return undefined;
  }
}

function getHttpStatus(error: unknown): number | undefined {
  if (isRecord(error) && typeof error.status === "number") return error.status;
  return undefined;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "APIUserAbortError";
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  applyCommand,
  BACKUPS_PLAN_SUFFIX,
  CHECK_MARK,
  changesNothing,
  describeChanges,
  describePlan,
  findSavedPlan,
  OFFSITE_KEY_VARS,
  OWN_SERVER_BACKUPS_NOTE,
  type ProvisionResult,
  type ProvisionServices,
  portainerImageOptions,
  portainerNotes,
  previewDeploymentFiles,
  REPLACEABLE_TOKENS,
  type RunSecureOptions,
  type RunVerifyOptions,
  readSavedLocalPlan,
  readSavedPlanChanges,
  runProvision,
  runSecure,
  runVerify,
  type SavedPlan,
  STORAGE_KEY_VARS,
  STORAGE_PLAN_SUFFIX,
  savedLocalPlanChanges,
  stackFollowsReason,
  stringOutput,
  summarizeChecks,
} from "@opscrew/agents";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  CheckResult,
  Clock,
} from "@opscrew/contracts";
import {
  approvalDecision,
  formatMoney,
  isPlanHash,
  isUserFacingError,
  OpsCrewError,
  resolveProjectPaths,
} from "@opscrew/core";
import { backupsBucketOf, type DeployPlan, onOneServer, readArtifact } from "@opscrew/plan-schema";
import { CLOUD_CREDENTIALS } from "@opscrew/providers";
import { DEEP_TOOL_NAME, type DeepToolResult } from "@opscrew/secops";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import {
  type CallExtra,
  dialogHandler,
  type ElicitationApprovalHandler,
  REQUIRES_USER,
  requireDialogs,
} from "./elicitation";
import {
  appInput,
  appliedCloudflarePlan,
  environmentInput,
  IDEMPOTENT_WRITE,
  projectDirInput,
  runTool,
  skipOtherAppsCheckInput,
  skipOtherAppsFlag,
  toolEnvironment,
} from "./shared";

/**
 * Test-only collaborators for the deploy tools. Production leaves them unset, so every phase uses
 * its real defaults (engine binary, provider APIs, SSH, DNS, TLS, TCP).
 */
export interface DeployToolOptions {
  /** Fakes for `runProvision` / `previewDeploymentFiles` (engine, cloud provider, GitHub, SSH, waits). */
  provisionServices?: ProvisionServices;
  /** Fakes for `runSecure` (remote shell, TCP probe). */
  secure?: Pick<
    RunSecureOptions,
    "remote" | "tcpConnect" | "probeTimeoutMs" | "portainer" | "docker"
  >;
  /** Fakes for `runVerify` (resolver, fetch, TLS, TCP, Cloudflare ranges). */
  verify?: RunVerifyOptions;
  /** Replaces `runProvision` (tests of the user's Portainer, whose flow `@opscrew/agents` tests). */
  runProvision?: typeof runProvision;
}

/**
 * Approval handler for `opscrew_plan`: the user's call of that tool (Claude Code asks for it every
 * time, see `anthropic/requiresUserInteraction`) approves writing the generated deployment files
 * into the repository, which git shows and can undo. Everything else is refused.
 */
class PlanToolApprovalHandler implements ApprovalHandler {
  constructor(private readonly clock: Clock) {}
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const approved = request.kind === "repo-write";
    return approvalDecision(
      this.clock,
      "user (opscrew_plan tool call)",
      approved,
      approved
        ? {}
        : {
            reason:
              "opscrew_plan only plans. Apply the plan with opscrew_apply or `opscrew provision --approve <hash>`.",
          },
    );
  }
}

const servicesOption = (options: DeployToolOptions) =>
  options.provisionServices !== undefined ? { services: options.provisionServices } : {};

/** Plan file details for the result (the engine's raw plan JSON is left out: it is large). */
function planData(saved: SavedPlan) {
  return {
    planHash: saved.planHash,
    engine: saved.engine,
    createdAt: saved.createdAt,
    changes: saved.changes,
    counts: saved.counts,
    hasDestroy: saved.hasDestroy,
    policy: saved.policy,
  };
}

/**
 * The plan of a bucket, for the user: the app's (the `storage` root, with its monthly price, its
 * source and date) or the off-server copies' (the `backups` root). Its changes, its policy results,
 * and where the user's own key for it comes from.
 */
function bucketPlanText(saved: SavedPlan, plan: DeployPlan, root: "storage" | "backups"): string {
  const storage = root === "storage" ? plan.storage?.objectStorage : undefined;
  // The backups root holds only a bucket OpsCrew plans: never the user's own bucket or machine.
  const bucket = root === "storage" ? storage?.bucket : backupsBucketOf(plan)?.bucket;
  const vars = root === "storage" ? STORAGE_KEY_VARS : OFFSITE_KEY_VARS;
  const failed = saved.policy.filter((result) => !result.passed);
  return [
    `Plan of ${root === "storage" ? "the app's bucket" : "the bucket of the off-server copies of the app's snapshots"}${bucket === undefined ? "" : ` ${bucket}`}${root === "storage" ? " (object storage)" : ""}, with its own hash ${saved.planHash}:`,
    ...describeChanges(saved.changes),
    ...(storage === undefined
      ? []
      : [
          `Cost: about ${formatMoney({ amount: storage.price.monthly, currency: storage.price.currency })} a month (from ${storage.price.source}, checked on ${storage.price.checkedOn}).`,
        ]),
    `Security policies: ${saved.policy.length - failed.length} passed, ${failed.length} failed.`,
    ...failed.map((result) => `  ✗ [${result.severity}] ${result.title}: ${result.message}`),
    `${root === "storage" ? "The app's key" : "The key"} for it is the user's own: \`opscrew provision\` in a terminal asks for it, or it comes from ${vars.accessKeyId} and ${vars.secretAccessKey}. Never ask for it in the chat.`,
  ].join("\n");
}

function checkLines(checks: readonly CheckResult[]): string[] {
  return checks.map(
    (c) =>
      `${CHECK_MARK[c.status]} [${c.severity}] ${c.title}: ${c.message}${c.status === "fail" && c.remediation ? ` Fix: ${c.remediation}` : ""}`,
  );
}

/** The deeper checks per tool: its version, the results that count, then its known noise apart. */
function deepLines(runs: readonly DeepToolResult[]): string[] {
  return runs.flatMap((run) => {
    const index = run.hardeningIndex === undefined ? "" : `, hardening index ${run.hardeningIndex}`;
    const noise = run.results.filter((result) => result.noise !== undefined);
    return [
      "",
      `Deeper check: ${DEEP_TOOL_NAME[run.tool]} ${run.version}${index}`,
      ...checkLines(run.results.filter((result) => result.noise === undefined)),
      ...noise.map((result) => `  known noise: ${result.title} (${result.noise})`),
    ];
  });
}

/** The CLI's `--password-logins off|keep` for a server the user owns. */
const PASSWORD_LOGINS_INPUT = z.enum(["off", "keep"]).optional();

/** The CLI's `--public-image` (true) and `--private-image` (false) for the user's Portainer. */
const PUBLIC_IMAGE_INPUT = z
  .boolean()
  .optional()
  .describe(
    "Portainer, only when the user says so: is the app's image public? Same for plan and apply.",
  );

/** The CLI's `--replace-token repository|registry` for the user's Portainer. */
const REPLACE_TOKENS_INPUT = z
  .array(z.enum(REPLACEABLE_TOKENS))
  .max(2)
  .optional()
  .describe("Portainer, after the user rotated a token: resend it. Same for plan and apply.");

/** The CLI's `--pages-verification <value>` for a site on GitHub Pages. */
const PAGES_VERIFICATION_INPUT = z
  .string()
  .optional()
  .describe("GitHub Pages, when asked: the user's verification value. Same for plan and apply.");

/** What to do about a missing or damaged saved plan through MCP. */
const PLAN_AGAIN =
  "Call opscrew_plan again, show the new plans to the user and apply their hashes.";

/** The stop when no saved `what` (`plan`, `host plan`, `stack plan`) has `hash`. */
function noSavedPlan(what: string, hash: string): OpsCrewError {
  return new OpsCrewError("PLAN_HASH_MISMATCH", `No saved ${what} has the hash ${hash}.`, {
    hint: PLAN_AGAIN,
  });
}

/**
 * The plan OpsCrew described while planning (from the collected messages): the first message that
 * starts with `prefix` and, when given, names `hash`.
 */
function planText(
  messages: readonly { message: string }[],
  prefix: string,
  hash?: string,
): string | undefined {
  return messages.find(
    (m) => m.message.startsWith(prefix) && (hash === undefined || m.message.includes(hash)),
  )?.message;
}

/** The terminal command that sets up a hosting account, and why it runs there. */
function hostingTerminal(flag: string): string {
  return `A hosting account is set up from the user's terminal: hosting plan B (the app) is built from the agent's first report once plan A (the agent) is applied, and each is shown and approved by its own hash there. Ask the user to run \`npx opscrew provision${flag}\` in the project directory.`;
}

/** `opscrew_apply` on a hosting account: {@link hostingTerminal}. */
function hostingInTerminal(flag: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "opscrew_apply doesn't set up a hosting account. Nothing was changed.",
    { hint: hostingTerminal(flag) },
  );
}

/**
 * `opscrew_plan` on a hosting account: the DNS records' plan on Cloudflare (`dns`, saved by the
 * engine) and each hosting plan that changes something, as OpsCrew described them with their
 * hashes, and the terminal command that approves them (`--yes` never approves a plan).
 */
function hostingPlanReply(
  messages: readonly { message: string }[],
  input: { hostingHashes: readonly string[]; dns: SavedPlan | undefined; plan: DeployPlan },
  flag: string,
): { text: string; data: Record<string, unknown> } {
  const { hostingHashes, dns, plan } = input;
  const hashes = [...hostingHashes, ...(dns === undefined ? [] : [dns.planHash])];
  if (hashes.length === 0) {
    return {
      text: `The user's hosting account and its DNS records already match the plans; nothing would change. ${hostingTerminal(flag)} It finishes the remaining steps (the certificate, the GitHub keys and the pull request).`,
      data: { upToDate: true },
    };
  }
  const command = applyCommand(`provision${flag}`, hashes, { yes: true });
  const texts = [
    ...hostingHashes.map((hash) => planText(messages, "Hosting plan", hash) ?? ""),
    ...(dns === undefined ? [] : [describePlan(dns, plan, { costUnchanged: true })]),
  ];
  return {
    text: [
      ...texts.flatMap((text) => [text, ""]),
      `Nothing on the user's hosting account or in DNS was changed. Show ${hashes.length === 1 ? "this plan" : "these plans"} to the user. ${hostingTerminal(flag)} In a script: \`npx ${command}\` (--yes stores the release signing key and the agent's deploy key on GitHub and opens the pull request; it never approves a plan, which only its hash does). When the run stops at hosting plan B, it prints its hash for the next run.`,
    ].join("\n"),
    data: {
      ...(hostingHashes.length > 0 ? { hostingPlanHashes: [...hostingHashes] } : {}),
      ...(dns !== undefined ? planData(dns) : {}),
      applyCommand: command,
    },
  };
}

/**
 * The dialogs of `opscrew_apply`, which show a Cloudflare plan (`cloudflare-apply`) only when its
 * hash is the `cloudflarePlanHash` opscrew_plan returned: any other Cloudflare plan (it changed
 * since, or the hash was not passed) is refused before a dialog, so the user never approves a
 * Cloudflare plan the chat did not show. A plan of the app's bucket (a saved plan of the `storage`
 * root) is shown likewise only when its hash is the `storagePlanHash` given, a plan of the
 * off-server copies' bucket (the `backups` root) only when its hash is the `backupsPlanHash`
 * given, and a GitHub Pages site's Pages plan (`pages-apply`) only when its hash is the
 * `pagesPlanHash` given.
 */
class CloudflarePlanGate implements ApprovalHandler {
  /** True once a Cloudflare plan with another hash was refused. */
  refusedOther = false;
  /** True once a bucket plan with another hash was refused. */
  refusedBucket = false;
  /** True once a plan of the off-server copies' bucket with another hash was refused. */
  refusedBackups = false;
  /** True once a Pages plan with another hash was refused. */
  refusedPages = false;

  constructor(
    private readonly dialogs: ElicitationApprovalHandler,
    private readonly hash: string | undefined,
    private readonly storage: {
      hash: string | undefined;
      /** The `backups` root's plan hash given (`backupsPlanHash`). */
      backups: string | undefined;
      plansDir: string;
    },
    private readonly pagesHash: string | undefined,
    private readonly clock: Clock,
  ) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const planHash = request.planHash?.toLowerCase();
    if (request.kind === "pages-apply" && (planHash === undefined || planHash !== this.pagesHash)) {
      this.refusedPages = true;
      return approvalDecision(this.clock, "opscrew_apply", false, {
        reason:
          this.pagesHash === undefined
            ? "opscrew_apply was not given this Pages plan's pagesPlanHash"
            : `its hash is not the pagesPlanHash ${this.pagesHash}; the Pages plan changed since opscrew_plan returned it`,
      });
    }
    // A bucket root's saved plan, by its file's ending, is shown only under the hash given for it.
    const saved =
      request.kind === "iac-apply" && planHash !== undefined
        ? await findSavedPlan(this.storage.plansDir, planHash)
        : undefined;
    if (saved !== undefined) {
      if (saved.planFile.endsWith(STORAGE_PLAN_SUFFIX) && planHash !== this.storage.hash) {
        this.refusedBucket = true;
        return approvalDecision(this.clock, "opscrew_apply", false, {
          reason:
            this.storage.hash === undefined
              ? "opscrew_apply was not given this bucket plan's storagePlanHash"
              : `its hash is not the storagePlanHash ${this.storage.hash}; the bucket plan changed since opscrew_plan returned it`,
        });
      }
      if (saved.planFile.endsWith(BACKUPS_PLAN_SUFFIX) && planHash !== this.storage.backups) {
        this.refusedBackups = true;
        return approvalDecision(this.clock, "opscrew_apply", false, {
          reason:
            this.storage.backups === undefined
              ? "opscrew_apply was not given this plan's backupsPlanHash"
              : `its hash is not the backupsPlanHash ${this.storage.backups}; the plan of the off-server copies' bucket changed since opscrew_plan returned it`,
        });
      }
    }
    if (
      request.kind !== "cloudflare-apply" ||
      (this.hash !== undefined && request.planHash?.toLowerCase() === this.hash)
    ) {
      return this.dialogs.request(request);
    }
    this.refusedOther = true;
    return approvalDecision(this.clock, "opscrew_apply", false, {
      reason:
        this.hash === undefined
          ? "opscrew_apply was not given this Cloudflare plan's cloudflarePlanHash"
          : `its hash is not the cloudflarePlanHash ${this.hash}; the Cloudflare plan changed since opscrew_plan returned it`,
    });
  }
}

/**
 * Where the deployment files are after `opscrew_apply`: a pull request, a branch (pushed or still
 * to push), or unchanged, with `result.base`, the branch the deploy pull request goes into.
 */
function publishedLines(result: ProvisionResult): string[] {
  const { base } = result;
  if (result.published === false) {
    if (result.prUrl) {
      return [
        `The deployment files did not change, so nothing was committed. The pull request from earlier is still open: ${result.prUrl}`,
      ];
    }
    return [
      "The deployment files did not change, so nothing was committed and no pull request was opened.",
      ...(result.branch !== undefined && result.branch !== base
        ? [
            `They are already on ${base} on GitHub, but this clone is still on ${result.branch}: switch to ${base} and pull (\`git switch ${base} && git pull\`).`,
          ]
        : []),
    ];
  }
  if (result.prUrl) return [`Pull request with the deployment files: ${result.prUrl}`];
  if (result.pushed === false && result.branch) {
    return [
      `The deployment files are committed on branch ${result.branch}, which still needs pushing: push it (\`git push -u origin ${result.branch}\`) and open a pull request into ${base}.`,
    ];
  }
  return result.branch ? [`Deployment files committed on branch ${result.branch}.`] : [];
}

/** The next step after `opscrew_apply`; `secrets` says whether this call stored the deploy secrets. */
function nextLine(result: ProvisionResult, secrets: boolean): string {
  if (result.published === false && !result.prUrl) {
    return secrets
      ? "Next: call opscrew_verify to check the live site."
      : "Then call opscrew_verify to check the live site.";
  }
  if (result.pushed === false && !result.prUrl) {
    return secrets
      ? "Next: once the branch is pushed, merge its pull request to deploy, then call opscrew_verify."
      : "Then, once the branch is pushed, merge its pull request to deploy and call opscrew_verify.";
  }
  return secrets
    ? "Next: merge the pull request to deploy, then call opscrew_verify."
    : "Then merge the pull request to deploy and call opscrew_verify.";
}

function outputsLines(result: ProvisionResult, own: boolean): string[] {
  // A server the user owns or their Portainer: no address leaves OpsCrew's local state.
  if (own) return [];
  const lines: string[] = [];
  for (const [key, label] of [
    ["server_ipv4", "Server IPv4"],
    ["server_ipv6", "Server IPv6"],
    ["url", "URL"],
  ] as const) {
    const value = stringOutput(result.outputs, key);
    if (value !== undefined) lines.push(`${label}: ${value}`);
  }
  return lines;
}

/**
 * The deploy tools: `opscrew_render` (read-only preview of the generated files), `opscrew_plan`
 * (writes the files, plans, saves the plan and returns its hash; never applies), `opscrew_apply`
 * (applies exactly a saved plan after the user approves it in an MCP elicitation dialog; refuses
 * with the `opscrew provision --approve <hash>` command when the client cannot elicit, and names
 * plain `opscrew provision` after the user declines), `opscrew_secure` and `opscrew_verify`.
 * `options` is for tests only.
 */
export function registerDeployTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: DeployToolOptions = {},
): void {
  server.registerTool(
    "opscrew_render",
    {
      title: "Preview the deployment files",
      description:
        "Preview the files OpsCrew generates from opscrew/plan.yaml, each new, changed or unchanged; writes nothing in the repository (it may create the deploy key in the OpsCrew home). Next: opscrew_plan.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_render", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const preview = await previewDeploymentFiles(phase, servicesOption(options));
        const kindOf = new Map(preview.files.map((f) => [f.path, f.kind]));
        const line = (status: string) => (path: string) =>
          `  ${status.padEnd(9)} ${path} (${kindOf.get(path) ?? "file"})`;
        const toWrite = preview.created.length + preview.changed.length;
        const text = [
          `Deployment files for ${preview.plan.app.name} (${preview.files.length} files):`,
          ...preview.created.map(line("new")),
          ...preview.changed.map(line("changed")),
          ...preview.unchanged.map(line("unchanged")),
          "",
          toWrite === 0
            ? "The repository already has these files. Next: call opscrew_plan to plan the infrastructure."
            : `${toWrite} file${toWrite === 1 ? "" : "s"} would be written. Nothing was written. Next: call opscrew_plan; it writes the files and plans the infrastructure without creating anything.`,
        ].join("\n");
        return {
          text,
          data: {
            files: preview.files,
            created: preview.created,
            changed: preview.changed,
            unchanged: preview.unchanged,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_plan",
    {
      title: "Plan the infrastructure",
      description: `Write the generated files and make each plan the deployment needs, with its hash, changes, monthly cost and policy results. Never applies: show the plans to the user, then call opscrew_apply with the hashes. Needs the provider's credentials (${CLOUD_CREDENTIALS}; PORTAINER_API_KEY for Portainer) and GitHub access in the server's environment.`,
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        engine: z
          .enum(["auto", "tofu", "terraform"])
          .optional()
          .describe("IaC engine; default the plan's choice."),
        passwordLogins: PASSWORD_LOGINS_INPUT.describe(
          "Own server, when OpsCrew asked: the user's choice.",
        ),
        publicImage: PUBLIC_IMAGE_INPUT,
        replaceTokens: REPLACE_TOKENS_INPUT,
        pagesVerification: PAGES_VERIFICATION_INPUT,
        ...skipOtherAppsCheckInput,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({
      projectDir,
      app,
      environment,
      engine,
      passwordLogins,
      publicImage,
      replaceTokens,
      pagesVerification,
      skipOtherAppsCheck,
    }) =>
      runTool(deps, "opscrew_plan", projectDir, async (call) => {
        const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({
          approvalHandler: new PlanToolApprovalHandler(deps.clock),
          app: appKey,
          environment: name,
        });
        const result = await (options.runProvision ?? runProvision)(phase, {
          planOnly: true,
          ...(engine !== undefined ? { engine } : {}),
          ...(passwordLogins === undefined ? {} : { passwordLogins }),
          ...portainerImageOptions(publicImage, replaceTokens),
          ...(pagesVerification === undefined ? {} : { pagesVerification }),
          ...(skipOtherAppsCheck === true ? { skipOtherAppsCheck: true } : {}),
          ...servicesOption(options),
        });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        // A saved plan that changes nothing can be approved too, but is not offered.
        const found =
          result.planHash === undefined
            ? undefined
            : await findSavedPlan(phase.paths.files.plansDir, result.planHash);
        const saved = found !== undefined && !changesNothing(found) ? found : undefined;
        if (plan.target.provider === "hosting") {
          return hostingPlanReply(
            call.reporter.messages,
            { hostingHashes: result.hostingPlanHashes ?? [], dns: saved, plan },
            flag,
          );
        }
        const own = plan.target.provider === "own";
        const portainer = plan.target.provider === "portainer";
        const local = plan.target.provider === "localhost";
        const cost = own || portainer ? undefined : plan.cost;
        const hostChanges = async (hash: string) =>
          (await readSavedPlanChanges(phase.paths, "host", hash, PLAN_AGAIN)) === true;
        // A server the user owns: the host plan, approved on its own by its hash.
        const hostHash =
          result.hostPlanHash !== undefined && (await hostChanges(result.hostPlanHash))
            ? result.hostPlanHash
            : undefined;
        const hostText =
          hostHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Host plan for your server", hostHash);
        // The runner machines: the environment's runner off each machine it left, then on its own,
        // each host plan approved on its own by its hash.
        const runnerHashes: string[] = [];
        for (const hash of result.runnerHostPlanHashes ?? []) {
          if (await hostChanges(hash)) runnerHashes.push(hash);
        }
        // This computer: the local plan, approved on its own by its hash.
        const localHash =
          result.localPlanHash !== undefined &&
          (await savedLocalPlanChanges(phase.paths, result.localPlanHash, PLAN_AGAIN))
            ? result.localPlanHash
            : undefined;
        // The user's Portainer: the stack plan, approved on its own by its hash.
        const stackHash =
          result.stackPlanHash !== undefined &&
          (await readSavedPlanChanges(phase.paths, "stack", result.stackPlanHash, PLAN_AGAIN)) ===
            true
            ? result.stackPlanHash
            : undefined;
        const stackText =
          stackHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Stack plan for your Portainer");
        // The app's bucket: the `storage` root's own plan, approved on its own by its hash.
        const storageHash = result.storagePlanHash;
        const storage =
          storageHash === undefined
            ? undefined
            : await findSavedPlan(phase.paths.files.plansDir, storageHash);
        if (storageHash !== undefined && storage === undefined) {
          throw noSavedPlan("bucket plan", storageHash);
        }
        // The off-server copies' bucket: the `backups` root's own plan, likewise.
        const backupsHash = result.backupsPlanHash;
        const backups =
          backupsHash === undefined
            ? undefined
            : await findSavedPlan(phase.paths.files.plansDir, backupsHash);
        if (backupsHash !== undefined && backups === undefined) {
          throw noSavedPlan("plan of the off-server copies' bucket", backupsHash);
        }
        const stackFollows = portainer
          ? stackFollowsReason(result, saved !== undefined)
          : undefined;
        const second = hostHash ?? stackHash;
        // OpsCrew's shared Cloudflare resources: their plan comes first, approved on its own.
        const cloudflareHash = result.cloudflarePlanHash;
        const cloudflareText =
          cloudflareHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Cloudflare plan for", cloudflareHash);
        // GitHub Pages: the site's settings (the Pages plan) and GitHub's verification record (an
        // infrastructure plan of its own root), each approved on its own.
        const pagesHash = result.pagesPlanHash;
        const pagesText =
          pagesHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Pages plan for the GitHub Pages site", pagesHash);
        const verificationHash = result.pagesVerificationPlanHash;
        const verification =
          verificationHash === undefined
            ? undefined
            : await findSavedPlan(phase.paths.files.plansDir, verificationHash);
        if (verificationHash !== undefined && verification === undefined) {
          throw noSavedPlan("plan of GitHub's verification record", verificationHash);
        }
        const primary = saved?.planHash ?? second ?? localHash;
        const hashes = [
          ...(cloudflareHash !== undefined ? [cloudflareHash] : []),
          ...(storageHash !== undefined ? [storageHash] : []),
          ...(backupsHash !== undefined ? [backupsHash] : []),
          ...(pagesHash !== undefined ? [pagesHash] : []),
          ...(saved !== undefined ? [saved.planHash] : []),
          ...(verificationHash !== undefined ? [verificationHash] : []),
          ...(second !== undefined ? [second] : []),
          ...runnerHashes,
          ...(localHash !== undefined ? [localHash] : []),
        ];
        // The terminal run repeats this call's engine, password-logins and image choices, and the
        // skipped look for other apps on the server.
        const command = `${applyCommand(`provision${flag}`, hashes, {
          ...(engine === "tofu" || engine === "terraform" ? { engine } : {}),
          ...(passwordLogins === undefined ? {} : { passwordLogins }),
          ...(publicImage === undefined ? {} : { publicImage }),
          ...(replaceTokens === undefined ? {} : { replaceTokens }),
        })}${skipOtherAppsFlag(skipOtherAppsCheck)}`;
        if (hashes.length === 0) {
          const matched = own
            ? "Cloudflare and the user's server already match the plans"
            : portainer
              ? "Cloudflare and the user's Portainer already match the plans"
              : local
                ? "The app on the user's computer already matches the local plan"
                : "The infrastructure already matches the plan";
          return {
            text: `${matched}; there is nothing to apply. Next: call opscrew_secure and opscrew_verify, or run \`opscrew provision${flag}\` in a terminal to finish any remaining steps.`,
            data: {
              upToDate: true,
              ...(result.planHash ? { planHash: result.planHash } : {}),
              ...(result.stackPlanHash ? { stackPlanHash: result.stackPlanHash } : {}),
              cost,
            },
          };
        }
        const secondArg = hostHash !== undefined ? "hostPlanHash" : "stackPlanHash";
        const extras = [
          ...(passwordLogins === undefined ? [] : [`passwordLogins "${passwordLogins}"`]),
          ...(publicImage === undefined ? [] : [`publicImage ${publicImage}`]),
          ...(replaceTokens === undefined || replaceTokens.length === 0
            ? []
            : [`replaceTokens ${JSON.stringify(replaceTokens)}`]),
        ];
        const applyArgs = [
          ...(primary !== undefined ? [`planHash ${primary}`] : []),
          ...(saved !== undefined && second !== undefined ? [`${secondArg} ${second}`] : []),
          ...(cloudflareHash !== undefined ? [`cloudflarePlanHash ${cloudflareHash}`] : []),
          ...(storageHash !== undefined ? [`storagePlanHash ${storageHash}`] : []),
          ...(backupsHash !== undefined ? [`backupsPlanHash ${backupsHash}`] : []),
          ...(pagesHash !== undefined ? [`pagesPlanHash ${pagesHash}`] : []),
          ...(verificationHash !== undefined
            ? [`pagesVerificationPlanHash ${verificationHash}`]
            : []),
          ...(runnerHashes.length > 0
            ? [`runnerHostPlanHashes ${JSON.stringify(runnerHashes)}`]
            : []),
          ...extras,
        ].join(" and ");
        const several = hashes.length > 1;
        const shown =
          ["this plan", "both plans", "all three plans", "all four plans"][hashes.length - 1] ??
          `all ${hashes.length} plans`;
        const runnerTexts = runnerHashes.flatMap((hash) => [
          "",
          planText(call.reporter.messages, "Host plan for the runner machine", hash) ?? "",
        ]);
        const localText =
          localHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Local plan for", localHash);
        const text = [
          ...(cloudflareText !== undefined ? [cloudflareText, ""] : []),
          ...(storage !== undefined ? [bucketPlanText(storage, plan, "storage"), ""] : []),
          ...(backups !== undefined ? [bucketPlanText(backups, plan, "backups"), ""] : []),
          // A server the user owns or their Portainer costs nothing more: no price in the plan.
          ...(pagesText !== undefined ? [pagesText, ""] : []),
          ...(saved !== undefined
            ? [describePlan(saved, plan, own || portainer ? { costUnchanged: true } : {})]
            : []),
          ...(verification !== undefined
            ? ["", describePlan(verification, plan, { costUnchanged: true })]
            : []),
          ...(hostText !== undefined ? ["", hostText] : []),
          ...(stackText !== undefined ? ["", stackText] : []),
          ...runnerTexts,
          ...(localText !== undefined ? ["", localText] : []),
          "",
          `Nothing was created${own ? " and nothing on the user's server was changed" : portainer ? " and nothing in the user's Portainer was changed" : local ? " and nothing on the user's computer was changed" : ""}. Show ${shown} to the user. To apply exactly ${several ? "these plans" : "this plan"}, call opscrew_apply with ${applyArgs}: OpsCrew then asks the user to approve each in a dialog. Without that dialog, the user can run this in a terminal:`,
          `  ${command}`,
          ...(primary === undefined && cloudflareHash !== undefined
            ? [
                "When the infrastructure needs a change once this Cloudflare plan is applied (for example the one-time PIN login it adds), opscrew_apply shows that plan to the user in its own dialog. When this Cloudflare plan removes the app from a zone it left, the new zone's Cloudflare plan needs another opscrew_plan after this apply.",
              ]
            : []),
          ...(stackFollows !== undefined
            ? [
                `The stack plan for the user's Portainer follows once ${stackFollows}: opscrew_apply then shows it to the user in its own dialog. In a terminal script that takes three runs: \`opscrew provision${flag} --plan-only\`, the command above, then \`opscrew provision${flag} --approve <stack plan hash>\`.`,
              ]
            : []),
          ...(saved?.hasDestroy || result.cloudflarePlanDeletes
            ? [
                `This plan deletes or replaces resources; the user must type "${plan.app.name}" to approve it.`,
              ]
            : []),
        ].join("\n");
        return {
          text,
          data: {
            ...(saved !== undefined ? planData(saved) : {}),
            hostPlanHash: hostHash,
            stackPlanHash: stackHash,
            cloudflarePlanHash: cloudflareHash,
            storagePlanHash: storageHash,
            ...(backupsHash !== undefined ? { backupsPlanHash: backupsHash } : {}),
            ...(pagesHash !== undefined ? { pagesPlanHash: pagesHash } : {}),
            ...(verificationHash !== undefined
              ? { pagesVerificationPlanHash: verificationHash }
              : {}),
            ...(runnerHashes.length > 0 ? { runnerHostPlanHashes: runnerHashes } : {}),
            ...(localHash !== undefined ? { localPlanHash: localHash } : {}),
            ...(stackFollows !== undefined ? { stackPlanFollows: true } : {}),
            cost,
            applyCommand: command,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_apply",
    {
      title: "Apply an approved plan",
      description:
        "Apply exactly the plans opscrew_plan returned (every hash, same names, same choices), each after the USER approves it in a dialog, then open the deploy pull request. Deploy secrets need OPSCREW_APP_ENV_FILE, else the user finishes with `npx opscrew provision`, as for a hosting account.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        planHash: z.string().optional().describe("The plan's hash from opscrew_plan."),
        cloudflarePlanHash: z.string().optional().describe("The Cloudflare plan's hash."),
        hostPlanHash: z.string().optional().describe("Own server: the host plan's hash."),
        stackPlanHash: z.string().optional().describe("Portainer: the stack plan's hash."),
        storagePlanHash: z.string().optional().describe("The bucket plan's hash."),
        backupsPlanHash: z.string().optional().describe("The snapshot copies' bucket plan hash."),
        runnerHostPlanHashes: z
          .array(z.string())
          .optional()
          .describe("Each runner machine's host plan hash."),
        pagesPlanHash: z.string().optional().describe("GitHub Pages: the Pages plan's hash."),
        pagesVerificationPlanHash: z
          .string()
          .optional()
          .describe("GitHub Pages: the verification plan's hash."),
        passwordLogins: PASSWORD_LOGINS_INPUT.describe("The same choice given to opscrew_plan."),
        publicImage: PUBLIC_IMAGE_INPUT,
        replaceTokens: REPLACE_TOKENS_INPUT,
        pagesVerification: PAGES_VERIFICATION_INPUT,
        keyOut: z
          .string()
          .optional()
          .describe(
            "First recovery copy: the new age key's path outside the repo, chosen by the user.",
          ),
        ...skipOtherAppsCheckInput,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    (
      {
        projectDir,
        app,
        environment,
        planHash,
        cloudflarePlanHash,
        hostPlanHash,
        stackPlanHash,
        storagePlanHash,
        backupsPlanHash,
        runnerHostPlanHashes,
        pagesPlanHash,
        pagesVerificationPlanHash,
        passwordLogins,
        publicImage,
        replaceTokens,
        pagesVerification,
        keyOut,
        skipOtherAppsCheck,
      },
      extra: CallExtra,
    ) =>
      runTool(deps, "opscrew_apply", projectDir, async (call) => {
        const runnerHashes = (runnerHostPlanHashes ?? []).map((value) => value.toLowerCase());
        const given = [
          planHash,
          cloudflarePlanHash,
          hostPlanHash,
          stackPlanHash,
          storagePlanHash,
          backupsPlanHash,
          pagesPlanHash,
          pagesVerificationPlanHash,
        ];
        if (
          (planHash === undefined &&
            cloudflarePlanHash === undefined &&
            storagePlanHash === undefined &&
            backupsPlanHash === undefined &&
            pagesPlanHash === undefined &&
            pagesVerificationPlanHash === undefined &&
            runnerHashes.length === 0) ||
          [...given, ...runnerHashes].some((value) => value !== undefined && !isPlanHash(value))
        ) {
          throw new OpsCrewError(
            "INVALID_INPUT",
            "planHash, cloudflarePlanHash, storagePlanHash, pagesPlanHash, pagesVerificationPlanHash or runnerHostPlanHashes (and hostPlanHash or stackPlanHash) must be the 64-character SHA-256 hashes returned by opscrew_plan.",
            { hint: "Call opscrew_plan, show the plan to the user and pass its planHash." },
          );
        }
        const hash = planHash?.toLowerCase();
        const cloudflareHash = cloudflarePlanHash?.toLowerCase();
        const hostHash = hostPlanHash?.toLowerCase();
        const stackHash = stackPlanHash?.toLowerCase();
        const storageHash = storagePlanHash?.toLowerCase();
        const backupsHash = backupsPlanHash?.toLowerCase();
        const pagesHash = pagesPlanHash?.toLowerCase();
        const verificationHash = pagesVerificationPlanHash?.toLowerCase();
        const hashes = [
          ...[
            cloudflareHash,
            storageHash,
            backupsHash,
            pagesHash,
            hash,
            verificationHash,
            hostHash,
            stackHash,
          ].filter((value): value is string => value !== undefined),
          ...runnerHashes,
        ];
        const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
        const paths = resolveProjectPaths(call.projectDir, {
          env: deps.env,
          app: appKey,
          environment: name,
        });
        // A hosting account is set up in the terminal, before any dialog.
        const target = await readArtifact("plan", paths.files.plan).catch(() => undefined);
        if (target?.target.provider === "hosting") throw hostingInTerminal(flag);
        const terminal = `${applyCommand(`provision${flag}`, hashes, {
          ...(passwordLogins === undefined ? {} : { passwordLogins }),
          ...(publicImage === undefined ? {} : { publicImage }),
          ...(replaceTokens === undefined ? {} : { replaceTokens }),
        })}${skipOtherAppsFlag(skipOtherAppsCheck)}`;
        requireDialogs(server, terminal);
        const handler = dialogHandler(server, deps, extra);
        const gate = new CloudflarePlanGate(
          handler,
          cloudflareHash,
          {
            hash: storageHash,
            backups: backupsHash,
            plansDir: paths.files.plansDir,
          },
          pagesHash,
          deps.clock,
        );
        const phase = await call.phaseDeps({
          approvalHandler: gate,
          app: appKey,
          environment: name,
        });
        const saved =
          hash === undefined ? undefined : await findSavedPlan(phase.paths.files.plansDir, hash);
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const own = plan.target.provider === "own";
        const portainer = plan.target.provider === "portainer";
        const local = plan.target.provider === "localhost";
        const savedChanges = (kind: "host" | "stack", planHash: string) =>
          readSavedPlanChanges(phase.paths, kind, planHash, PLAN_AGAIN);
        // A server (the user's own, or the server runner's on one OpsCrew created) whose
        // infrastructure needs no change: the hash names the host plan.
        const onServer = onOneServer(plan.target.provider);
        const hostOnly =
          hash !== undefined &&
          saved === undefined &&
          onServer &&
          (await savedChanges("host", hash)) !== undefined;
        // The user's Portainer whose Cloudflare setup needs no change: the hash names the stack plan.
        const stackOnly =
          hash !== undefined &&
          saved === undefined &&
          portainer &&
          (await savedChanges("stack", hash)) !== undefined;
        // The user's computer: the hash names the local plan.
        const localOnly =
          hash !== undefined &&
          local &&
          (await readSavedLocalPlan(phase.paths, hash, PLAN_AGAIN)) !== undefined;
        if (hash !== undefined && saved === undefined && !hostOnly && !stackOnly && !localOnly) {
          throw noSavedPlan("plan", hash);
        }
        for (const runnerHash of runnerHashes) {
          if ((await savedChanges("host", runnerHash)) === undefined) {
            throw noSavedPlan("host plan of a runner machine", runnerHash);
          }
        }
        if (
          hostHash !== undefined &&
          (!onServer || (await savedChanges("host", hostHash)) === undefined)
        ) {
          throw noSavedPlan("host plan", hostHash);
        }
        if (
          stackHash !== undefined &&
          (!portainer || (await savedChanges("stack", stackHash)) === undefined)
        ) {
          throw noSavedPlan("stack plan", stackHash);
        }
        if (
          storageHash !== undefined &&
          (await findSavedPlan(phase.paths.files.plansDir, storageHash)) === undefined
        ) {
          throw noSavedPlan("bucket plan", storageHash);
        }
        if (
          backupsHash !== undefined &&
          (await findSavedPlan(phase.paths.files.plansDir, backupsHash)) === undefined
        ) {
          throw noSavedPlan("plan of the off-server copies' bucket", backupsHash);
        }
        if (
          verificationHash !== undefined &&
          (await findSavedPlan(phase.paths.files.plansDir, verificationHash)) === undefined
        ) {
          throw noSavedPlan("plan of GitHub's verification record", verificationHash);
        }
        const secrets = (phase.env.OPSCREW_APP_ENV_FILE ?? "").trim() !== "";
        let result: ProvisionResult;
        try {
          // The hashes only pick the saved plans: every approval still comes from the user's dialog.
          result = await (options.runProvision ?? runProvision)(phase, {
            approveHashes: [
              ...new Set([
                ...(hash === undefined ? [] : [hash]),
                ...(hostHash === undefined ? [] : [hostHash]),
                ...(stackHash === undefined ? [] : [stackHash]),
                ...(storageHash === undefined ? [] : [storageHash]),
                ...(backupsHash === undefined ? [] : [backupsHash]),
                ...(cloudflareHash === undefined ? [] : [cloudflareHash]),
                ...(pagesHash === undefined ? [] : [pagesHash]),
                ...(verificationHash === undefined ? [] : [verificationHash]),
                ...runnerHashes,
              ]),
            ],
            ...(saved === undefined ? {} : { engine: saved.engine.name }),
            ...(passwordLogins === undefined ? {} : { passwordLogins }),
            ...portainerImageOptions(publicImage, replaceTokens),
            ...(pagesVerification === undefined ? {} : { pagesVerification }),
            ...(keyOut !== undefined ? { recovery: { keyOut: async () => keyOut } } : {}),
            ...(skipOtherAppsCheck === true ? { skipOtherAppsCheck: true } : {}),
            secrets,
            ...servicesOption(options),
          });
        } catch (error) {
          throw refusalWithNextStep(error, handler, gate, flag);
        }
        // The user's computer without its local runner: no GitHub secrets, workflow or pull request.
        const localOnlyRun = local && result.published === undefined;
        const secretsNote =
          secrets || localOnlyRun
            ? []
            : [
                "",
                `The deploy secrets are NOT stored yet: OpsCrew never asks for production values through this chat. Ask the user to run \`opscrew provision${flag}\` in a terminal in the project directory. It finds no infrastructure changes, then asks for the production environment values and stores the GitHub Actions secrets.`,
              ];
        const text = [
          ...(result.cloudflarePlanHash !== undefined
            ? [appliedCloudflarePlan(result.cloudflarePlanHash)]
            : cloudflareHash !== undefined
              ? ["OpsCrew's shared Cloudflare resources needed no change."]
              : []),
          ...(result.pagesPlanHash !== undefined &&
          handler.decisions.some((d) => d.kind === "pages-apply" && d.approved)
            ? [`Applied the Pages plan ${result.pagesPlanHash} to the GitHub Pages site.`]
            : pagesHash !== undefined
              ? ["The GitHub Pages site needed no change."]
              : []),
          ...(result.storagePlanHash !== undefined
            ? [`Applied the plan of the app's bucket ${result.storagePlanHash}.`]
            : storageHash !== undefined
              ? ["The app's bucket needed no change."]
              : []),
          ...(result.backupsPlanHash !== undefined
            ? [`Applied the plan of the off-server copies' bucket ${result.backupsPlanHash}.`]
            : backupsHash !== undefined
              ? ["The off-server copies' bucket needed no change."]
              : []),
          local
            ? result.localApplied === true
              ? `Ran the app on the user's computer (local plan ${result.localPlanHash}).`
              : "The app on the user's computer needed no change."
            : saved !== undefined
              ? result.applied
                ? `Applied plan ${saved.planHash}.`
                : `Plan ${saved.planHash} had nothing left to apply; the infrastructure already matches it.`
              : result.applied
                ? `Applied the infrastructure plan ${result.planHash}.`
                : "The infrastructure needed no change.",
          ...(own
            ? [
                result.hostApplied === true
                  ? `Prepared the user's server (host plan ${result.hostPlanHash}).`
                  : "The user's server needed no change.",
                OWN_SERVER_BACKUPS_NOTE,
              ]
            : result.hostPlanHash !== undefined
              ? [
                  result.hostApplied === true
                    ? `Applied the server's host plan ${result.hostPlanHash} (its runner).`
                    : "The server's runner needed no change.",
                ]
              : []),
          ...(portainer
            ? [
                result.stackApplied === true
                  ? `Set up the app's stacks in the user's Portainer (stack plan ${result.stackPlanHash}).`
                  : "The user's Portainer needed no change.",
                portainerNotes(plan),
              ]
            : []),
          ...(result.runnerHostPlanHashes !== undefined
            ? [`The runner machines' host plans: ${result.runnerHostPlanHashes.join(", ")}.`]
            : []),
          ...outputsLines(result, own || portainer),
          ...publishedLines(result),
          ...secretsNote,
          "",
          localOnlyRun
            ? "Next: call opscrew_verify to check the app on the user's computer."
            : nextLine(result, secrets),
        ].join("\n");
        return {
          text,
          data: {
            planHash: hash,
            ...(result.cloudflarePlanHash !== undefined
              ? { cloudflarePlanHash: result.cloudflarePlanHash }
              : {}),
            ...(result.storagePlanHash !== undefined
              ? { storagePlanHash: result.storagePlanHash }
              : {}),
            ...(result.backupsPlanHash !== undefined
              ? { backupsPlanHash: result.backupsPlanHash }
              : {}),
            applied: result.applied,
            ...(result.hostPlanHash !== undefined
              ? { hostPlanHash: result.hostPlanHash, hostApplied: result.hostApplied === true }
              : {}),
            ...(result.stackPlanHash !== undefined
              ? { stackPlanHash: result.stackPlanHash, stackApplied: result.stackApplied === true }
              : {}),
            ...(result.localPlanHash !== undefined
              ? { localPlanHash: result.localPlanHash, localApplied: result.localApplied === true }
              : {}),
            ...(result.runnerHostPlanHashes !== undefined
              ? { runnerHostPlanHashes: result.runnerHostPlanHashes }
              : {}),
            outputs: own || portainer ? {} : result.outputs,
            secretsStored: secrets,
            approvals: handler.decisions,
            ...(result.prUrl ? { prUrl: result.prUrl } : {}),
            ...(result.branch ? { branch: result.branch } : {}),
            ...(secrets || localOnlyRun ? {} : { nextStep: `opscrew provision${flag}` }),
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_secure",
    {
      title: "Security check of the deployment",
      description:
        "Re-scan, re-check policies, check the server's hardening (in Portainer, the app's stack) and probe its ports from outside; deep adds Lynis, ssh-audit and testssl.sh. Writes opscrew/SECURITY_REPORT.md; changes nothing.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        offline: z.boolean().optional().describe("Skip the online dependency lookup."),
        deep: z
          .boolean()
          .optional()
          .describe("Also run Lynis, ssh-audit and testssl.sh; only when the user asks."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectDir, app, environment, offline, deep }) =>
      runTool(deps, "opscrew_secure", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const result = await runSecure(phase, {
          offline: offline ?? false,
          scanners: deps.scanners(),
          ...options.secure,
          ...(deep === true ? { deep: true } : {}),
        });
        const plan = await readArtifact("plan", phase.paths.files.plan).catch(() => undefined);
        const inPortainer = plan?.target.provider === "portainer";
        const lines = [
          result.summary.trimEnd(),
          ...(result.hostChecks.length > 0
            ? [
                "",
                inPortainer ? "Checks of the app's stack in Portainer:" : "Server checks:",
                ...checkLines(result.hostChecks),
              ]
            : []),
          ...(inPortainer && plan !== undefined ? ["", portainerNotes(plan)] : []),
          ...(result.probes.length > 0
            ? ["", "Outside probes:", ...checkLines(result.probes)]
            : []),
          ...(result.deep !== undefined ? deepLines(result.deep) : []),
          "",
          `Report: ${result.reportPath}`,
        ];
        return {
          text: lines.join("\n"),
          data: {
            passed: result.passed,
            summary: result.summary,
            problems: result.problems,
            hostChecks: result.hostChecks,
            probes: result.probes,
            ...(result.deep !== undefined ? { deep: result.deep } : {}),
            policies: result.policies,
            scan: { counts: result.scan.counts, findings: result.scan.findings.length },
            reportPath: result.reportPath,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_verify",
    {
      title: "Verify the live deployment",
      description:
        "Check the live deployment from outside (DNS, HTTPS, redirect, health, headers, no .env or .git served, origin hidden, last deploy run) and write opscrew/RUNBOOK.md. Run it after the deploy pull request is merged.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        url: z
          .string()
          .optional()
          .describe("Portainer behind the user's own proxy only: the app's address there."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectDir, app, environment, url }) =>
      runTool(deps, "opscrew_verify", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const route = url?.trim();
        const result = await runVerify(phase, {
          ...options.verify,
          ...(route === undefined || route === "" ? {} : { url: route }),
        });
        // Portainer's address is never shown, not even inside the route the user gave.
        const checked = phase.redactor.redact(result.url);
        const checks = phase.redactor.redactDeep(result.checks);
        const summary = summarizeChecks(checks);
        const text = [
          result.passed
            ? `${checked} is live and healthy (${summary}).`
            : `Verification of ${checked} found problems (${summary}). Fix them and call opscrew_verify again.`,
          ...checkLines(checks),
          // A preview environment has no runbook.
          ...(result.runbookPath === undefined ? [] : ["", `Runbook: ${result.runbookPath}`]),
        ].join("\n");
        return {
          text,
          data: {
            passed: result.passed,
            url: checked,
            summary,
            checks,
            runbookPath: result.runbookPath,
          },
        };
      }),
  );
}

/**
 * Adds the next step to a refusal: a new opscrew_plan when a Cloudflare or bucket plan
 * opscrew_plan did not return was refused (`gate`); otherwise the user declined in a dialog, so
 * the step is opscrew_apply again or plain `opscrew provision` in a terminal (which shows each plan
 * and asks), never `--approve <hash>`, which would apply without asking.
 */
function refusalWithNextStep(
  error: unknown,
  handler: ElicitationApprovalHandler,
  gate: Pick<
    CloudflarePlanGate,
    "refusedOther" | "refusedBucket" | "refusedBackups" | "refusedPages"
  >,
  flag: string,
): unknown {
  if (!isUserFacingError(error) || error.code !== "APPROVAL_REFUSED") return error;
  if (gate.refusedPages) {
    return new OpsCrewError(
      "APPROVAL_REFUSED",
      "opscrew_plan did not return this Pages plan to the user, so OpsCrew did not show or apply it, and the GitHub Pages site was not changed.",
      {
        hint: "Call opscrew_plan again, show the user its Pages plan and pass its pagesPlanHash to opscrew_apply with the other hashes.",
        cause: error,
      },
    );
  }
  // Cloudflare is changed once its shared plan or the infrastructure plan was approved, and the
  // GitHub Pages site once its Pages plan was.
  const applyApproved = handler.decisions.some(
    (d) =>
      (d.kind === "iac-apply" || d.kind === "cloudflare-apply" || d.kind === "pages-apply") &&
      d.approved,
  );
  if (gate.refusedBucket) {
    return new OpsCrewError(
      "APPROVAL_REFUSED",
      "opscrew_plan did not return this plan of the app's bucket to the user, so OpsCrew did not show or apply it, and the bucket was not changed.",
      {
        hint: "Call opscrew_plan, show the user its bucket plan and pass its storagePlanHash to opscrew_apply with the other hashes.",
        cause: error,
      },
    );
  }
  if (gate.refusedBackups) {
    return new OpsCrewError(
      "APPROVAL_REFUSED",
      "opscrew_plan did not return this plan of the off-server copies' bucket to the user, so OpsCrew did not show or apply it, and the bucket was not changed.",
      {
        hint: "Call opscrew_plan, show the user that plan and pass its backupsPlanHash to opscrew_apply with the other hashes.",
        cause: error,
      },
    );
  }
  if (gate.refusedOther) {
    // The app moved zones: the removal from the zone it left is applied, the new zone's plan is not.
    const leftApplied = handler.decisions.some((d) => d.kind === "cloudflare-apply" && d.approved);
    return new OpsCrewError(
      "APPROVAL_REFUSED",
      leftApplied
        ? "The Cloudflare plan for the zone the app left is applied. The Cloudflare plan for its new zone was not returned by opscrew_plan, so nothing in the new zone was changed."
        : error.message,
      {
        hint: "Call opscrew_plan again, show the user its Cloudflare plan and pass its cloudflarePlanHash to opscrew_apply with the other hashes.",
        cause: error,
      },
    );
  }
  const hostRefused = handler.decisions.some((d) => d.kind === "host-apply" && !d.approved);
  const stackRefused = handler.decisions.some((d) => d.kind === "stack-apply" && !d.approved);
  if (stackRefused || hostRefused) {
    // The user's Portainer, own server, runner machine or computer: Cloudflare may already be
    // changed; the declined plan's target is not. A host plan's refusal names its machine.
    const declined = stackRefused
      ? applyApproved
        ? "The user declined the stack plan. The Cloudflare changes are applied; nothing in the user's Portainer was changed."
        : "The user declined the stack plan; nothing in the user's Portainer was changed."
      : `${error.message}${applyApproved ? " The Cloudflare changes are applied." : ""}`;
    return new OpsCrewError("APPROVAL_REFUSED", declined, {
      hint: `When the user is ready, call opscrew_plan again (it shows what is still missing) and opscrew_apply with its hashes, or ask them to run \`opscrew provision${flag}\` in a terminal in the project directory.`,
      cause: error,
    });
  }
  const next = applyApproved
    ? `Ask the user to run \`opscrew provision${flag}\` in a terminal in the project directory when ready; it continues where this stopped.`
    : `Nothing was applied. When the user is ready, call opscrew_apply again, or ask them to run \`opscrew provision${flag}\` in a terminal in the project directory: it shows each plan and asks.`;
  return new OpsCrewError("APPROVAL_REFUSED", error.message, { hint: next, cause: error });
}

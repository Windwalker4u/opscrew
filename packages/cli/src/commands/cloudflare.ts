import {
  abortMove,
  finishMove,
  type MoveResult,
  type MoveServices,
  prepareMove,
  switchMove,
} from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest, Clock } from "@opscrew/contracts";
import { approvalDecision, isPlanHash, isUserFacingError, OpsCrewError } from "@opscrew/core";
import { type Command, Option } from "commander";
import { hashListed, withAllowDowntime } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { CliExit, REFUSED_EXIT_CODE } from "../exit";
import { chooseApp } from "../ui/app";
import { collect, runPhaseCommand } from "../ui/deploy";
import { createEnvPrompt } from "../ui/env-prompt";
import { printNextSteps } from "../ui/output";
import type { UiPrompts } from "../ui/prompts";
import { createStorageKeyPrompt } from "../ui/storage-key-prompt";
import { engineOption } from "./provision";

/** Flags of `opscrew cloudflare move` (plan 1.). */
export interface CloudflareMoveFlags {
  /** `--to <account>`: B's id or exact name (prepare). */
  to?: string;
  switch?: boolean;
  finish?: boolean;
  abort?: boolean;
  /** `--app <key>`: the repository's app. */
  app?: string;
  /** `--env <name>`: refused, since the move covers every environment in the zone. */
  env?: string;
  approve?: string;
  /** Each `--confirm <name>`: the app's, a bucket's, the domain's or the zone's. */
  confirm?: string[];
  allowDowntime?: boolean;
  engine?: "tofu" | "terraform";
}

/** The step a run of the command takes. */
type Mode = "prepare" | "switch" | "finish" | "abort";

const COMMAND = "opscrew cloudflare move";

/** Plain-English usage problems of a flag combination; empty when the flags fit together. */
export function flagProblems(flags: CloudflareMoveFlags): string[] {
  const problems: string[] = [];
  if (flags.env !== undefined) {
    problems.push(
      "The move takes no --env: it moves every environment of the app whose domain is in the zone, and an environment in another zone stays as it is.",
    );
  }
  const modes = (["switch", "finish", "abort"] as const).filter((mode) => flags[mode] === true);
  if (modes.length > 1) {
    problems.push(`Use one of ${modes.map((mode) => `--${mode}`).join(", ")} at a time.`);
  }
  const mode = modes[0];
  if (flags.to !== undefined && mode !== undefined) {
    problems.push(`--to only applies when preparing the move, not with --${mode}.`);
  }
  if (flags.allowDowntime === true && mode !== "finish") {
    problems.push("--allow-downtime is only used with --finish (the bucket's maintenance window).");
  }
  const approve = flags.approve?.trim();
  if (approve !== undefined && !isPlanHash(approve)) {
    problems.push(
      `--approve expects the 64-character SHA-256 plan hash that an earlier \`${COMMAND}\` run printed.`,
    );
  }
  return problems;
}

/** What the move's approvals in a script know of the run. */
export interface MoveApprovalOptions {
  /** True when a person answers the prompts: then every request goes to the base handler. */
  interactive: boolean;
  /** `--approve <hash>`. */
  approve?: string;
  /** Every `--confirm <name>`. */
  names: readonly string[];
  /** Where approved requests are shown (`ctx.stdout`, which redacts). */
  print: (text: string) => void;
  clock: Clock;
}

/**
 * The approvals of `opscrew cloudflare move` in a script, on top of the normal `--approve <hash>`
 * handler (`base`); the finish's maintenance window is `withAllowDowntime`'s, around this one:
 * - a request with a typed name (`confirmPhrase`: the switch's zone, the abort's zone, a bucket's
 *   name when emptying it, the app's name for a deletion, the zone's for B's zone) is approved
 *   only when one `--confirm` is that name and, when it is bound to a plan, `--approve` is that
 *   plan's hash; otherwise it is refused with the flags to add;
 * - a `remote-exec` request with no typed name (the first copies, the last backups copy) is
 *   approved when `--approve` is its hash;
 * - everything else goes to `base`. In a terminal every request goes to `base`, which asks.
 */
export class MoveApprovalHandler implements ApprovalHandler {
  constructor(
    private readonly base: ApprovalHandler,
    private readonly options: MoveApprovalOptions,
  ) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const { interactive, approve, names, print, clock } = this.options;
    if (interactive) return this.base.request(request);
    const hashed = approve !== undefined && hashListed([approve], request.planHash);
    const phrase = request.confirmPhrase;
    if (phrase !== undefined) {
      const bound = request.planHash !== undefined;
      const flags = `--confirm ${phrase}${bound ? ` --approve ${request.planHash}` : ""}`;
      if (names.includes(phrase) && (!bound || hashed)) {
        print(`  ✓ ${request.title} (approved with ${flags})\n`);
        return approvalDecision(clock, "--approve and --confirm flags", true, {
          confirmation: phrase,
        });
      }
      return approvalDecision(clock, "--approve and --confirm flags", false, {
        reason: `this needs ${phrase} typed to confirm: add ${flags}, or run the command in a terminal`,
      });
    }
    if (request.kind === "remote-exec" && request.allowDestroy !== true && hashed) {
      print(`  ✓ ${request.title} (approved with --approve)\n`);
      return approvalDecision(clock, "--approve flag", true);
    }
    return this.base.request(request);
  }
}

/** Advice for an approval a script refused, unless the error already names the flag to add. */
function scriptHint(ctx: CliContext): (error: unknown) => string | undefined {
  return (error) => {
    if (ctx.isInteractive || !isUserFacingError(error) || error.code !== "APPROVAL_REFUSED") {
      return undefined;
    }
    if (`${error.message} ${error.hint ?? ""}`.includes("--confirm")) return undefined;
    return "This run is not interactive: each plan needs --approve <hash>, the finish's maintenance window --allow-downtime, and each typed name --confirm <name> (the app's, a bucket's, or the zone's) with --approve <hash>.";
  };
}

/**
 * The move's question for the new account's address updater token of a server at home, asked once
 * in a terminal when `OPSCREW_NEW_DNS_UPDATER_TOKEN` is not set: the recipe, then a hidden prompt.
 * The token is registered with the redactor; `undefined` when the user cancels or types nothing.
 */
export function createUpdaterTokenPrompt(
  ctx: Pick<CliContext, "redactor">,
  prompts: UiPrompts,
): NonNullable<MoveServices["askUpdaterToken"]> {
  return async ({ prompt }) => {
    const answer = await prompts.password({ message: prompt });
    if (prompts.isCancel(answer) || answer.trim() === "") return undefined;
    const token = answer.trim();
    ctx.redactor.addLiteral(token, "OPSCREW_NEW_DNS_UPDATER_TOKEN");
    return token;
  };
}

/** The yes/no question asked in a terminal after prepare's summary (printed by the move). */
function startQuestion(summary: { zone: string; to: { accountId: string; name?: string } }) {
  return `Start moving ${summary.zone} to the Cloudflare account ${summary.to.name ?? summary.to.accountId}?`;
}

async function runMove(
  ctx: CliContext,
  flags: CloudflareMoveFlags,
  mode: Mode,
  appKey: string | undefined,
  appFlag: string,
): Promise<MoveResult> {
  const approve = flags.approve?.trim() || undefined;
  const names = (flags.confirm ?? []).map((name) => name.trim());
  const prompts = promptsOf(ctx);
  const deps = createPhaseDeps(ctx, {
    ai: false,
    app: appKey,
    approveHashes: approve === undefined ? [] : [approve],
    wrapApprovals: (base, clock) =>
      withAllowDowntime(
        ctx,
        flags.allowDowntime,
        new MoveApprovalHandler(base, {
          interactive: ctx.isInteractive,
          ...(approve === undefined ? {} : { approve }),
          names,
          print: ctx.stdout,
          clock,
        }),
        clock,
      ),
  });
  const services: MoveServices = {
    ...(ctx.isInteractive
      ? {
          askEnv: createEnvPrompt(prompts, appFlag),
          askStorageKey: createStorageKeyPrompt(prompts, ctx.stdout),
          askUpdaterToken: createUpdaterTokenPrompt(ctx, prompts),
        }
      : {}),
    ...servicesOf(ctx).cloudflareMove,
  };
  const common = {
    ...(approve === undefined ? {} : { approvePlanHash: approve }),
    ...(flags.engine === undefined ? {} : { engine: flags.engine }),
    services,
  };
  switch (mode) {
    case "prepare":
      return prepareMove(deps, {
        ...common,
        ...(flags.to === undefined ? {} : { to: flags.to.trim() }),
        ...(ctx.isInteractive
          ? {
              confirmStart: async (summary) => {
                const answer = await prompts.confirm({
                  message: startQuestion(summary),
                  initialValue: false,
                });
                return !prompts.isCancel(answer) && answer === true;
              },
            }
          : {}),
      });
    case "switch":
      return switchMove(deps, common);
    case "finish":
      return finishMove(deps, {
        ...common,
        ...(flags.allowDowntime === true ? { allowDowntime: true } : {}),
      });
    case "abort":
      return abortMove(deps, common);
  }
}

/** The help's text on each step, after the options. */
const HELP = [
  "",
  "The steps, run in this order:",
  "  opscrew cloudflare move --to <account>   prepare: the zone in the new account (pending) with",
  "                                           the zone's other records, the app's pieces there, the",
  "                                           new account's connector beside the current one, its",
  "                                           credentials in GitHub, the first bucket copies and the",
  "                                           app's mark; the current account keeps serving. Run",
  "                                           again without --to to go on.",
  "  opscrew cloudflare move --switch         once every app in the zone is prepared, from any of",
  "                                           their repositories: the domain typed, the nameservers",
  "                                           set at the registrar (or what to do there), DNSSEC's",
  "                                           wait, the sites' custom domains and the certificates.",
  "  opscrew cloudflare move --finish         in each repository after the switch: the bucket's last",
  "                                           copy in a maintenance window, the new account's secrets",
  "                                           and a deploy, the connector, the states, then the",
  "                                           current account's pieces removed (the app's and each",
  "                                           bucket's name typed).",
  "  opscrew cloudflare move --abort          before the switch changed anything: the app's pieces",
  "                                           in the new account removed (each name typed); the",
  "                                           current account was never changed.",
  "",
  "CLOUDFLARE_API_TOKEN stays the current account's token; OPSCREW_NEW_CLOUDFLARE_API_TOKEN is the new one's.",
  "A server at home: the finish puts OPSCREW_NEW_DNS_UPDATER_TOKEN, the address updater's token in the",
  "new account, on your server (a terminal asks for it, hidden, when it isn't set).",
  "In scripts each step stops at its plan with the hash: run the printed command with",
  "--approve <hash>. A typed name is --confirm <name> (repeatable): the zone at the switch and the",
  "abort, each bucket's name when it is emptied, the app's name for a deletion, the zone's for the",
  "new account's zone. In a script the finish's maintenance window needs --allow-downtime; the step",
  "before it, its --approve <hash>, as the finish prints.",
  "`opscrew status` shows where the move stands.",
].join("\n");

/**
 * `opscrew cloudflare move`: moves the app (every environment of it in the zone) to another
 * Cloudflare account in four steps (prepare with `--to`, `--switch`, `--finish`, `--abort`), each
 * plan approved by its hash; scripts stop at each plan with the hash and the command to continue.
 * Exit codes: 0 done, 1 stopped on purpose (a plan to approve, a wait, a refusal), 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const cloudflare = program
    .command("cloudflare")
    .description("Cloudflare account tasks: move the app to another Cloudflare account");
  cloudflare
    .command("move")
    .description(
      "Move the app, with every environment of it in its zone, to another Cloudflare account, step by step",
    )
    .option(
      "--to <account>",
      "Prepare the move to this Cloudflare account (its id or exact name); without it a recorded move goes on",
    )
    .option("--switch", "Switch the zone to the new account, once every app in it is prepared")
    .option("--finish", "After the switch, finish the move of this repository's app")
    .option("--abort", "Before the switch, remove the app's pieces from the new account")
    .option(
      "--app <key>",
      "The repository's app to move: a key `opscrew app add` gave, or `.` for the first app (default: the only one; with several, a terminal asks and a script must name it)",
    )
    .addOption(new Option("--env <name>").hideHelp())
    .option(
      "--approve <hash>",
      "Apply exactly the saved plan with this hash (printed by the previous run) and continue",
    )
    .option(
      "--confirm <name>",
      "A name a step asks to be typed, for scripts: the zone, a bucket's or the app's; repeat for each",
      collect,
    )
    .option(
      "--allow-downtime",
      "In a non-interactive run, allow the finish's maintenance window for the app's bucket",
    )
    .addOption(engineOption())
    .addHelpText("after", HELP)
    .action(async (flags: CloudflareMoveFlags) => {
      let appFlag = "";
      const result = await runPhaseCommand(
        ctx,
        async () => {
          const problems = flagProblems(flags);
          if (problems.length > 0) {
            throw new OpsCrewError("INVALID_INPUT", problems.join(" "), {
              hint: `Run \`${COMMAND} --help\` to see how the flags fit together.`,
            });
          }
          const mode: Mode = flags.switch
            ? "switch"
            : flags.finish
              ? "finish"
              : flags.abort
                ? "abort"
                : "prepare";
          const app = await chooseApp(ctx, flags.app, "cloudflare move");
          appFlag = app.flag;
          return runMove(ctx, flags, mode, app.key, app.flag);
        },
        scriptHint(ctx),
      );
      if (result.pendingPlanHash !== undefined) {
        ctx.stdout(`\nPlan hash (SHA-256): ${result.pendingPlanHash}\n`);
      }
      const repeat = [
        ...(appFlag !== "" ? [appFlag.trim()] : []),
        ...(flags.engine === undefined ? [] : [`--engine ${flags.engine}`]),
      ];
      printNextSteps(ctx, [
        ...result.next,
        ...(!result.done && !ctx.isInteractive && repeat.length > 0
          ? [`Pass ${repeat.join(" ")} again with that command.`]
          : []),
      ]);
      if (!result.done) throw new CliExit(REFUSED_EXIT_CODE);
    });
}

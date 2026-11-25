/**
 * The uptime check in the user's Cloudflare account (feature 046, `observability.check.runner:
 * cloudflare`): the agents' side of the shared Worker `opscrew-uptime`. Each environment owns one
 * entry there, its state and one secret (the webhook's address); every change is a Cloudflare
 * uptime plan approved by its hash (`cloudflare-apply`), applied by the connector's adapter. This
 * computer records where the entry is (`.opscrew/uptime.json`), so a provision that leaves the
 * Worker, and a destroy, find it.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  applyUptime,
  type CloudflareClient,
  cloudflareConnector,
  describeUptimePlan,
  inspectUptime,
  planUptime,
  UPTIME_RESOURCES,
  UptimeApplyError,
  type UptimeDesired,
  type UptimeEntry,
  type UptimePlan,
  uptimeEntryKey,
  uptimeLabel,
  uptimeSecretName,
  uptimeStateKey,
} from "@opscrew/connector-cloudflare";
import type { PhaseName } from "@opscrew/contracts";
import {
  errorText,
  isUserFacingError,
  OpsCrewError,
  type ProjectPaths,
  plural,
  writeFileAtomic,
} from "@opscrew/core";
import {
  CHECK_SECRETS,
  checkEnvironmentKey,
  checkHosts,
  UPTIME_WORKER_SCRIPT,
  UPTIME_WORKER_SHA256,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { approveLaterHint } from "../provision/plan-apply";
import { sharedCloudflareClient } from "../provision/shared-cloudflare";
import type { ProvisionServices } from "../provision/types";
import { adapterBlocked, gitClient, githubCoordinates, PlanRefusedError } from "../shared";
import { readValidJson } from "../shared/files";
import { WEBHOOK_NAMES } from "./secrets";
import { repositoryCheckSettings, usesUptimeWorker } from "./settings";

/** What design and provision say when an environment chooses the Worker (spec, edge cases). */
export const UPTIME_ONLY_LINE =
  "The disk, snapshot, restore-drill and certificate-days checks need `runner: actions`.";

const { worker: WORKER, namespace: NAMESPACE } = UPTIME_RESOURCES;

/** The Worker's script as this OpsCrew version ships it. */
const SCRIPT = { content: UPTIME_WORKER_SCRIPT, sha256: UPTIME_WORKER_SHA256 };

/** `<owner>/<repo>/<app key or name>/<env>`: the environment's id in the Worker. */
export function uptimeId(plan: DeployPlan, repository: string): string {
  return `${repository}/${checkEnvironmentKey(plan)}`;
}

/**
 * The environment's entry: the hostnames and health path the Actions check would fetch
 * (`checkHosts`), the repository's webhook kind and the name of its secret. Never an address.
 */
export function uptimeEntry(
  plan: DeployPlan,
  repository: string,
  webhook: UptimeEntry["webhook"],
): UptimeEntry {
  const key = checkEnvironmentKey(plan);
  const at = key.lastIndexOf("/");
  return {
    version: 1,
    repository,
    app: key.slice(0, at),
    environment: key.slice(at + 1),
    hosts: checkHosts(plan),
    webhook,
    secret: uptimeSecretName(uptimeId(plan, repository)),
  };
}

// --- This computer's record -----------------------------------------------------------------

const UptimeRecordSchema = z.strictObject({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  id: z.string().min(1),
});

/** Where the environment's entry is: the Cloudflare account and the entry's id. */
export type UptimeRecord = z.infer<typeof UptimeRecordSchema>;

function recordFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "uptime.json");
}

/** This computer's record of the environment's entry in the Worker; none without one. */
export function readUptimeRecord(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<UptimeRecord | undefined> {
  return readValidJson(recordFile(paths), UptimeRecordSchema);
}

async function writeUptimeRecord(paths: Pick<ProjectPaths, "stateDir">, record: UptimeRecord) {
  await writeFileAtomic(recordFile(paths), `${JSON.stringify(record, null, 2)}\n`);
}

async function removeUptimeRecord(paths: Pick<ProjectPaths, "stateDir">) {
  await rm(recordFile(paths), { force: true });
}

/**
 * Where the environment's entry is, or goes: while the plan chooses the Worker, its id from
 * `repository` (else the record's) in the recorded account, else the account of the app's zone;
 * otherwise as this computer recorded it. `undefined` when it has none. Stops when the plan
 * chooses the Worker and neither the record nor `repository` names the entry: OpsCrew never
 * passes over an entry it can't find.
 */
async function uptimeTarget(
  paths: Pick<ProjectPaths, "stateDir">,
  plan: DeployPlan,
  input: { client: Pick<CloudflareClient, "findZone">; repository: string | undefined },
): Promise<UptimeRecord | undefined> {
  const record = await readUptimeRecord(paths);
  if (!usesUptimeWorker(plan)) return record;
  const id = input.repository === undefined ? record?.id : uptimeId(plan, input.repository);
  if (id === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew can't tell which entry of the Cloudflare uptime Worker ${WORKER} is this environment's: this computer has no record of it (.opscrew/uptime.json), and the repository has no GitHub remote named origin. Nothing was changed.`,
      {
        hint: "Run the command from the repository's clone that has its GitHub remote (origin), or from the computer that provisioned the app.",
      },
    );
  }
  return { accountId: record?.accountId ?? (await zoneAccount(input.client, plan)), id };
}

/** The account that holds the app's zone, where the Worker runs. */
async function zoneAccount(client: Pick<CloudflareClient, "findZone">, plan: DeployPlan) {
  const domain = plan.dns.domain;
  const zone = domain === undefined ? undefined : await client.findZone(domain);
  if (zone?.accountId !== undefined && zone.accountId !== "") return zone.accountId;
  throw new OpsCrewError(
    "CREDENTIALS_INVALID",
    `Cloudflare did not say which account holds the zone of ${domain ?? "the app's domain"}, where the uptime Worker ${WORKER} runs, so OpsCrew changed nothing there.`,
    {
      hint: "Give CLOUDFLARE_API_TOKEN access to the app's zone and its account, then run the command again.",
    },
  );
}

// --- The plan ---------------------------------------------------------------------------------

/** One environment's uptime plan, with what it was made from and its words. */
export interface UptimeStep {
  client: CloudflareClient;
  target: UptimeRecord;
  plan: UptimePlan;
  desired: UptimeDesired;
  details: string;
}

/**
 * The webhook's secret for the entry: `{ url, token? }` as JSON, with the address from
 * `OPSCREW_CHECK_WEBHOOK` or, in a terminal, asked with `ask` (never echoed) when the Worker has no
 * secret for the entry yet, and ntfy's token from `OPSCREW_CHECK_NTFY_TOKEN`. Every part is
 * registered with the redactor. `undefined` when no address was given: the stored one is kept.
 */
async function webhookSecret(
  deps: Pick<PhaseDeps, "env" | "interactive" | "reporter" | "redactor">,
  input: {
    kind: UptimeEntry["webhook"];
    name: string;
    stored: boolean;
    ask: ProvisionServices["askCheckWebhook"];
  },
): Promise<string | undefined> {
  const { kind, name, stored, ask } = input;
  let url = deps.env[CHECK_SECRETS.webhook]?.trim();
  if (!url && stored) {
    deps.reporter.info(
      `The uptime Worker already holds the webhook's address for this environment (its secret ${name}), so it is kept. If you changed the webhook to ${WEBHOOK_NAMES[kind]}, set ${CHECK_SECRETS.webhook} to its address and run \`opscrew provision\` again.`,
    );
  }
  if (!url && !stored && deps.interactive && ask !== undefined) {
    url = (
      await ask({
        kind,
        prompt: `Address of the ${WEBHOOK_NAMES[kind]} webhook for the uptime check (stored as a secret of the Cloudflare Worker ${WORKER})`,
      })
    )?.trim();
  }
  if (!url) return undefined;
  const token = kind === "ntfy" ? deps.env[CHECK_SECRETS.ntfyToken]?.trim() : undefined;
  deps.redactor.addLiteral(url, CHECK_SECRETS.webhook);
  if (token) deps.redactor.addLiteral(token, CHECK_SECRETS.ntfyToken);
  const value = JSON.stringify({ url, ...(token ? { token } : {}) });
  deps.redactor.addLiteral(value, name);
  return value;
}

/**
 * Inspects the Worker's account and plans the environment's change, read-only: its entry (`want`,
 * provision with the Worker chosen) with its secret when one is given or asked, or the entry's
 * removal (with `destroy`, the Worker's and the namespace's too when no other entry is left).
 */
async function uptimeStep(
  deps: Pick<PhaseDeps, "paths" | "env" | "interactive" | "reporter" | "redactor">,
  input: {
    client: CloudflareClient;
    target: UptimeRecord;
    want?: { plan: DeployPlan; repository: string; ask: ProvisionServices["askCheckWebhook"] };
    destroy?: boolean;
  },
): Promise<UptimeStep> {
  const { client, target, want } = input;
  const facts = await inspectUptime(client, target.accountId);
  let desired: UptimeDesired = {
    id: target.id,
    script: SCRIPT,
    ...(input.destroy === true ? { destroy: true as const } : {}),
  };
  if (want !== undefined) {
    const kind = (await repositoryCheckSettings(deps.paths, want.plan))?.webhook;
    if (kind === undefined) {
      throw new OpsCrewError(
        "INTERNAL",
        "OpsCrew planned the uptime Worker's entry without the repository's webhook.",
        { hint: "Report this to OpsCrew." },
      );
    }
    const entry = uptimeEntry(want.plan, want.repository, kind);
    desired = { ...desired, entry };
    // What else blocks the plan stops it before the address is asked.
    const first = planUptime(facts, desired);
    if (first.findings.some((finding) => finding.code !== "secret-missing")) {
      return { client, target, plan: first, desired, details: describeUptimePlan(first) };
    }
    const secret = await webhookSecret(deps, {
      kind,
      name: entry.secret,
      stored: facts.secrets?.includes(entry.secret) === true,
      ask: want.ask,
    });
    if (secret !== undefined) desired = { ...desired, secret };
  }
  const plan = planUptime(facts, desired);
  return { client, target, plan, desired, details: describeUptimePlan(plan) };
}

/** The stop on the plan's findings (`PHASE_PRECONDITION`, nothing changed), with the plan shown. */
function requireNoFindings(
  deps: Pick<PhaseDeps, "reporter">,
  step: UptimeStep,
  command: string,
): void {
  if (step.plan.findings.length === 0) return;
  deps.reporter.info(step.details);
  throw adapterBlocked({
    cannot: "OpsCrew cannot apply the Cloudflare uptime plan",
    findings: step.plan.findings,
    blocked: [],
    fallbackHint: `Fix what blocks the Cloudflare uptime plan, then run \`${command}\` again.`,
  });
}

/**
 * Asks the plan's `cloudflare-apply` approval by its hash (with `app`, a destroy's: `allowDestroy`
 * and the typed app name, which the destroy's typed confirmation grants), applies it, audits each
 * change (names only, never the secret) and updates this computer's record.
 */
async function applyStep(
  deps: PhaseDeps,
  step: UptimeStep,
  input: { command: string; phase: PhaseName; app?: string },
): Promise<void> {
  const { plan } = step;
  const label = uptimeLabel(plan.id);
  const destroy = input.app !== undefined;
  const approval = await deps.approvals.request({
    kind: "cloudflare-apply",
    title: `Apply the Cloudflare uptime plan for ${label} (${plural(plan.changes.length, "change")})`,
    details: step.details,
    planHash: plan.hash,
    ...(input.app !== undefined ? { allowDestroy: true, confirmPhrase: input.app } : {}),
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "Cloudflare uptime plan",
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged:
        "The uptime Worker in Cloudflare was not changed; everything before this step is done.",
      hint: approveLaterHint(input.command, plan.hash, input.app),
    });
  }
  await deps.approvals.assertApprovedCloudflarePlan(plan.hash, { allowDestroy: destroy });
  deps.reporter.step(
    `Changing the Cloudflare uptime Worker for ${label} (${plural(plan.changes.length, "change")})`,
  );
  const audit = (action: string, decision: "approved" | "refused", detail: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      phase: input.phase,
      target: plan.hash,
      decision,
      detail,
    });
  await audit(
    "cloudflare uptime apply started",
    "approved",
    `${label}: ${plan.changes.map((change) => change.kind).join(", ")}`,
  );
  let applied: Awaited<ReturnType<typeof applyUptime>>;
  try {
    applied = await applyUptime(step.client, plan, step.desired, plan.hash);
  } catch (error) {
    const done = error instanceof UptimeApplyError ? error.applied : [];
    await audit(
      "cloudflare uptime apply failed",
      "refused",
      `changes applied before the failure: ${done.length > 0 ? done.join(", ") : "none"}`,
    );
    throw error;
  }
  for (const kind of applied.applied) {
    await audit(`cloudflare uptime change ${kind}`, "approved", label);
  }
  for (const note of applied.notes) deps.reporter.info(note);
  await recordAfter(deps.paths, step);
  deps.reporter.success(
    `Changed the Cloudflare uptime Worker for ${label} (${plural(applied.applied.length, "change")} applied).`,
  );
}

/** The record once the plan is applied (or has no change): kept with an entry, else removed. */
async function recordAfter(paths: Pick<ProjectPaths, "stateDir">, step: UptimeStep) {
  if (step.desired.entry !== undefined) await writeUptimeRecord(paths, step.target);
  else await removeUptimeRecord(paths);
}

// --- Provision --------------------------------------------------------------------------------

/**
 * Provision's uptime step, planned read-only before anything changes: with the Worker chosen, the
 * environment's entry and secret in the account of the app's zone (the address from
 * `OPSCREW_CHECK_WEBHOOK`, or with `ask`, in a terminal, asked when the Worker has none for it and
 * nothing else blocks the plan); when the plan no longer chooses it and this computer recorded an
 * entry, that entry's removal, its state's and its secret's (the Worker, its trigger and the
 * namespace stay). Its findings stop the run (`PHASE_PRECONDITION`, nothing changed). `undefined`
 * when there is nothing to plan, which reads nothing.
 */
export async function planProvisionUptime(
  deps: Pick<
    PhaseDeps,
    "paths" | "env" | "interactive" | "reporter" | "redactor" | "fetch" | "version"
  >,
  input: {
    plan: DeployPlan;
    /** The repository's GitHub coordinates (its remote), read only when there is a plan to make. */
    github: () => Promise<{ owner: string; repo: string }>;
    services: Pick<ProvisionServices, "askCheckWebhook" | "sharedCloudflare">;
    command: string;
    ask: boolean;
  },
): Promise<UptimeStep | undefined> {
  const { plan } = input;
  const wanted = usesUptimeWorker(plan);
  if (!wanted && (await readUptimeRecord(deps.paths)) === undefined) return undefined;
  if (wanted) deps.reporter.info(UPTIME_ONLY_LINE);
  const { owner, repo } = await input.github();
  const repository = `${owner}/${repo}`;
  const client = sharedCloudflareClient(deps, input.services);
  const target = await uptimeTarget(deps.paths, plan, { client, repository });
  if (target === undefined) return undefined;
  const ask = input.ask ? input.services.askCheckWebhook : undefined;
  const step = await uptimeStep(deps, {
    client,
    target,
    ...(wanted ? { want: { plan, repository, ask } } : {}),
  });
  requireNoFindings(deps, step, input.command);
  return step;
}

/**
 * Provision's part of the uptime Worker, at its step: the planned `step`
 * ({@link planProvisionUptime}) shown, approved by its hash (`cloudflare-apply`), applied and
 * audited; without changes only this computer's record is updated. With `planOnly` it is only
 * shown, with a line naming its hash for scripts. Returns the hash of a plan with changes.
 */
export async function provisionUptime(
  deps: PhaseDeps,
  step: UptimeStep | undefined,
  input: { command: string; phase: PhaseName; planOnly?: boolean },
): Promise<string | undefined> {
  if (step === undefined) return undefined;
  if (step.plan.changes.length === 0) {
    deps.reporter.success(
      step.desired.entry !== undefined
        ? "The Cloudflare uptime Worker is already set up for this environment; nothing in Cloudflare changes."
        : "The Cloudflare uptime Worker has no entry of this environment; nothing in Cloudflare changes.",
    );
    if (input.planOnly !== true) await recordAfter(deps.paths, step);
    return undefined;
  }
  deps.reporter.info(step.details);
  if (input.planOnly === true) {
    deps.reporter.info(
      `The uptime check has a Cloudflare plan of its own: Cloudflare uptime plan ${step.plan.hash}. In a script, approve it too (\`--approve ${step.plan.hash}\`).`,
    );
    return step.plan.hash;
  }
  await applyStep(deps, step, { command: input.command, phase: input.phase });
  return step.plan.hash;
}

// --- Destroy ----------------------------------------------------------------------------------

/**
 * Plans, read-only and before the teardown's typed confirmation, the removal of the
 * environment's entry, state and secret from the Worker, and with no other entry left the
 * Worker's (its trigger and secrets) and the namespace's (`desired.destroy`). Stops on the plan's
 * findings before anything changes. `undefined` when the environment has no entry this computer
 * knows of; a plan without changes only removes the record when applied.
 */
export async function planUptimeTeardown(
  deps: Pick<
    PhaseDeps,
    "paths" | "env" | "interactive" | "reporter" | "redactor" | "fetch" | "version"
  >,
  plan: DeployPlan,
  input: {
    services: Pick<ProvisionServices, "sharedCloudflare">;
    github: { owner?: string; repo?: string };
    command: string;
  },
): Promise<UptimeStep | undefined> {
  if (!usesUptimeWorker(plan) && (await readUptimeRecord(deps.paths)) === undefined) {
    return undefined;
  }
  const { owner, repo } = input.github;
  const client = sharedCloudflareClient(deps, input.services);
  const repository = owner !== undefined && repo !== undefined ? `${owner}/${repo}` : undefined;
  const target = await uptimeTarget(deps.paths, plan, { client, repository });
  if (target === undefined) return undefined;
  const step = await uptimeStep(deps, { client, target, destroy: true });
  requireNoFindings(deps, step, input.command);
  return step;
}

/**
 * The lines of the teardown's typed confirmation that say it also removes the environment's
 * entry from the Worker (and the Worker, with the last entry): the uptime plan's words and hash.
 */
export function uptimeTeardownNote(step: UptimeStep | undefined): string[] {
  if (step === undefined || step.plan.changes.length === 0) return [];
  const label = uptimeLabel(step.plan.id);
  return [
    `This also removes the uptime check's entry for ${label} from the Cloudflare Worker ${WORKER}${step.plan.destroys ? `, and the Worker, its trigger and its KV namespace ${NAMESPACE}, which no other entry uses` : ""}:`,
    step.details,
  ];
}

/**
 * Applies the planned removal under the teardown's typed confirmation (`cloudflare-apply` with
 * `allowDestroy` and the app's name, which that confirmation grants; no other question), and
 * removes this computer's record; without changes only the record goes.
 */
export async function applyUptimeTeardown(
  deps: PhaseDeps,
  plan: DeployPlan,
  step: UptimeStep,
  input: { command: string; phase: PhaseName },
): Promise<void> {
  if (step.plan.changes.length === 0) await removeUptimeRecord(deps.paths);
  else await applyStep(deps, step, { ...input, app: plan.app.name });
}

// --- Status -----------------------------------------------------------------------------------

const UptimeStateSchema = z.looseObject({
  hosts: z.record(
    z.string(),
    z.looseObject({
      status: z.enum(["suspect", "down"]),
      since: z.string(),
      reason: z.string(),
    }),
  ),
});

/** The Worker's state of an entry (`state:<id>`), what it holds of each hostname not up. */
export type UptimeState = z.infer<typeof UptimeStateSchema>;

/** The Worker's `state:` value; `undefined` for anything the Worker does not write. */
export function parseUptimeState(text: string): UptimeState | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = UptimeStateSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The uptime check's lines in `status` for an environment the Worker checks, read from Cloudflare
 * now (read-only, with `CLOUDFLARE_API_TOKEN`): where it runs, the hostnames it checks, and the
 * hostnames its state has down, with since when and why. A missing Worker or entry says to run
 * `provision`; a line says why instead when Cloudflare cannot be read. Redacted.
 */
export async function uptimeStatusLines(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const head = `Uptime check (the Cloudflare Worker ${WORKER}, read from Cloudflare now):`;
  const lines = await uptimeState(deps, plan).catch((error: unknown) => {
    if (!isUserFacingError(error)) throw error;
    return [`  OpsCrew could not read it. ${errorText(error)}`];
  });
  return [head, ...lines].map((line) => deps.redactor.redact(line));
}

async function uptimeState(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const client = cloudflareConnector(deps).client;
  if (client === undefined) {
    return ["  OpsCrew could not read it: CLOUDFLARE_API_TOKEN is not set."];
  }
  const record = await readUptimeRecord(deps.paths);
  const repository =
    record === undefined
      ? await githubCoordinates(gitClient(deps)).then(({ owner, repo }) => `${owner}/${repo}`)
      : undefined;
  const flags = await commandFlags(deps.paths.root, deps.paths.environment, plan.app.key);
  const target = await uptimeTarget(deps.paths, plan, { client, repository });
  const provision = `Run \`opscrew provision${flags}\` to set it up again.`;
  if (target === undefined) return [`  Not set up: nothing checks the app now. ${provision}`];
  deps.reporter.step("Reading the uptime check's state at Cloudflare (read-only)");
  const facts = await inspectUptime(client, target.accountId);
  if (facts.denied.length > 0) {
    return [
      `  OpsCrew could not read it: the Cloudflare token lacks ${facts.denied.join(" and ")}.`,
    ];
  }
  const entry = facts.entries[uptimeEntryKey(target.id)];
  if (facts.secrets === null || entry === undefined || facts.namespaceId === null) {
    const missing =
      facts.secrets === null ? `The Worker ${WORKER} is` : "This environment's entry is";
    return [
      `  ${missing} missing from the Cloudflare account, so nothing checks the app now. ${provision}`,
    ];
  }
  const text = await client.getKv(target.accountId, facts.namespaceId, uptimeStateKey(target.id));
  const state = text === undefined ? { hosts: {} } : parseUptimeState(text);
  const hosts = entry.hosts.map((host) => `${host.hostname}${host.healthPath}`);
  const down = Object.entries(state?.hosts ?? {}).filter(([, host]) => host.status === "down");
  return [
    `  Checked every 5 minutes by the Cloudflare Worker ${WORKER}: ${hosts.join(", ")}`,
    ...(state === undefined
      ? [`  Down: unknown: the Worker's state for this environment is not what it writes.`]
      : down.length === 0
        ? ["  Down: none"]
        : [
            "  Down:",
            ...down.map(
              ([hostname, host]) => `    ${hostname} since ${host.since}: ${host.reason}`,
            ),
          ]),
  ];
}

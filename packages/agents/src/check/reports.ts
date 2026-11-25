/**
 * The servers' part of the Cloudflare uptime check (feature 046, User Story 4). With
 * `observability.check.runner: cloudflare`, the app's server, where the scheduled check's key
 * reaches it today, gets the host step `uptime-report`, through a host plan approved by its hash. Its
 * timer checks the disk, the last scheduled snapshot and restore drill, the certificates the
 * server serves and the credentials' ages, with the scheduled check's rules and thresholds. It
 * reports to the Worker's workers.dev address only on a change and once a day, signed with the
 * environment's report key (`ensureReportKey`). The Cloudflare plan, with the entry's `servers`,
 * is applied first, so the Worker takes the first report.
 */
import {
  applyHostPlan,
  type DesiredUptimeReport,
  inspectUptimeReport,
  planUptimeReport,
  UPTIME_REPORT_KEY_REACH,
  type UptimeReportFacts,
} from "@opscrew/connector-ssh-host";
import type { PhaseName, RemoteExec } from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import { CHECK_THRESHOLDS, checkHosts, IMAGES, snapshotParts } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  credentialMaxAgeDaysOf,
  type DeployPlan,
  isHostingTarget,
  snapshotScheduleOf,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { ProvisionServices } from "../provision/types";
import { readCredentialsRecord } from "../rotate/record";
import {
  approveAndApplyHostPlan,
  type HostAdapterApi,
  type HostPlanOutcome,
} from "../shared/host-plan";
import { serverAddress } from "../shared/server-address";
import { readOwnServer } from "../shared/server-record";
import { loginShell } from "../shared/servers";
import { checkedCredentialNames, ownServerId } from "./files";
import type { ReportKey } from "./key";
import { checkReachesOverSsh, usesUptimeWorker } from "./settings";

/** What design and provision say on a target with no server OpsCrew reaches (spec, edge cases). */
export const UPTIME_ONLY_LINE =
  "This target has no server OpsCrew reaches, so the Worker checks its address only: the disk, snapshot, restore-drill, certificate-days and credential-age checks need `runner: actions`.";

/**
 * The image root steps run in where the login becomes root only through Docker (the deploy login
 * of a server OpsCrew created); unused where it is root or has passwordless sudo.
 */
const ROOT_IMAGE = IMAGES.caddy.ref;

/** How the servers' reports reach a server: SSH by default, fakes in tests. */
export type ReportServices = Pick<ProvisionServices, "remote" | "own" | "serverHost">;

/** A server of the uptime entry (`UptimeEntry["servers"]`): its id, since when, its drills. */
export type ReportServer = {
  /** Its id in the scheduled check, never an address. */
  id: string;
  /** When it was first listed (ISO). */
  since: string;
  /** The app's scheduled restore drills' schedule, while it has them. */
  drill?: "weekly" | "daily";
};

/**
 * The schedule of the restore drills the app's server runs: `snapshots.drills.schedule`, with
 * scheduled snapshots of data on that server, as the scheduled check's `snapshots.drill` has it.
 */
function reportDrill(plan: DeployPlan): ReportServer["drill"] {
  const every = plan.snapshots?.drills?.schedule;
  if (snapshotScheduleOf(plan) === undefined || snapshotParts(plan).length === 0) return undefined;
  return every;
}

/**
 * The app server's id in the scheduled check: a server the user owns by its pinned host key's
 * fingerprint, else `<provider>-<app name>` (`hetzner-shop`).
 */
async function reportServerId(paths: PhaseDeps["paths"], plan: DeployPlan): Promise<string> {
  if (plan.target.provider === "own") {
    const hostKey = (await readOwnServer(paths))?.hostKey;
    if (hostKey !== undefined) return ownServerId(hostKey);
  }
  return `${plan.target.provider}-${plan.app.name}`;
}

/**
 * True when `plan`'s app server reports its own checks to the Worker: with the Worker chosen, where
 * the scheduled check's key reaches it today (`checkReachesOverSsh`).
 */
function appServerReports(plan: DeployPlan): boolean {
  return usesUptimeWorker(plan) && checkReachesOverSsh(plan);
}

/**
 * The servers of `plan`'s environment whose checks report to the Worker, as its entry lists them:
 * with the Worker chosen, the app's server where the scheduled check's key reaches it today
 * (`checkReachesOverSsh`); none otherwise. A new one is listed since the start of today (UTC), so
 * the plan `--plan-only` shows is the one applied later that day; the Cloudflare plan keeps the
 * date of one already listed.
 */
export async function reportServers(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  plan: DeployPlan,
): Promise<ReportServer[]> {
  if (!appServerReports(plan)) return [];
  const drill = reportDrill(plan);
  return [
    {
      id: await reportServerId(deps.paths, plan),
      since: `${deps.clock.now().toISOString().slice(0, 10)}T00:00:00Z`,
      ...(drill === undefined ? {} : { drill }),
    },
  ];
}

/**
 * What design and provision say about servers that get no uptime report, with the Worker chosen:
 * on a target with no server OpsCrew reaches, {@link UPTIME_ONLY_LINE}; otherwise the app's server
 * where the scheduled check's key doesn't reach it, and the extra servers. Empty when every server
 * reports, or without the Worker.
 */
export function unreportedLines(plan: DeployPlan): string[] {
  if (!usesUptimeWorker(plan)) return [];
  if (isHostingTarget(plan.target) || plan.target.mode !== "vps-compose") return [UPTIME_ONLY_LINE];
  const extras = (plan.servers ?? []).map((server) => server.name);
  const one = extras.length === 1;
  return [
    ...(checkReachesOverSsh(plan)
      ? []
      : [
          "No uptime report from the app's server (OpsCrew sets it up only where the scheduled check's key reaches it, not through a Cloudflare Tunnel, at home or with the server's own runner), so the Worker checks the app's address only: the disk, snapshot, restore-drill, certificate-days and credential-age checks need `runner: actions`.",
        ]),
    ...(extras.length === 0
      ? []
      : [
          `No uptime report from ${one ? "server" : "the servers"} ${listText(extras)} (OpsCrew sets it up on the app's server only): ${one ? "its" : "their"} disk and scheduled snapshot checks need \`runner: actions\`.`,
        ]),
  ];
}

/**
 * What design says about the servers' checks with the Worker chosen: that the app's server reports
 * its own, with what its report key can do, then {@link unreportedLines}.
 */
export function reportDesignLines(plan: DeployPlan): string[] {
  const credentials = plan.observability?.check?.credentials === true;
  return [
    ...(appServerReports(plan)
      ? [
          `The app's server checks its own disk, last scheduled snapshot and restore drill${credentials ? ", the certificates it serves and the credentials' ages" : " and the certificates it serves"}, with a timer a host plan installs, and reports to the Worker only on a change and once a day. The Worker posts each change, and says when a server's reports stop for 26 hours. ${UPTIME_REPORT_KEY_REACH}`,
        ]
      : []),
    ...unreportedLines(plan),
  ];
}

/**
 * The credentials the server dates, as check.mjs dates them: each one the scheduled check dates
 * (`checkedCredentialNames`) with its last rotation in the app's rotation record, else when it was
 * made, else the environment's first deploy (one with none is left out), and
 * `credentials.maxAgeDays`. Names and dates only. `undefined` with `check.credentials` off.
 */
export async function reportCredentials(
  deps: Pick<PhaseDeps, "paths" | "env" | "clock">,
  plan: DeployPlan,
): Promise<DesiredUptimeReport["credentials"]> {
  if (plan.observability?.check?.credentials !== true) return undefined;
  const recorded = (await readCredentialsRecord(deps)).environments[deps.paths.environment] ?? {};
  const since = plan.deployment.firstDeployAt;
  const dates: NonNullable<DesiredUptimeReport["credentials"]>["dates"] = [];
  for (const name of await checkedCredentialNames(deps, plan)) {
    const { madeAt, rotatedAt } = recorded[name] ?? {};
    const at = rotatedAt ?? madeAt;
    if (at !== undefined) {
      dates.push({ name, at, source: rotatedAt === undefined ? "made" : "rotated" });
    } else if (since !== undefined) {
      dates.push({ name, at: since, source: "first-deploy" });
    }
  }
  return { maxAgeDays: credentialMaxAgeDaysOf(plan), dates };
}

/**
 * The `uptime-report` step's settings on `server` for the entry `entry`: the report address, the
 * server's id, its drills, the hostnames whose certificates it serves for the app, the scheduled
 * check's thresholds, the credentials' names and dates ({@link reportCredentials}) and the report
 * key by its SHA-256. Never a value.
 */
export async function reportSettings(
  deps: Pick<PhaseDeps, "paths" | "env" | "clock">,
  plan: DeployPlan,
  input: { url: string; entry: string; server: ReportServer; key: ReportKey },
): Promise<DesiredUptimeReport> {
  const credentials = await reportCredentials(deps, plan);
  return {
    url: input.url,
    entry: input.entry,
    server: input.server.id,
    ...(input.server.drill === undefined ? {} : { drill: input.server.drill }),
    hosts: checkHosts(plan).map((host) => host.hostname),
    thresholds: {
      diskWarn: CHECK_THRESHOLDS.diskWarn,
      diskHigh: CHECK_THRESHOLDS.diskHigh,
      certDays: CHECK_THRESHOLDS.certDays,
    },
    ...(credentials === undefined ? {} : { credentials }),
    keySha256: input.key.sha256,
  };
}

/** The uptime report's reads and changes on a server, as root. */
interface ReportAdapter {
  inspect(remote: RemoteExec): Promise<UptimeReportFacts>;
  apply: HostAdapterApi["apply"];
}

/**
 * ssh-host's `inspectUptimeReport` and `applyHostPlan`, as root the way the login becomes root,
 * or `fake`'s inspection and apply (tests).
 */
function reportAdapter(fake: ProvisionServices["serverHost"]): ReportAdapter {
  if (fake === undefined) {
    return {
      inspect: (remote) => inspectUptimeReport(remote, { rootImage: ROOT_IMAGE }),
      apply: (remote, plan, options) =>
        applyHostPlan(remote, plan, { ...options, rootImage: ROOT_IMAGE }),
    };
  }
  return {
    inspect: async (remote) => {
      const facts = (await fake.inspect(remote, { rootImage: ROOT_IMAGE })).uptimeReport;
      if (facts !== undefined) return facts;
      throw new OpsCrewError(
        "COMMAND_FAILED",
        "OpsCrew could not read the uptime report on the server.",
        {
          hint: "Check that the server is reachable, then try again.",
        },
      );
    },
    apply: (remote, plan, options) =>
      fake.apply(remote, plan, { ...options, rootImage: ROOT_IMAGE }),
  };
}

/**
 * The `uptime-report` host plan on `plan`'s app server for the entry `entry`: with `report`, the
 * step that sets it up (its key supplied at apply only), else its removal. Reached with the app
 * server's login (`loginShell`: the admin login of a server the user owns, deploy on one OpsCrew
 * created) and inspected as root; shown, approved by its hash (`host-apply`) and applied, or with
 * `planOnly` only shown, with a line naming its hash. With `planOnly` and no server yet (OpsCrew
 * creates it), it says the plan comes once the server exists. Returns the plan's outcome.
 * @throws PlanRefusedError when it is not approved (nothing on the server changed).
 */
export async function reportHostPlan(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    services: ReportServices;
    entry: string;
    report?: { settings: DesiredUptimeReport; key: ReportKey };
    command: string;
    phase: PhaseName;
    planOnly?: boolean;
  },
): Promise<HostPlanOutcome | undefined> {
  const { plan, report, planOnly } = input;
  if (
    planOnly === true &&
    plan.target.provider !== "own" &&
    (await serverAddress(deps, plan)) === undefined
  ) {
    deps.reporter.info(
      "The uptime report's host plan is shown once the server exists: run the command again after it was created.",
    );
    return undefined;
  }
  const { remote, login } = await loginShell(deps, plan, APP_SERVER, input.services);
  const adapter = reportAdapter(login.own ? input.services.own?.host : input.services.serverHost);
  const facts = await adapter.inspect(remote);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the uptime report (read-only)",
    phase: input.phase,
    target: "server",
    decision: "allow",
  });
  const server = login.own ? "your server" : "the server";
  const hostPlan = planUptimeReport({
    app: plan.app.name,
    facts,
    ...(report === undefined ? { disable: { entry: input.entry } } : { enable: report.settings }),
  });
  const outcome = await approveAndApplyHostPlan(deps, {
    plan: hostPlan,
    remote,
    apply: adapter.apply,
    // The step changes no SSH or firewall setting.
    verifyLogin: async () => true,
    title:
      report === undefined
        ? `Remove the uptime report of this environment from ${server}`
        : `Report the checks of ${server} to the Cloudflare uptime Worker`,
    server,
    planOf: server,
    upToDate:
      report === undefined
        ? `The uptime report of this environment is not on ${server}; nothing on it changes.`
        : `The uptime report on ${server} is as planned; nothing on it changes.`,
    command: input.command,
    phase: input.phase,
    secrets: async () => (report === undefined ? {} : { uptimeReportKey: report.key.value }),
    applying:
      report === undefined
        ? `Removing the uptime report from ${server}`
        : `Setting up the uptime report on ${server}`,
    ...(planOnly === true ? { planOnly: true } : {}),
  });
  if (planOnly === true && hostPlan.steps.some((step) => step.state === "change")) {
    deps.reporter.info(
      `The uptime report has a host plan of its own: uptime-report plan ${outcome.hash}. In a script, approve it too (\`--approve ${outcome.hash}\`).`,
    );
  }
  return outcome;
}

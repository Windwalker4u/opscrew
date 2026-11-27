/**
 * Advise's horizontal scale-out rules (feature 033, T3310): when an app runs on a single server
 * (`app.servers` empty) and shows sustained high load, sustained web memory pressure, or hits the
 * largest single-server tier under load/memory pressure, propose adding a second web server via
 * `app.servers` when stateless-ready, or list the concrete local-state blockers to resolve first.
 * Read-only.
 */
import { plural } from "@opscrew/core";
import {
  APP_SERVER,
  type DeployPlan,
  isServerlessProvider,
  onOneServer,
  type ProjectFacts,
  postgresPooler,
  serviceOf,
} from "@opscrew/plan-schema";
import { cheapestServerOffer } from "../../design/servers";
import {
  type Basis,
  type Proposal,
  type Readings,
  type Reason,
  type ServerReadings,
  THRESHOLDS,
} from "../types";
import {
  cloudServers,
  historyBasis,
  isPriced,
  otherTypes,
  PLAN,
  type PricedServer,
  percent,
  percentAbove,
  readingBasis,
  withoutStop,
} from "./shared";

const GIB = 1024 ** 3;

/** Concrete local-state blockers preventing safe multi-server web scaling (`app.servers`). */
export function statelessBlockers(
  plan: Pick<DeployPlan, "storage">,
  facts: Pick<ProjectFacts, "statelessIssues"> | undefined,
): string[] {
  const blockers: string[] = [];
  if (plan.storage?.sqlite !== undefined) {
    blockers.push(
      `Local SQLite database (${plan.storage.sqlite.dir}) cannot be shared across multiple web servers: migrate to PostgreSQL or another networked database first`,
    );
  }
  if (plan.storage?.files !== undefined) {
    blockers.push(
      `Local persistent files folder (${plan.storage.files.dir}) is bound to one server: move uploads/files to S3-compatible object storage first`,
    );
  }
  for (const issue of facts?.statelessIssues ?? []) {
    const label = issue.kind === "local-sessions" ? "Local sessions" : "Local file uploads";
    const where = issue.file === undefined ? "" : ` in ${issue.file}`;
    blockers.push(
      withoutStop(
        `${label} (${issue.framework}${where}): ${withoutStop(issue.evidence)}. ${issue.remediation}`,
      ),
    );
  }
  return blockers;
}

/** Memory in use share on `figures` (14-day p95 when available, else the one reading). */
function serverMemoryShare(figures: ServerReadings): { share: number; basis: Basis } | undefined {
  if (figures.history?.memoryP95 !== undefined) {
    return { share: figures.history.memoryP95, basis: historyBasis(figures.history) };
  }
  const memory = figures.now.server?.memory;
  if (memory?.usedBytes === undefined || memory.totalBytes <= 0) return undefined;
  return { share: memory.usedBytes / memory.totalBytes, basis: readingBasis(figures.now) };
}

/**
 * True when `priced` has no larger offer in its price list that satisfies the needed CPUs/memory.
 */
function atSingleServerCeiling(
  priced: PricedServer | undefined,
  needMemoryGb: number | undefined,
  needVcpus: number | undefined,
): boolean {
  if (priced === undefined || (needMemoryGb === undefined && needVcpus === undefined)) return false;
  const current = priced.prices.offer;
  const larger = cheapestServerOffer(
    otherTypes(priced),
    priced.location,
    {
      memoryMb: Math.max(current.memoryGb, needMemoryGb ?? 0) * 1024,
      vcpus: Math.max(current.vcpus, needVcpus ?? 0),
    },
    current.diskGb,
  );
  return larger === undefined;
}

/**
 * Horizontal scale-out guidance for single-server apps under sustained load/web memory pressure
 * or at the largest single-server tier.
 */
export function scalingRules(readings: Readings): Proposal[] {
  const { plan, flags } = readings;
  if (
    isServerlessProvider(plan.target.provider) ||
    !onOneServer(plan.target.provider) ||
    plan.environment?.previews !== undefined ||
    (plan.app.servers?.length ?? 0) > 0
  ) {
    return [];
  }
  const figures = readings.servers[APP_SERVER];
  if (figures === undefined) return [];

  const cloud = cloudServers(readings).find((s) => s.name === APP_SERVER);
  const priced = cloud !== undefined && isPriced(cloud) ? cloud : undefined;
  const cpus = figures.now.server?.cpus ?? priced?.prices.offer.vcpus;
  const totalGb =
    priced?.prices.offer.memoryGb ??
    (figures.now.server?.memory.totalBytes === undefined
      ? undefined
      : figures.now.server.memory.totalBytes / GIB);

  const pressureReasons: Reason[] = [];
  const history = figures.history;

  // 1. Sustained CPU load over the history window.
  let needVcpus: number | undefined;
  if (
    history !== undefined &&
    cpus !== undefined &&
    history.loadOverCpus !== undefined &&
    history.loadOverCpus >= THRESHOLDS.loadHighShare
  ) {
    needVcpus = cpus + 1;
    pressureReasons.push({
      text: `The 15-minute load was above server ${APP_SERVER}'s ${plural(cpus, "CPU")}`,
      figure: `${percent(history.loadOverCpus)} of the time`,
      basis: historyBasis(history),
    });
  } else if (
    history === undefined &&
    cpus !== undefined &&
    figures.now.server?.load15 !== undefined &&
    figures.now.server.load15 > cpus
  ) {
    needVcpus = Math.ceil(figures.now.server.load15);
  }

  // 2. Sustained web process memory pressure on a memory-constrained server.
  if (
    history !== undefined &&
    history.memoryP95 !== undefined &&
    history.memoryP95 > THRESHOLDS.memoryHigh
  ) {
    const webHistory = history.containers.find((c) => c.service === "app");
    const runningLimit = figures.now.containers.find(
      (c) => c.service === "app" && c.memory.limitBytes !== undefined,
    )?.memory.limitBytes;
    const limitBytes = webHistory?.limit ?? runningLimit;
    const peak =
      webHistory?.memoryMax !== undefined && limitBytes ? webHistory.memoryMax / limitBytes : 0;
    const oomKills = webHistory?.oomKills ?? 0;
    if ((limitBytes && peak >= THRESHOLDS.containerAtLimit) || oomKills > 0) {
      pressureReasons.push({
        text:
          oomKills > 0
            ? `The web process was stopped for lack of memory while server ${APP_SERVER}'s memory in use stayed above ${percent(THRESHOLDS.memoryHigh)}`
            : `The web process reached its memory limit while server ${APP_SERVER}'s memory in use stayed above ${percent(THRESHOLDS.memoryHigh)}`,
        figure:
          oomKills > 0
            ? plural(oomKills, "OOM kill")
            : `${percent(peak)} of ${Math.round((limitBytes ?? 0) / 1024 ** 2)} MB`,
        basis: historyBasis(history),
      });
    }
  }

  // 3. Single-server vertical ceiling reached under current or historical pressure.
  const memory = serverMemoryShare(figures);
  const needMemoryGb =
    memory !== undefined && totalGb !== undefined && memory.share > THRESHOLDS.memoryHigh
      ? (memory.share * totalGb) / THRESHOLDS.memoryHigh
      : undefined;
  const ceiling = atSingleServerCeiling(priced, needMemoryGb, needVcpus);
  if (ceiling && pressureReasons.length === 0) {
    if (needVcpus !== undefined && cpus !== undefined && figures.now.server?.load15 !== undefined) {
      pressureReasons.push({
        text: `The 15-minute load is above server ${APP_SERVER}'s ${plural(cpus, "CPU")} and no larger server type is available`,
        figure: figures.now.server.load15.toFixed(2),
        basis: readingBasis(figures.now),
      });
    }
    if (memory !== undefined && totalGb !== undefined && memory.share > THRESHOLDS.memoryHigh) {
      pressureReasons.push({
        text: `Memory in use is above ${percent(THRESHOLDS.memoryHigh)} of server ${APP_SERVER} and no larger server type is available`,
        figure: `${percentAbove(memory.share)} of ${Number(totalGb.toFixed(1))} GB`,
        basis: memory.basis,
      });
    }
  }

  if (pressureReasons.length === 0) return [];

  const blockers = statelessBlockers(plan, readings.facts);
  if (blockers.length > 0) {
    return [
      {
        id: `size.${APP_SERVER}.scale-out-blocked`,
        category: "size",
        urgency: "when-convenient",
        server: APP_SERVER,
        title: "Make the app stateless before adding another web server",
        reasons: [...pressureReasons, ...blockers.map((text): Reason => ({ text, basis: PLAN }))],
        apply: {
          kind: "manual",
          text: `Resolve the local-state blockers above, run \`opscrew analyze\`, then add a second server under \`servers\` and \`app.servers\` in opscrew/plan.yaml and run \`opscrew design${flags}\``,
        },
      },
    ];
  }

  const postgres = serviceOf(plan, "postgres");
  const poolerNote: Reason[] =
    postgres !== undefined && !postgresPooler(postgres)
      ? [
          {
            text: `\`opscrew design${flags}\` will also enable PgBouncer on PostgreSQL (${postgres.name}) so multiple web copies share connections cleanly`,
            basis: PLAN,
          },
        ]
      : [];

  return [
    {
      id: `size.${APP_SERVER}.scale-out`,
      category: "size",
      urgency: ceiling ? "soon" : "when-convenient",
      server: APP_SERVER,
      title: "Add a second web server to share traffic horizontally",
      reasons: [
        ...pressureReasons,
        {
          text: "No local SQLite, local file volumes or stateless-readiness blockers were detected; adding a server under `servers` and listing it in `app.servers` balances web requests from the front proxy over WireGuard",
          basis: PLAN,
        },
        ...poolerNote,
      ],
      apply: {
        kind: "manual",
        text: `Add a server (for example \`web2\`) under \`servers\` and list it under \`app.servers\` in opscrew/plan.yaml, then run \`opscrew design${flags}\` and \`opscrew provision${flags}\``,
      },
    },
  ];
}

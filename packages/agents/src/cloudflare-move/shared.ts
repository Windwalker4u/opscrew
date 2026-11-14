/**
 * The move's part in OpsCrew's shared Cloudflare resources (ADR 0014) and the app's origin TLS
 * (ADR 0017), each a Cloudflare plan approved by its hash (`cloudflare-apply`): B's shared plan at
 * prepare (plan 4.4.1), A's Origin CA certificate revoked at the finish (plan 7.7), and B's shared
 * pieces removed at an abort (plan 8.).
 */
import { join } from "node:path";
import {
  type CloudflareClient,
  planShared,
  SHARED_RULES,
  type SharedDesired,
  type SharedPlan,
  type SharedRecord,
} from "@opscrew/connector-cloudflare";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import {
  forgetNextOriginTls,
  keepCertificateRequest,
  type OriginTlsStep,
  originTlsApply,
  planOriginTls,
} from "../provision/origin-tls";
import {
  applyZonePlan,
  describeCloudflarePlan,
  listsHostnames,
  planSharedCloudflare,
  readCloudflareRecord,
  type SharedCloudflareInput,
  type ZonePlan,
  zonePlan,
} from "../provision/shared-cloudflare";
import { appliesNow } from "../retarget/steps";
import { approveCommand } from "../retarget/texts";
import { listsRedirect } from "../serverless/cloudflare/rules";
import { clearPending, type MovePlanKey, writePending } from "./progress";
import type { MoveEnvironment, MoveSession, MoveZone, StepStop } from "./types";

const PHASE = "cloudflare-move";

/** The environment's move folder: `<state folder>/cloudflare-move/` (data model 3). */
function moveDir(environment: MoveEnvironment): string {
  return join(environment.paths.stateDir, "cloudflare-move");
}

/** B's shared record of the environment: `cloudflare-move/cloudflare.json`. */
export function bSharedRecordPath(environment: MoveEnvironment): string {
  return join(moveDir(environment), "cloudflare.json");
}

/**
 * A's shared record of the environment once the finish's swap moved it aside
 * (`cloudflare-move/a-removal/cloudflare.json`): what {@link revokeAOrigin} reads.
 */
export function aSharedRecordPath(environment: MoveEnvironment): string {
  return join(moveDir(environment), "a-removal", "cloudflare.json");
}

/** The phase deps with the environment's paths (its records and generated values). */
function environmentDeps(session: MoveSession, environment: MoveEnvironment): PhaseDeps {
  return { ...session.deps, paths: environment.paths };
}

/** B's zone as B's token reads it now; `undefined` when B has none. */
async function readBZone(session: MoveSession): Promise<MoveZone | undefined> {
  const { b } = session.accounts;
  const found = await b.client.findZone(session.zone, { accountId: b.accountId });
  return found?.name === session.zone ? found : undefined;
}

/**
 * The origin TLS asked of B's zone at prepare (plan 4.4.1): the app's own client certificate with
 * per-hostname origin pulls, and a new Origin CA certificate kept as `originTlsNext`, set on B's
 * zone while it is pending. If per-hostname origin pulls can't be set on a pending zone (OPEN O1,
 * research R10.2), this is the one place that leaves the client certificate out until B's zone is
 * active.
 */
function originTlsForB(step: OriginTlsStep | undefined): Pick<SharedDesired, "tls"> {
  return step === undefined ? {} : { tls: step.desired };
}

/** What B's shared plan says beyond its changes: the certificate kept for the finish, the wait. */
function bNotes(step: OriginTlsStep | undefined, pending: boolean): (plan: SharedPlan) => string[] {
  return (plan) => {
    const notes: string[] = [];
    if (plan.changes.some((change) => change.kind === "create-origin-certificate")) {
      notes.push(
        "  The new origin certificate is kept on this computer: the server keeps serving the current one until the move's finish deploys it.",
      );
    }
    if (step?.keys !== undefined) {
      notes.push(
        "  The client certificate is the app's own, which the server already trusts, so it serves both accounts unchanged.",
      );
      if (pending) {
        notes.push(
          "  The zone is not active in this account yet: Cloudflare turns origin pulls on there once it is, so OpsCrew does not wait for them now.",
        );
      }
    }
    return notes;
  };
}

/** The stop of a non-interactive run: the plan above waits for `--approve <hash>`. */
function pendingStop(session: MoveSession, hash: string, flags: readonly string[]): StepStop {
  return {
    pendingPlanHash: hash,
    next: [
      `Review the plan above, then run \`${approveCommand(session.command, hash, flags)}\` to apply it and continue.`,
    ],
  };
}

/**
 * One Cloudflare plan of the move: nothing asked when it changes nothing (the record is written);
 * else shown, and applied after its approval when this run applies it (interactive, or
 * `--approve <hash>`), otherwise recorded as waiting and stopped. A plan that removes asks with
 * `allowDestroy` and the app's name typed.
 */
async function cloudflareStep(
  session: MoveSession,
  environment: MoveEnvironment,
  input: {
    key: MovePlanKey;
    client: CloudflareClient;
    zone: ZonePlan;
    allowDestroy?: boolean;
    apply?: Pick<SharedCloudflareInput, "keys" | "sleep" | "keepOriginCertificate">;
  },
): Promise<StepStop | undefined> {
  const deps = environmentDeps(session, environment);
  const { plan, details } = input.zone;
  const app = environment.plan.app.name;
  const run = { app, command: session.command, phase: PHASE } as const;
  if (plan.changes.length === 0) {
    await applyZonePlan(deps, input.client, input.zone, { ...run, planOnly: false });
    return undefined;
  }
  // A removal's plan is not shown by the apply (a destroy shows it in its preview).
  if (input.allowDestroy === true) deps.reporter.info(details);
  const now = appliesNow(session, plan.hash);
  await applyZonePlan(deps, input.client, input.zone, {
    ...run,
    planOnly: !now,
    ...(input.allowDestroy === true ? { allowDestroy: true } : {}),
    ...input.apply,
  });
  if (!now) {
    await writePending(session.deps, input.key, plan.hash);
    return pendingStop(session, plan.hash, input.allowDestroy === true ? ["--confirm", app] : []);
  }
  await clearPending(session.deps, input.key);
  return undefined;
}

/**
 * B's shared plan for the environment (plan 4.4.1): provision's shared plan in B's zone with B's
 * client and B's record ({@link bSharedRecordPath}): the environment's hostnames in OpsCrew's
 * rules there, the Zero Trust organization and one-time PIN login in B when its Access needs them,
 * the zone's minimum TLS as provision decides it, and the origin TLS ({@link originTlsForB}). On
 * B's pending zone the apply doesn't wait for origin pulls to deploy, and the plan counts settings
 * still deploying as on, so it settles after its first apply. Approved by its hash; a
 * non-interactive run without it stops with it.
 * @throws OpsCrewError `INTERNAL` when B's zone doesn't exist yet (the zone plan makes it first).
 */
export async function planBShared(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const deps = environmentDeps(session, environment);
  const { b } = session.accounts;
  const zone = await readBZone(session);
  if (zone === undefined) {
    throw new OpsCrewError(
      "INTERNAL",
      `The Cloudflare account the move goes to has no zone ${session.zone} yet, so its shared plan can't be made.`,
      { hint: "This is a bug in OpsCrew; please report it." },
    );
  }
  const { plan } = environment;
  const recordPath = bSharedRecordPath(environment);
  const pending = zone.status !== "active";
  const record = await readCloudflareRecord(deps.paths, recordPath).then((r) =>
    r?.zoneId === zone.id ? r : undefined,
  );
  // A site on Cloudflare's hosting has no origin of its own.
  const tls =
    plan.target.provider === "cloudflare-workers"
      ? undefined
      : await planOriginTls(deps, { plan, record, served: undefined, slot: "originTlsNext" });
  const shared = await planSharedCloudflare(deps, {
    services: {},
    plan,
    cloudflare: { zoneId: zone.id, zoneName: session.zone, accountId: b.accountId },
    command: session.command,
    tls: { ...originTlsForB(tls), minTls: true },
    notes: bNotes(tls, pending),
    client: b.client,
    recordPath,
    pendingZone: pending,
  });
  const main = shared?.main as ZonePlan;
  // Kept while the plan creates a certificate, so the plan keeps its hash for `--approve`.
  if (tls !== undefined) await keepCertificateRequest(deps, tls, main.plan);
  return cloudflareStep(session, environment, {
    key: { action: "shared", environment: environment.environment },
    client: b.client,
    zone: main,
    apply: originTlsApply(deps, tls, session.services),
  });
}

/**
 * A's Origin CA certificate of the environment revoked with A's client (plan 7.7), with every one
 * it replaced that A still lists, as A's record names them ({@link aSharedRecordPath}): a
 * Cloudflare plan with only those revocations, approved by its hash with `allowDestroy` and the
 * app's name typed. A's rules, its client certificate and origin pull settings are left to A's
 * moved zone, which Cloudflare deletes; A's Zero Trust pieces are never touched. Nothing is asked
 * when A's record names no origin certificate, or A lists none of them any more.
 */
export async function revokeAOrigin(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const deps = environmentDeps(session, environment);
  const { a } = session.accounts;
  const recordPath = aSharedRecordPath(environment);
  const record = await readCloudflareRecord(deps.paths, recordPath);
  const origin = record?.tls?.origin;
  if (record === undefined || origin === undefined) return undefined;
  // Only the origin certificate: no rule, client certificate or setting of A's is read or planned.
  const only: SharedRecord = {
    zoneId: record.zoneId,
    hostnames: {},
    createdEntrypoints: [],
    tls: { origin },
  };
  const desired: SharedDesired = { hostnames: {}, tls: { proxied: [], served: { requiring: [] } } };
  const plan = planShared(
    {
      zoneId: a.zoneId,
      accountId: a.accountId,
      entrypoints: {},
      tls: {
        readAt: deps.clock.now().toISOString(),
        origin: await a.client.listOriginCertificates(a.zoneId),
        client: [],
        aop: [],
      },
    },
    desired,
    only,
  );
  if (plan.changes.length === 0) return undefined;
  const details = describeCloudflarePlan(plan, desired, session.zone, [
    "  It was issued in the Cloudflare account the app moved from; the server serves the new account's origin certificate now.",
  ]);
  return cloudflareStep(session, environment, {
    key: { action: "a-revoke", environment: environment.environment },
    client: a.client,
    zone: { plan, desired, details, recordPath },
    allowDestroy: true,
  });
}

/**
 * B's shared pieces of the environment removed at an abort (plan 8.), from B's record
 * ({@link bSharedRecordPath}): its hostnames off OpsCrew's rules in B's zone, B's client
 * certificate turned off and deleted, and B's Origin CA certificate revoked (B's edge never served
 * the app, so nothing waits for the server), approved by its hash with `allowDestroy` and the app's
 * name typed; then `originTlsNext` forgotten. The Zero Trust organization and login in B stay, as
 * OpsCrew never deletes them. Without B's zone, or a record of it, only `originTlsNext` is
 * forgotten.
 */
export async function removeBShared(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const deps = environmentDeps(session, environment);
  const { b } = session.accounts;
  const recordPath = bSharedRecordPath(environment);
  const record = await readCloudflareRecord(deps.paths, recordPath);
  const zone = record === undefined ? undefined : await readBZone(session);
  if (record !== undefined && zone?.id === record.zoneId) {
    const tls = record.tls?.origin !== undefined || record.tls?.client !== undefined;
    const { phase } = SHARED_RULES["opscrew-www-redirect"];
    const redirect = listsRedirect(record) || record.createdEntrypoints.includes(phase);
    if (listsHostnames(record) || record.createdEntrypoints.length > 0 || tls) {
      const removal = await zonePlan(deps, {
        client: b.client,
        zoneId: zone.id,
        accountId: b.accountId,
        zone: session.zone,
        desired: {
          hostnames: {},
          ...(tls ? { tls: { proxied: [], served: { requiring: [] } } } : {}),
        },
        record,
        command: session.command,
        ...(redirect ? { redirect: true } : {}),
        recordPath,
        pendingZone: zone.status !== "active",
      });
      const stop = await cloudflareStep(session, environment, {
        key: { action: "abort-shared", environment: environment.environment },
        client: b.client,
        zone: removal,
        allowDestroy: true,
      });
      if (stop !== undefined) return stop;
    }
  }
  await forgetNextOriginTls(deps);
  return undefined;
}

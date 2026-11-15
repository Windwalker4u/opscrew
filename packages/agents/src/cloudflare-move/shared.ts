/**
 * The move's part in OpsCrew's shared Cloudflare resources (ADR 0014) and the app's origin TLS
 * (ADR 0017), each a Cloudflare plan approved by its hash (`cloudflare-apply`): B's shared plan at
 * prepare (plan 4.4.1), A's Origin CA certificate revoked at the finish (plan 7.7), and B's shared
 * pieces removed at an abort (plan 8.).
 */
import { rm } from "node:fs/promises";
import {
  type CloudflareClient,
  planShared,
  type SharedDesired,
  type SharedPlan,
  type SharedRecord,
} from "@opscrew/connector-cloudflare";
import { valueFingerprint } from "@opscrew/connector-portainer";
import { fingerprintSha256 } from "@opscrew/core";
import { PORTAINER_STACK_VARIABLES } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { planSharedRemoval } from "../destroy/shared-rules";
import {
  forgetNextOriginTls,
  keepCertificateRequest,
  type OriginTlsStep,
  type OriginTlsValues,
  originTlsApply,
  planOriginTls,
  portainerOriginTls,
  readOriginTlsValues,
  readServerEdge,
} from "../provision/origin-tls";
import {
  ensurePortainerValueKey,
  requirePortainerConnection,
  requirePortainerToken,
} from "../provision/portainer";
import { portainerInspect } from "../provision/portainer-flow";
import {
  applyZonePlan,
  describeCloudflarePlan,
  planSharedCloudflare,
  readCloudflareRecord,
  type SharedCloudflareInput,
  type ZonePlan,
} from "../provision/shared-cloudflare";
import { appliesNow } from "../retarget/steps";
import { approveCommand } from "../retarget/texts";
import { portainerClientFor, recordedStack } from "../shared";
import { moveFolder } from "./paths";
import { clearPending, type MovePlanKey, writePending } from "./progress";
import { zoneIn } from "./session";
import { bug, environmentDeps, MOVE_PHASE, refusal } from "./texts";
import type { MoveEnvironment, MoveSession, StepStop } from "./types";

/** B's shared record of the environment: `cloudflare-move/cloudflare.json`. */
export function bSharedRecordPath(environment: MoveEnvironment): string {
  return moveFolder(environment.paths, "cloudflare.json");
}

/**
 * A's shared record of the environment once the finish's swap moved it aside
 * (`cloudflare-move/a-removal/cloudflare.json`): what {@link revokeAOrigin} reads.
 */
export function aSharedRecordPath(environment: MoveEnvironment): string {
  return moveFolder(environment.paths, "a-removal", "cloudflare.json");
}

/** What B's shared plan says beyond its changes: the client certificate, the certificate later. */
function bNotes(step: OriginTlsStep | undefined, pending: boolean): (plan: SharedPlan) => string[] {
  return (plan) => {
    if (step?.keys === undefined) return [];
    const notes = [
      "  The client certificate is the app's own, which the server already trusts, so it serves both accounts unchanged.",
    ];
    if (pending) {
      notes.push(
        "  The zone is not active in this account yet: Cloudflare turns origin pulls on there once it is, so OpsCrew does not wait for them now. Cloudflare issues no origin certificate for it before then: the move's finish gets this account's and deploys it, and until then the server keeps serving the current one.",
      );
    } else if (plan.changes.some((change) => change.kind === "create-origin-certificate")) {
      notes.push(
        "  The new origin certificate is kept on this computer: the server keeps serving the current one until the move's finish deploys it.",
      );
    }
    return notes;
  };
}

/** The stop of a non-interactive run: the plan above waits for `--approve <hash>`. */
export function pendingStop(
  session: MoveSession,
  hash: string,
  flags: readonly string[] = [],
): StepStop {
  return {
    pendingPlanHash: hash,
    next: [
      `Review the plan above, then run \`${approveCommand(session.command, hash, flags)}\` to apply it and continue.`,
    ],
  };
}

/**
 * One Cloudflare plan of the move: nothing asked when it changes nothing (the record is written,
 * a waiting plan of its key forgotten); else shown, and applied after its approval when this run
 * applies it (interactive, or `--approve <hash>`), otherwise recorded as waiting and stopped (the
 * stop returned). A
 * removal asks with `allowDestroy`; it, and a plan deleting OpsCrew's rule, with the app's name
 * typed (`--confirm <app>` in scripts).
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
  const run = { app, command: session.command, phase: MOVE_PHASE } as const;
  if (plan.changes.length === 0) {
    await applyZonePlan(deps, input.client, input.zone, { ...run, planOnly: false });
    await clearPending(session.deps, input.key);
    return undefined;
  }
  // A removal's plan is not shown by the apply (a destroy shows it in its preview).
  if (input.allowDestroy === true) deps.reporter.info(details);
  const now = appliesNow(session, plan.hash);
  const result = await applyZonePlan(deps, input.client, input.zone, {
    ...run,
    planOnly: !now,
    ...(input.allowDestroy === true ? { allowDestroy: true } : {}),
    ...input.apply,
  });
  if (!now) {
    await writePending(session.deps, input.key, plan.hash);
    return pendingStop(session, plan.hash, result.deletes ? ["--confirm", app] : []);
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
 * @throws OpsCrewError `INTERNAL` when B's zone doesn't exist yet (the zone plan makes it first);
 * `PHASE_PRECONDITION` when B's record names a zone that is no longer there.
 */
export async function planBShared(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const deps = environmentDeps(session, environment);
  const { b } = session.accounts;
  const zone = await zoneIn(b.client, session.zone, b.accountId);
  if (zone === undefined) {
    throw bug(
      `The Cloudflare account the move goes to has no zone ${session.zone} yet, so its shared plan can't be made.`,
    );
  }
  const { plan } = environment;
  const recordPath = bSharedRecordPath(environment);
  const pending = zone.status !== "active";
  const record = await readCloudflareRecord(deps.paths, recordPath);
  if (record !== undefined && record.zoneId !== zone.id) {
    throw refusal(
      `OpsCrew's record of ${plan.app.name} in the account the move goes to (${recordPath}) names a zone that is no longer there.`,
      `Delete ${recordPath}, then run \`${session.command}\` again.`,
    );
  }
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
    // The app's own client certificate with per-hostname origin pulls (plan 4.4.1, 13b). Cloudflare
    // issues no Origin CA certificate for a pending zone, so the plan of B's pending zone asks for
    // none: B's comes at the move's finish, kept as `originTlsNext`.
    tls: { ...(tls === undefined ? {} : { tls: tls.desired }), minTls: true },
    notes: bNotes(tls, pending),
    client: b.client,
    recordPath,
    pendingZone: pending,
  });
  // B's zone given and its record of that zone: the shared plan is that zone's only.
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
 * The SHA-256 of the origin certificate the environment's origin serves now, read-only: over SSH
 * from the server's edge ({@link readServerEdge}), or, in the user's Portainer, the app's origin
 * certificate (`values`) when the app's stack holds this computer's values for it (their keyed
 * fingerprints, as provision's `stackServed` compares them). `undefined` when it can't be read.
 */
async function servedOriginSha256(
  session: MoveSession,
  deps: PhaseDeps,
  plan: DeployPlan,
  values: OriginTlsValues,
): Promise<string | undefined> {
  if (plan.target.provider !== "portainer") {
    const { remote } = session.services;
    return (await readServerEdge(deps, plan, remote === undefined ? {} : { remote }))?.served
      .originSha256;
  }
  const cert = values.ORIGIN_TLS_CERT;
  if (cert === undefined) return undefined;
  const connection = await requirePortainerConnection(deps, plan);
  const portainer = session.services.portainer ?? {};
  const valueKey = await ensurePortainerValueKey(deps, portainer.randomBytes);
  const client = portainerClientFor(deps, {
    connection,
    token: requirePortainerToken(deps),
    client: portainer.client,
    valueKey,
  });
  const facts = await portainerInspect(deps, client, { plan, phase: MOVE_PHASE })(
    "the origin certificate the app's stack serves",
  );
  const name = PORTAINER_STACK_VARIABLES.originTls;
  const held = recordedStack(connection, facts, "app")?.envFingerprints?.[name];
  const mine = valueFingerprint(valueKey, name, portainerOriginTls(values));
  return held !== undefined && held === mine ? fingerprintSha256(cert) : undefined;
}

/**
 * A's Origin CA certificate of the environment revoked with A's client (plan 7.7), with every one
 * it replaced that A still lists, as A's record names them ({@link aSharedRecordPath}), once the
 * origin shows it serves B's (the app's origin certificate since the finish's swap): a Cloudflare
 * plan with only those revocations, approved by its hash with `allowDestroy` and the app's name
 * typed. While the origin serves another (A's), or can't be read, nothing is planned and the run
 * stops, to come back after the deploy. A's rules, its client certificate and origin pull
 * settings are left to A's moved zone, which Cloudflare deletes; A's Zero Trust pieces are never
 * touched. Nothing is asked when A's record names no origin certificate, or A lists none of them.
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
  const listed = await a.client.listOriginCertificates(record.zoneId);
  const ids = [origin.id, ...origin.superseded];
  if (!listed.some((certificate) => ids.includes(certificate.id))) return undefined;
  const values = await readOriginTlsValues(deps);
  const cert = values.ORIGIN_TLS_CERT;
  const b = cert === undefined ? undefined : fingerprintSha256(cert);
  const served = await servedOriginSha256(session, deps, environment.plan, values);
  if (b === undefined || b === origin.sha256 || served !== b) {
    deps.reporter.info(
      "The server does not serve the new account's origin certificate yet (or OpsCrew could not read what it serves), so the certificate of the account the app moved from stays valid for now. Nothing in Cloudflare was changed.",
    );
    return {
      next: [
        `Once the deploy has brought the new origin certificate to the server, run \`${session.command}\` again.`,
      ],
    };
  }
  // Only the origin certificate: no rule, client certificate or setting of A's is read or planned.
  const only: SharedRecord = {
    zoneId: record.zoneId,
    hostnames: {},
    createdEntrypoints: [],
    tls: { origin },
  };
  const desired: SharedDesired = {
    hostnames: {},
    tls: { proxied: [], served: { originSha256: served, requiring: [] } },
  };
  const plan = planShared(
    {
      zoneId: record.zoneId,
      accountId: a.accountId,
      entrypoints: {},
      tls: { readAt: deps.clock.now().toISOString(), origin: listed, client: [], aop: [] },
    },
    desired,
    only,
  );
  const details = describeCloudflarePlan(plan, desired, session.zone, [
    "  It was issued in the Cloudflare account the app moved from; OpsCrew read just now that the server serves the new account's origin certificate.",
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
 * ({@link bSharedRecordPath}), as destroy's `planSharedRemoval` plans them with B's client in B's
 * zone: its hostnames off OpsCrew's rules there, B's client
 * certificate turned off and deleted, and B's Origin CA certificate revoked (B's edge never served
 * the app, so nothing waits for the server), approved by its hash with `allowDestroy` and the app's
 * name typed; then `originTlsNext` forgotten. The Zero Trust organization and login in B stay, as
 * OpsCrew never deletes them. When the zone the record names is gone from B, nothing of it is left
 * there and the record is deleted. Without a record, only `originTlsNext` is forgotten.
 */
export async function removeBShared(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const deps = environmentDeps(session, environment);
  const { b } = session.accounts;
  const recordPath = bSharedRecordPath(environment);
  const record = await readCloudflareRecord(deps.paths, recordPath);
  const zone = record === undefined ? undefined : await zoneIn(b.client, session.zone, b.accountId);
  if (record !== undefined && (zone === undefined || zone.id !== record.zoneId)) {
    await rm(recordPath, { force: true });
  } else if (zone !== undefined) {
    const removal = await planSharedRemoval(deps, environment.plan, {}, session.command, {
      client: b.client,
      accountId: b.accountId,
      zone: session.zone,
      recordPath,
      pendingZone: zone.status !== "active",
    });
    if (removal !== undefined) {
      const stop = await cloudflareStep(session, environment, {
        key: { action: "abort-shared", environment: environment.environment },
        client: b.client,
        zone: removal.zone,
        allowDestroy: true,
      });
      if (stop !== undefined) return stop;
    }
  }
  await forgetNextOriginTls(deps);
  return undefined;
}

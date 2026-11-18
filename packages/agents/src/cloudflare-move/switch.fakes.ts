/**
 * Test helpers for the switch: the move harness with this app prepared in New (its record at
 * `prepared`, its records and every app's mark in New's pending zone), the public DNS and HTTPS
 * from this computer, a clock the loop's `sleep` moves, and the registrars.
 */
import { CloudflareClient, OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import type { FakeCloudflareZone } from "@opscrew/connector-cloudflare/testing";
import type { DsRecord, FetchLike, RegisteredDomain } from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { vi } from "vitest";
import type { DomainServices } from "../domain";
import { DNS_OVER_HTTPS_URL } from "../shared";
import { connectApi, FakeRegistrar, type ScriptedApprovalHandler, SERVER_IPV4 } from "../testing";
import { appMark, type MoveMark, markContents, markName } from "./marks";
import { readSwitchProgress } from "./progress";
import {
  type MoveHarnessOptions,
  moveHarness,
  recordedMove,
  serverPlan,
  ZONE,
} from "./session.fakes";
import { switchMove } from "./switch";
import type { MoveServices, SwitchMoveOptions } from "./types";
import { MARK_COMMENT } from "./zone";

/** The other apps of the zone, prepared from their own repositories. */
export const BLOG: MoveMark = {
  app: "blog",
  envs: ["prod"],
  hosts: [`blog.${ZONE}`],
  sites: [],
  access: [],
};
export const DOCS: MoveMark = {
  app: "docs",
  envs: ["prod"],
  hosts: [`docs.${ZONE}`],
  sites: [{ worker: "docs", domains: [`docs.${ZONE}`] }],
  access: [],
};
/** An own server in tunnel mode with Portainer on a subdomain, both behind Access. */
export const OPS: MoveMark = {
  app: "ops",
  envs: ["prod"],
  hosts: [`ops.${ZONE}`, `ssh-ops.${ZONE}`, `portainer.ops.${ZONE}`],
  sites: [],
  access: [
    { hostname: `ssh-ops.${ZONE}`, kind: "service", environment: "prod" },
    { hostname: `portainer.ops.${ZONE}`, kind: "portainer", environment: "prod" },
  ],
};

/** The fake's start: 2026-11-21 09:00 UTC. */
const START = Date.parse("2026-11-21T09:00:00.000Z");

export interface SwitchHarnessOptions extends MoveHarnessOptions {
  /** The registry published a DS record when the move started. */
  dsAtStart?: boolean;
  /** The record's step (default `prepared`). */
  step?: "started" | "prepared";
  /** The other apps' marks (default blog's and docs'). */
  marks?: MoveMark[];
  /** Where the zone is registered: Porkbun (default) or Namecheap, Cloudflare Registrar in A, or elsewhere. */
  registrar?: "porkbun" | "namecheap" | "cloudflare" | "other";
}

/** A Cloudflare Registrar registration, as `getRegistration` answers it. */
const registration = (domain: string): RegisteredDomain => ({
  domain,
  registrar: "cloudflare",
  autoRenew: true,
});

/**
 * The switch's harness: {@link moveHarness} with New's pending zone, this app's record at
 * `prepared` (or `step`), its record and the other apps' records and marks in New, New's Worker
 * `docs`, and the zone registered at `registrar`. `web` is the public DNS (NS and DS) and each
 * hostname's HTTPS status; `registry.ns` the registry's RDAP nameservers (unreadable by default);
 * `time.ms` is the clock `sleep` moves, `onSleep` runs at each sleep, and New's zone becomes
 * active at a sleep once the delegation names its nameservers (unless `activation.auto` is false).
 */
export async function switchHarness(o: SwitchHarnessOptions = {}) {
  const h = await moveHarness({
    bZone: true,
    plans: (cloudflare) => {
      const plan = recordedMove(serverPlan(), cloudflare);
      const move = plan.cloudflareMove as NonNullable<DeployPlan["cloudflareMove"]>;
      return {
        prod: DeployPlanSchema.parse({
          ...plan,
          cloudflareMove: {
            ...move,
            to: { ...move.to, zoneId: cloudflare.zone(ZONE, "New").id },
            dsAtStart: o.dsAtStart ?? false,
            step: o.step ?? "prepared",
            ...(o.step === "started" ? {} : { preparedAt: "2026-11-20T11:00:00.000Z" }),
          },
        }),
      };
    },
    ...o,
  });
  const { cloudflare } = h;
  const aZone = cloudflare.zone(ZONE, "Old");
  const bZone = cloudflare.zone(ZONE, "New");
  const b = cloudflare.account("New");
  const managed = { proxied: true, comment: OPSCREW_MANAGED_COMMENT };
  for (const name of [`shop.${ZONE}`, `blog.${ZONE}`]) {
    cloudflare.addRecord(bZone, { type: "A", name, content: SERVER_IPV4, ...managed });
  }
  b.workers.set("docs", {});
  const session = await h.open();
  const marks = [
    { name: await markName(session), mark: await appMark(session) },
    ...(o.marks ?? [BLOG, DOCS]).map((mark) => ({
      name: `_opscrew-move.${mark.app}-0123abcd.${ZONE}`,
      mark,
    })),
  ];
  for (const { name, mark } of marks) {
    for (const content of markContents(mark)) {
      cloudflare.addRecord(bZone, { type: "TXT", name, content, comment: MARK_COMMENT });
    }
  }

  const time = { ms: 0 };
  h.deps.clock.now = () => new Date(START + time.ms);
  cloudflare.now = new Date(START);
  const web = {
    /** The delegation the public DNS shows (default A's). */
    ns: [...aZone.nameServers],
    ds: [] as DsRecord[],
    dsTtl: 3600,
    /** HTTPS status by hostname (default 200). */
    status: new Map<string, number>(),
    probes: [] as string[],
  };
  const events: string[] = [];
  const kind = o.registrar ?? "porkbun";
  const viaApi = kind === "porkbun" || kind === "namecheap";
  /** The Porkbun or Namecheap account that holds the zone (Porkbun's for the other registrars). */
  const api = new FakeRegistrar(kind === "namecheap" ? "namecheap" : "porkbun", events);
  api.own(ZONE);
  api.nameservers.set(ZONE, [...aZone.nameServers]);
  /** The account Cloudflare Registrar holds the zone in, for the `cloudflare` registrar. */
  const holder = { accountId: o.registrar === "cloudflare" ? aZone.accountId : undefined };
  vi.spyOn(CloudflareClient.prototype, "getRegistration").mockImplementation(
    async (accountId, domain) =>
      accountId === holder.accountId && domain === ZONE ? registration(ZONE) : undefined,
  );
  const registrars: DomainServices = {
    registrars: viaApi ? { [api.id]: connectApi(api, events) } : {},
  };

  /** The registry's RDAP record (`deps.registryNs`): its nameservers, or unreadable (default). */
  const registry = { ns: undefined as string[] | undefined };
  h.deps.registryNs = async (domain) => (domain === ZONE ? registry.ns : undefined);
  /** The delegation now: the registry's, else the API registrar's, else the public DNS's. */
  const delegation = () => registry.ns ?? (viaApi ? (api.nameservers.get(ZONE) ?? []) : web.ns);
  /** False keeps New's zone pending whatever the delegation (Cloudflare's checks miss it). */
  const activation = { auto: true };
  const sleeps = { count: 0, onSleep: undefined as (() => void) | undefined };
  const sleep = async (ms: number) => {
    sleeps.count++;
    time.ms += ms;
    cloudflare.now = new Date(START + time.ms);
    // Cloudflare sees New's nameservers at the registry: New's zone is active.
    const pointed = [...delegation()].sort().join() === [...bZone.nameServers].sort().join();
    if (activation.auto && pointed && bZone.status === "pending") cloudflare.activate(bZone);
    sleeps.onSleep?.();
  };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` === DNS_OVER_HTTPS_URL) {
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type");
      const answer =
        type === "NS"
          ? web.ns.map((ns) => ({ name: `${name}.`, type: 2, TTL: 300, data: `${ns}.` }))
          : web.ds.map((r) => ({
              name: `${name}.`,
              type: 43,
              TTL: web.dsTtl,
              data: `${r.keyTag} ${r.algorithm} ${r.digestType} ${r.digest}`,
            }));
      return Response.json({ Status: 0, ...(answer.length > 0 ? { Answer: answer } : {}) });
    }
    if (url.hostname.endsWith(ZONE)) {
      web.probes.push(url.hostname);
      return new Response("ok", { status: web.status.get(url.hostname) ?? 200 });
    }
    return base(input, init);
  };
  const base = h.deps.fetch;
  h.deps.fetch = fetch;
  const services: MoveServices = {
    ...h.services,
    registrars,
    fetch,
    sleep,
    now: () => time.ms,
  };
  const run = (options: Partial<SwitchMoveOptions> = {}) =>
    switchMove(h.deps, { services, ...options });
  const asked = () => (h.deps.approvalHandler as ScriptedApprovalHandler).requests;
  /** The non-GET calls made with each account's token, by account name. */
  const writes = (account: "Old" | "New") =>
    cloudflare.calls.filter(
      (call) => call.method !== "GET" && call.accountId === cloudflare.account(account).id,
    );
  return {
    ...h,
    aZone,
    bZone: bZone as FakeCloudflareZone,
    b,
    web,
    registry,
    activation,
    time,
    sleeps,
    api,
    events,
    holder,
    services,
    run,
    asked,
    writes,
    marks,
    progress: () => readSwitchProgress(h.deps.paths),
  };
}

export type SwitchHarness = Awaited<ReturnType<typeof switchHarness>>;

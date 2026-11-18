/**
 * Test helpers for a server at home in a move of {@link ZONE} from Old to New: the app's plan at
 * home behind Cloudflare's proxy, its address updater's records in Old's zone (and copies of them
 * in New's), a fake server at home whose updater keeps the records in Old's zone with Old's
 * updater token, and the finish's session after the switch with New's updater token.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import type {
  FakeCloudflareAccounts,
  FakeCloudflarePermission,
  FakeCloudflareZone,
} from "@opscrew/connector-cloudflare/testing";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { UPDATER_RECORD_COMMENT } from "../home/records";
import { recordOwnServer } from "../shared";
import {
  ED25519_FINGERPRINT,
  FakeHostServer,
  FakeRunnerGitHub,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  homeNetworkFacts,
  LAN_IPV4,
  ownPlan,
  ownRunner,
} from "../testing";
import { appWorld } from "./finish.fakes";
import { unencrypted, ZONE } from "./session.fakes";
import { B_UPDATER_TOKEN_VAR } from "./texts";

/** The app's name the updater keeps. */
export const HOME_NAME = `shop.${ZONE}`;
/** Old's and New's address updater tokens (each limited to its zone's DNS). */
export const A_UPDATER = fakeSecret("cloudflare-token", "a-updater");
export const B_UPDATER = fakeSecret("cloudflare-token", "b-updater");
/** The networks that may reach SSH at home. */
const SSH_FROM = ["192.168.1.0/24", "fe80::/10"];

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Every permission the fake knows but the zone's DNS: the updater's token as the recipe makes it. */
export const ALL_BUT_DNS: FakeCloudflarePermission[] = [
  "zone",
  "ssl",
  "settings",
  "http_config_settings",
  "http_request_firewall_custom",
  "http_request_dynamic_redirect",
  "page-rules",
  "email-routing",
  "tunnel",
  "access-apps",
  "access-service-tokens",
  "access-organization",
  "r2",
  "workers",
  "pages",
  "turnstile",
  "web-analytics",
];

/** `shop` deployed on a server at home behind Cloudflare's proxy over IPv4, by its own runner. */
export function homePlan(): DeployPlan {
  const base = ownPlan({ proxied: true, deployed: true });
  return unencrypted(
    DeployPlanSchema.parse({
      ...base,
      target: { ...base.target, home: { ipv4: true } },
      security: { ...base.security, httpAllowedFrom: "cloudflare" },
      environment: { runner: "server" },
    }),
  );
}

/**
 * The address updater's records at {@link HOME_NAME} in `zone`: its A (with `ipv4`) and, with
 * `ipv6`, its AAAA, proxied. The harness's OpsCrew record there (a cloud server's) is taken out:
 * a home root makes none.
 */
export function updaterRecords(
  cloudflare: FakeCloudflareAccounts,
  zone: FakeCloudflareZone,
  addresses: { ipv4?: string; ipv6?: string; name?: string } = {},
) {
  const name = addresses.name ?? HOME_NAME;
  const root = zone.records.findIndex(
    (record) => record.name === name && record.comment === OPSCREW_MANAGED_COMMENT,
  );
  if (root !== -1) zone.records.splice(root, 1);
  const own = { name, proxied: true, ttl: 1, comment: UPDATER_RECORD_COMMENT };
  return {
    a: cloudflare.addRecord(zone, { type: "A", content: addresses.ipv4 ?? HOME_IPV4, ...own }),
    ...(addresses.ipv6 === undefined
      ? {}
      : { aaaa: cloudflare.addRecord(zone, { type: "AAAA", content: addresses.ipv6, ...own }) }),
  };
}

/**
 * The fake server at home whose address updater runs as the facts say; an applied `dns-updater`
 * step leaves its config and its token's SHA-256 as the step names them.
 */
export class HomeHost extends FakeHostServer {
  override async apply(
    remote: RemoteExec,
    plan: HostPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> {
    const result = await super.apply(remote, plan, options);
    const step = plan.steps.find((one) => one.id === "dns-updater" && one.state === "change");
    if (step === undefined) return result;
    const { app, zoneId, name, proxied, ipv4, ipv6, tokenSha256 } = step.params;
    this.facts = HostFactsSchema.parse({
      ...this.facts,
      dnsUpdaters: (this.facts.dnsUpdaters ?? []).map((updater) =>
        updater.app !== app
          ? updater
          : {
              ...updater,
              config: { schemaVersion: 1, app, zoneId, name, proxied, ipv4, ipv6 },
              token: { ...updater.token, sha256: tokenSha256 ?? updater.token.sha256 },
            },
      ),
    });
    return result;
  }
}

/** A server at home on {@link LAN_IPV4}, its updater keeping {@link HOME_NAME} in `zoneId`. */
export function homeFacts(zoneId: string): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({
      addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
    }),
    sshClient: { address: "192.168.1.10", port: 50022 },
    sshFirewall: { nft: true, table: null, files: { rules: null, unit: null }, enabled: false },
    dnsUpdaters: [
      {
        app: "shop",
        config: {
          schemaVersion: 1,
          app: "shop",
          zoneId,
          name: HOME_NAME,
          proxied: true,
          ipv4: true,
          ipv6: false,
        },
        configFile: { mode: "600", owner: "root" },
        token: { present: true, mode: "600", owner: "root", sha256: sha256(A_UPDATER) },
        timer: { enabled: true, active: true },
        state: null,
      },
    ],
  });
}

/** Every file under `dir`, with its text. */
async function filesUnder(dir: string): Promise<string> {
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  const texts = await Promise.all(
    names.map((name) => readFile(join(dir, name), "utf8").catch(() => "")),
  );
  return texts.join("\n");
}

/**
 * The finish of the app at home after the switch ({@link appWorld}: prepared, New's zone active,
 * an interactive session granting every approval): its updater records in Old's zone, the server
 * recorded with its home network and its updater on Old's zone, New's updater token in
 * `OPSCREW_NEW_DNS_UPDATER_TOKEN` (`o.token`: another value, or `null` for none) and known to the
 * fake as limited to New's zone's DNS. `o.plan`: the app's plan at home (default
 * {@link homePlan}).
 */
export async function homeFinishWorld(o: { token?: string | null; plan?: DeployPlan } = {}) {
  const w = await appWorld({ prod: o.plan ?? homePlan() });
  const aZone = w.cloudflare.zone(ZONE, "Old");
  updaterRecords(w.cloudflare, aZone);
  for (const [token, account] of [
    [A_UPDATER, w.cloudflare.account("Old").id],
    [B_UPDATER, w.fresh.id],
  ] as const) {
    w.cloudflare.tokens.set(token, { accounts: [account], denied: new Set(ALL_BUT_DNS) });
  }
  const env = w.session.deps.env;
  delete env[B_UPDATER_TOKEN_VAR];
  if (o.token !== null) env[B_UPDATER_TOKEN_VAR] = o.token ?? B_UPDATER;
  const environment = w.environmentOf("prod");
  await recordOwnServer(environment.paths, {
    host: LAN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    hostKey: ED25519_FINGERPRINT,
    serve: "proxy",
    home: { sshFrom: SSH_FROM },
  });
  const host = new HomeHost(homeFacts(aZone.id));
  host.homeNetwork = homeNetworkFacts();
  const runnerGitHub = new FakeRunnerGitHub();
  const asked: { zone: string; prompt: string }[] = [];
  w.session.deps.runner = ownRunner();
  w.session.services = {
    ...w.session.services,
    own: { host, homeDir: await mkdtemp(join(tmpdir(), "opscrew-move-home-")) },
    runnerGitHub,
    sleep: async () => undefined,
  };
  /** The place of each of `values` found where the run's fakes saw or left it (stdin aside). */
  const leaksOf = async (values: readonly string[], ...texts: string[]) => {
    const places: [string, string][] = [
      ["texts", texts.join("\n")],
      // The session's deps share the harness's reporter and audit log.
      ["output", w.deps.reporter.text()],
      ["audit", JSON.stringify(w.deps.audit.entries)],
      ["approvals", JSON.stringify(w.handler.requests)],
      ["questions", JSON.stringify(asked)],
      [".opscrew", await filesUnder(join(w.root, ".opscrew"))],
      ["opscrew", await filesUnder(join(w.root, "opscrew"))],
      ["home folder", await filesUnder(join(w.root, ".home-opscrew"))],
      ["host plans", JSON.stringify(host.applies.map((apply) => apply.plan))],
      ["Cloudflare calls", JSON.stringify(w.cloudflare.calls)],
      ["runner GitHub calls", JSON.stringify(runnerGitHub.calls)],
      ["engine", JSON.stringify([w.engine.planOptions, w.engine.calls])],
    ];
    return values.flatMap((value) =>
      places.filter(([, text]) => text.includes(value)).map(([where]) => `${value} in ${where}`),
    );
  };
  /** Every token of the run and the home's addresses (a proxied app's: secret-shaped). */
  const secrets = [B_UPDATER, A_UPDATER, HOME_IPV4, HOME_IPV6, ...Object.values(w.tokens)];
  return { ...w, aZone, environment, host, runnerGitHub, asked, leaksOf, secrets };
}

export type HomeFinishWorld = Awaited<ReturnType<typeof homeFinishWorld>>;

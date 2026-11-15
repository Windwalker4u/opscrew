/**
 * Test helpers: a git project whose app is served in `example.com`, held by the account Old, with
 * the two-account Cloudflare fake (one token per account) for a move to the account New.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import {
  type FakeCloudflareAccounts,
  type FakeCloudflarePermission,
  type FakeZoneStatus,
  fakeCloudflareAccounts,
} from "@opscrew/connector-cloudflare/testing";
import { tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { appPlan } from "../apps/__fixtures__/sites";
import { environmentPaths } from "../environments/paths";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  projectRunner,
  SERVER_IPV4,
  SiteGitHub,
  testPlan,
} from "../testing";
import { type OpenMoveSessionOptions, openMoveSession } from "./session";
import { MOVE_COMMAND } from "./texts";
import type { MoveServices } from "./types";

/** The zone that moves, and another zone of Old's. */
export const ZONE = "example.com";
export const OTHER_ZONE = "example.org";
/** A zone only Stale holds. */
export const STALE_ZONE = "example.net";

/** `plan` with its state unencrypted, so no passphrase is needed. */
export function unencrypted(plan: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, infra: { ...plan.infra, stateEncryption: false } });
}

/** A deployed Hetzner plan at `domain` behind Cloudflare, for environment `env` (prod: none). */
export function serverPlan(domain = `shop.${ZONE}`, env?: string, deployed = true): DeployPlan {
  return appPlan(undefined, env, unencrypted(testPlan({ domain, deployed })));
}

/** `plan` with the move's record of {@link ZONE} from Old to `to`. */
export function recordedMove(
  plan: DeployPlan,
  cloudflare: FakeCloudflareAccounts,
  to = "New",
): DeployPlan {
  const a = cloudflare.zone(ZONE, "Old");
  return DeployPlanSchema.parse({
    ...plan,
    cloudflareMove: {
      zone: ZONE,
      from: { accountId: a.accountId, zoneId: a.id },
      to: { accountId: cloudflare.account(to).id },
      dsAtStart: false,
      step: "started",
      startedAt: "2026-11-20T10:00:00.000Z",
    },
  });
}

export interface MoveHarnessOptions {
  /** The app's plans by environment (prod's first); default prod's {@link serverPlan}. */
  plans?: (cloudflare: FakeCloudflareAccounts) => Record<string, DeployPlan>;
  /** Further apps' plans by key (prod only). */
  apps?: (cloudflare: FakeCloudflareAccounts) => Record<string, DeployPlan>;
  /** New has the zone already (pending). */
  bZone?: boolean;
  /** What New's token may not do. */
  bDenied?: FakeCloudflarePermission[];
  /** The zone's status in Old (default active). */
  aStatus?: FakeZoneStatus;
  /** Variables replaced in the environment (`undefined` removes one). */
  env?: Record<string, string | undefined>;
  /** Files of the repository, by path. */
  files?: Record<string, string>;
  /** Deployed environments whose infrastructure state is not on this computer. */
  noState?: string[];
  /** A's token also reaches Stale, listed first, with a pending copy of the zone. */
  stale?: boolean;
}

/**
 * The accounts Old (holding {@link ZONE} and {@link OTHER_ZONE}) and New, with Spare reached by
 * New's token too; in Old's zone this app's record, another app's record and Worker custom domain,
 * and a user's record. The app's plans are written into a git project.
 */
export async function moveHarness(o: MoveHarnessOptions = {}) {
  const tokens = {
    a: fakeSecret("cloudflare-token", "account-a"),
    b: fakeSecret("cloudflare-token", "account-b"),
  };
  const cloudflare = fakeCloudflareAccounts({
    accounts: [
      ...(o.stale ? [{ name: "Stale", token: tokens.a }] : []),
      { name: "Old", token: tokens.a },
      { name: "New", token: tokens.b, ...(o.bDenied ? { denied: o.bDenied } : {}) },
      { name: "Spare", token: tokens.b },
    ],
    zones: [
      { name: ZONE, account: "Old", ...(o.aStatus ? { status: o.aStatus } : {}) },
      { name: OTHER_ZONE, account: "Old" },
      ...(o.bZone ? [{ name: ZONE, account: "New", status: "pending" as const }] : []),
      ...(o.stale
        ? [
            { name: ZONE, account: "Stale", status: "pending" as const },
            { name: STALE_ZONE, account: "Stale" },
          ]
        : []),
    ],
  });
  const zone = cloudflare.zone(ZONE, "Old");
  const managed = { proxied: true, comment: OPSCREW_MANAGED_COMMENT };
  cloudflare.addRecord(zone, { type: "A", name: `shop.${ZONE}`, content: SERVER_IPV4, ...managed });
  cloudflare.addRecord(zone, { type: "A", name: `blog.${ZONE}`, content: SERVER_IPV4, ...managed });
  cloudflare.addRecord(zone, { type: "MX", name: ZONE, content: `mail.${ZONE}`, priority: 10 });
  cloudflare.account("Old").workerDomains.push({
    id: "docs-domain",
    hostname: `docs.${ZONE}`,
    service: "docs",
    zone_id: zone.id,
    zone_name: ZONE,
  });
  const plans = o.plans?.(cloudflare) ?? { prod: serverPlan() };
  const { prod, ...others } = plans;
  const project = await createProject(prod);
  const { root } = project;
  for (const [name, plan] of Object.entries(others)) {
    await writeArtifact("plan", join(root, "opscrew", "environments", name, "plan.yaml"), plan);
  }
  for (const [key, plan] of Object.entries(o.apps?.(cloudflare) ?? {})) {
    const dir = join(root, "opscrew", "apps", key);
    await writeArtifact("app", join(dir, "app.yaml"), { schemaVersion: 1, dir: "." });
    await writeArtifact("plan", join(dir, "plan.yaml"), plan);
  }
  for (const [path, content] of Object.entries(o.files ?? {})) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const env: Record<string, string | undefined> = {
    OPSCREW_HOME: join(root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: tokens.a,
    OPSCREW_NEW_CLOUDFLARE_API_TOKEN: tokens.b,
    ...o.env,
  };
  const deps = await createTestPhaseDeps({
    root,
    env,
    fetch: cloudflare.fetch,
    runner: projectRunner(),
  });
  // Each deployed environment's infrastructure state, as provision leaves it.
  for (const [name, plan] of Object.entries(plans)) {
    if (plan.deployment.lastApplyAt === undefined || o.noState?.includes(name)) continue;
    const file = tfstateFile(environmentPaths(deps.paths, name));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"version":4}\n');
  }
  const github = new SiteGitHub();
  const engine = new FakeEngine();
  const services: MoveServices = { github, engine: async () => engine };
  const open = (options: Partial<OpenMoveSessionOptions> = {}) =>
    openMoveSession(deps, { command: MOVE_COMMAND, services, ...options });
  /** True when anything said, recorded or sent holds a token, or a server's address is said. */
  const leaks = (...texts: string[]) => {
    const said = [...texts, deps.reporter.text(), JSON.stringify(deps.audit.entries)].join("\n");
    const sent = JSON.stringify(cloudflare.calls);
    return (
      [tokens.a, tokens.b].some((token) => said.includes(token) || sent.includes(token)) ||
      said.includes(SERVER_IPV4)
    );
  };
  /** True when no call to Cloudflare changed anything. */
  const readOnly = () => cloudflare.calls.every((call) => call.method === "GET");
  return { ...project, tokens, cloudflare, deps, github, engine, services, open, leaks, readOnly };
}

export type MoveHarness = Awaited<ReturnType<typeof moveHarness>>;

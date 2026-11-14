/**
 * Test helpers for the shadow states: a fake engine whose states are JSON files of addresses, and
 * the move harness (two accounts, one token each) with each root's committed
 * `terraform.tfvars.json` holding A's ids.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IacInitOptions, IacRunOptions } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import { FakeEngine, type FakeEngineScenario } from "../testing";
import {
  type MoveHarness,
  type MoveHarnessOptions,
  moveHarness,
  serverPlan,
  ZONE,
} from "./session.fakes";
import type { MoveSession } from "./types";

/** The data folder an engine command uses: `TF_DATA_DIR`, else the root's `.terraform`. */
function dataDirOf(dir: string, env: IacRunOptions["env"]): string {
  return env?.TF_DATA_DIR ?? join(dir, ".terraform");
}

/** A state file of the fake: the addresses it holds. */
export function addressState(addresses: readonly string[]): string {
  return `${JSON.stringify({ version: 4, addresses })}\n`;
}

/** The addresses in a state file of the fake (none in a state provision's fake left). */
export async function stateAddresses(file: string): Promise<string[]> {
  return (JSON.parse(await readFile(file, "utf8")) as { addresses?: string[] }).addresses ?? [];
}

/**
 * The fake engine with states that are files of addresses: `init` binds the data folder to its
 * backend path, `state list` reads a file, `state rm` and `import` change the state the command's
 * data folder is bound to. Every import is recorded with its options.
 */
export class StateFileEngine extends FakeEngine {
  readonly backends = new Map<string, string>();
  readonly importOptions: (IacRunOptions | undefined)[] = [];

  constructor(scenario: FakeEngineScenario = {}) {
    super(scenario);
  }

  override async init(dir: string, options?: IacInitOptions): Promise<void> {
    await super.init(dir, options);
    const path = options?.backendConfig?.path;
    if (path !== undefined) this.backends.set(dataDirOf(dir, options?.env), path);
  }

  override readonly stateResources = async (file: string): Promise<string[]> =>
    stateAddresses(file);

  /** The state the data folder of a command in `dir` is bound to. */
  bound(dir: string, env: IacRunOptions["env"]): string {
    const file = this.backends.get(dataDirOf(dir, env));
    if (file === undefined) throw new Error(`No init for ${dataDirOf(dir, env)}`);
    return file;
  }

  override async stateRemove(
    dir: string,
    addresses: readonly string[],
    options?: IacRunOptions,
  ): Promise<void> {
    const file = this.bound(dir, options?.env);
    const held = await stateAddresses(file);
    const missing = addresses.find((address) => !held.includes(address));
    if (missing !== undefined) throw new Error(`No matching objects found: ${missing}`);
    this.calls.push("state-rm");
    this.stateRemoveOptions.push(options);
    await writeFile(file, addressState(held.filter((address) => !addresses.includes(address))));
  }

  override async importResource(
    dir: string,
    address: string,
    id: string,
    options?: IacRunOptions,
  ): Promise<void> {
    await super.importResource(dir, address, id, options);
    this.importOptions.push(options);
    const file = this.bound(dir, options?.env);
    await writeFile(file, addressState([...(await stateAddresses(file)), address]));
  }
}

/** A Cloudflare record, a tunnel and an R2-like bucket, as addresses in a root's state. */
export const CLOUDFLARE_ADDRESSES = {
  record: `module.dns.cloudflare_dns_record.this["shop.${ZONE}"]`,
  certificates: "module.dns.cloudflare_certificate_pack.this",
  tunnel: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
  secret: "module.tunnel.random_password.secret",
} as const;

/** The server's resources in the main root's state. */
export const SERVER_ADDRESSES = [
  "module.server.hcloud_firewall.this",
  "module.server.hcloud_server.this",
  "tls_private_key.deploy",
] as const;

export interface ShadowHarnessOptions extends MoveHarnessOptions {
  /** The engine (default a {@link StateFileEngine} without a scenario). */
  engine?: FakeEngine;
  /** Extra values in each root's `terraform.tfvars.json` (by root folder, relative). */
  values?: Record<string, Record<string, unknown>>;
  /** Run as in a terminal. */
  interactive?: boolean;
}

/**
 * The move harness with B's zone pending, A's and B's one-time PIN logins, and for each root
 * folder in `values` a committed `terraform.tfvars.json` with A's zone and account ids (and the
 * PIN login's id when the folder's values name it); the session opened with `engine`.
 */
export async function shadowHarness(
  folders: (plans: Record<string, DeployPlan>) => string[],
  o: ShadowHarnessOptions = {},
): Promise<
  MoveHarness & { session: MoveSession; engine: FakeEngine; pins: { a: string; b: string } }
> {
  const h = await moveHarness({ bZone: true, ...o });
  const old = h.cloudflare.account("Old");
  const fresh = h.cloudflare.account("New");
  old.identityProviders.push({ id: "pin-of-old", name: "One-time PIN", type: "onetimepin" });
  fresh.identityProviders.push({ id: "pin-of-new", name: "One-time PIN", type: "onetimepin" });
  const zone = h.cloudflare.zone(ZONE, "Old");
  const plans = o.plans?.(h.cloudflare) ?? { prod: serverPlan() };
  for (const folder of folders(plans)) {
    const file = join(h.root, folder, "terraform.tfvars.json");
    await mkdir(dirname(file), { recursive: true });
    const values = {
      app: "shop",
      cloudflare_zone_id: zone.id,
      cloudflare_account_id: old.id,
      ...o.values?.[folder],
    };
    await writeFile(file, `${JSON.stringify(values, null, 2)}\n`);
  }
  const engine = o.engine ?? new StateFileEngine();
  if (o.interactive) h.deps.interactive = true;
  const session = await h.open({
    to: "New",
    services: { ...h.services, engine: async () => engine },
  });
  return { ...h, session, engine, pins: { a: "pin-of-old", b: "pin-of-new" } };
}

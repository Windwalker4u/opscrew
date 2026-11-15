/**
 * The live pass of feature 028 between its legs (docs/e2e.md "Moving to another Cloudflare
 * account"): each leg is its own vitest process, run hours or days after the one before, so the
 * pass keeps its state (`pass.json`), its apps' checkouts, every CLI output and every version of
 * the move's local files in its own folder under `OPSCREW_TEST_TMP`. A leg opens the pass, puts P's
 * and Q's runs back together from it, and saves everything again when it ends. Here also: both
 * accounts' inventories, the load, the probes, the move's commands as a script runs them, the
 * leak search and the cleanup of P's and Q's pieces only.
 */
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { join, relative } from "node:path";
import {
  NEW_STORAGE_KEY_VARS,
  OFFSITE_KEY_VARS,
  type ProviderBucket,
  publicNameservers,
} from "@opscrew/agents";
import { sshHostname } from "@opscrew/iac-templates";
import { backupsBucketOf, type DeployPlan } from "@opscrew/plan-schema";
import { afterAll, beforeAll, it } from "vitest";
import { Cloudflare, type CloudflareZone, minutes, retryDelete, sleep } from "./cloud";
import {
  type AccountPieces,
  type AppState,
  edgeAnswer,
  type Inventory,
  type ListedRecord,
  leakSearchValues,
  legOrderProblem,
  loadFigures,
  MASK_PREFIX,
  type MoveLeg,
  newPass,
  nextMoveCommand,
  nextSteps,
  type PassState,
  type ProbeSample,
  parsePass,
  passFolder,
  realAppHosts,
  recordAddresses,
  recordLine,
  unexpectedNames,
  withDowntime,
} from "./cloudflare-move-support";
import { r2KeyOfToken, storageKeyEnv } from "./components-support";
import { AppEnvironments } from "./environment-checks";
import {
  type LeakSource,
  LiveRun,
  leakSourcesOf,
  localLeakSources,
  serverSettings,
} from "./harness";
import { BackupsBucket } from "./snapshots-checks";
import {
  addressLinesOutsidePurpose,
  type LoadFailure,
  leakedLabels,
  requestFailure,
  steadyLoad,
} from "./support";

/** P: a bucket on R2, a Hetzner server OpsCrew makes, proxied with origin TLS. */
export const P_EXAMPLE = "s3-uploads";
/** Q: the user's own server in tunnel mode, its snapshots copied off to R2. */
export const Q_EXAMPLE = "flask-sqlite";

/** The variables OpsCrew reads B's buckets' keys from during a move. */
export const NEW_OFFSITE_KEY_VARS = {
  accessKeyId: "OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID",
  secretAccessKey: "OPSCREW_NEW_OFFSITE_SECRET_ACCESS_KEY",
} as const;

/** Requests a second to P's and Q's health routes, and to each real app's hostname. */
const PASS_RPS = 20;
const REAL_RPS = 1;
/** How often the probes ask. */
const PROBE_MS = 5_000;

/** A Cloudflare account's R2 key, from its token (the token's id and the SHA-256 of its value). */
interface R2Key {
  accessKeyId: string;
  secretAccessKey: string;
}

/** What a move's commands ended with: done, or a stop without a command to run next. */
export type MoveOutcome =
  | { kind: "done"; outputs: string[] }
  | { kind: "stopped"; steps: string[]; outputs: string[] };

/** What the pass reads from the environment. */
function moveSettings(env: Record<string, string | undefined>) {
  const server = serverSettings(env);
  return {
    ...server,
    tokenB: env.OPSCREW_E2E_MOVE_TOKEN_B?.trim() ?? "",
    accountB: env.OPSCREW_E2E_MOVE_ACCOUNT_B?.trim(),
    registrarEnv: Object.fromEntries(
      [
        "PORKBUN_API_KEY",
        "PORKBUN_SECRET_API_KEY",
        "NAMECHEAP_API_USER",
        "NAMECHEAP_API_KEY",
        "GODADDY_API_TOKEN",
      ].flatMap((name) => (env[name] ? [[name, env[name] as string]] : [])),
    ),
  };
}

/**
 * The pass in one leg's process: its state, P's and Q's runs (put back together from the state
 * after L1), both accounts' clients, the scrubber shared by everything printed.
 */
export class MovePass {
  readonly settings: ReturnType<typeof moveSettings>;
  readonly folder: string;
  readonly a: Cloudflare;
  readonly b: Cloudflare;
  readonly p: LiveRun;
  readonly q: LiveRun;
  readonly pEnvs: AppEnvironments;
  readonly qEnvs: AppEnvironments;
  /** The pass's state; set by {@link open} once L0 made it. */
  state: PassState | undefined;
  private r2: { a?: R2Key; b?: R2Key } = {};
  /** How many outputs of this process are saved already. */
  private savedOutputs = 0;
  /** The pass's folder was removed (L6's end): nothing is saved any more. */
  private removed = false;

  constructor(env: Record<string, string | undefined>) {
    this.settings = moveSettings(env);
    this.folder = env.OPSCREW_TEST_TMP?.trim() ? passFolder(env) : "";
    this.p = new LiveRun({
      label: "Cloudflare move, P",
      name: "move-cf",
      settings: { ...this.settings, app: P_EXAMPLE },
      afterCli: async () => {
        await this.keepMoveFiles(this.p);
        await this.pEnvs.rememberServers();
      },
    });
    this.q = this.p.second(Q_EXAMPLE, () => this.keepMoveFiles(this.q));
    this.pEnvs = new AppEnvironments(this.p, this.settings.hcloudToken, { restoreMain: true });
    this.qEnvs = new AppEnvironments(this.q, "");
    this.a = new Cloudflare(this.settings.cloudflareToken);
    this.b = new Cloudflare(this.settings.tokenB);
  }

  readonly log = (message: string) => this.p.log(message);

  get scrub(): (text: string) => string {
    return this.p.scrub;
  }

  /**
   * Masks `value` in everything printed under `mask-<label>`, never searched for by the leak
   * search; a value known already (a server's address, which is searched for) keeps its label.
   */
  mask(value: string, label: string): void {
    if (this.p.scrubber.entries().some((entry) => entry.value === value.trim())) return;
    this.p.scrubber.add(value, `${MASK_PREFIX}${label}`);
  }

  /** The pass's state, which L0 makes. */
  pass(): PassState {
    if (this.state === undefined) throw new Error("The pass has no state yet: run L0 first.");
    return this.state;
  }

  private file(name: string): string {
    return join(this.folder, name);
  }

  /**
   * Opens the pass in this process: reads `pass.json` and the values masked so far, adds the
   * tokens, and puts P's and Q's runs back together from what L1 recorded.
   */
  async open(): Promise<void> {
    await mkdir(join(this.folder, "outputs"), { recursive: true });
    await mkdir(join(this.folder, "kept"), { recursive: true });
    const { scrubber } = this.p;
    scrubber.add(this.settings.tokenB, "cloudflare-token-b");
    if (existsSync(this.file("known.json"))) {
      const known = JSON.parse(await readFile(this.file("known.json"), "utf8")) as {
        label: string;
        value: string;
      }[];
      for (const { label, value } of known) scrubber.add(value, label);
    }
    if (existsSync(this.file("pass.json"))) {
      this.state = parsePass(await readFile(this.file("pass.json"), "utf8"));
    }
    const apps = this.state?.apps ?? {};
    if (apps.p !== undefined) await this.restore(this.p, this.pEnvs, apps.p);
    if (apps.q !== undefined) await this.restore(this.q, this.qEnvs, apps.q);
  }

  /** Saves the state, the values masked so far and this process's new CLI outputs. */
  async save(): Promise<void> {
    if (this.folder === "" || this.removed) return;
    await mkdir(join(this.folder, "outputs"), { recursive: true });
    if (this.state !== undefined) {
      await writeFile(this.file("pass.json"), `${JSON.stringify(this.state, null, 2)}\n`);
    }
    await writeFile(this.file("known.json"), JSON.stringify(this.p.scrubber.entries()), {
      mode: 0o600,
    });
    const outputs = [...this.p.outputs];
    const stamp = Date.now().toString(36);
    for (const [index, [label, output]] of outputs.entries()) {
      if (index < this.savedOutputs) continue;
      await writeFile(
        join(this.folder, "outputs", `${stamp}-${String(index).padStart(3, "0")}.txt`),
        `${label}\n${output}`,
        { mode: 0o600 },
      );
    }
    this.savedOutputs = outputs.length;
  }

  /** Starts a new pass (L0), or keeps the one there (L0 run again). */
  startPass(accounts: PassState["accounts"]): PassState {
    this.state ??= newPass(this.p.runId, accounts, new Date());
    this.state.accounts = accounts;
    return this.state;
  }

  // -------------------------------------------------------------------------------------------
  // P and Q between legs.

  /**
   * Runs `body` with this process's temporary folder pointed at the pass's folder, so what
   * `prepareRepo` makes there (the checkout, the keys, OpsCrew's home) outlasts the leg.
   */
  async inPassFolder<T>(body: () => Promise<T>): Promise<T> {
    const names = ["TMPDIR", "TEMP", "TMP"] as const;
    const before = names.map((name) => process.env[name]);
    for (const name of names) process.env[name] = this.folder;
    try {
      return await body();
    } finally {
      names.forEach((name, at) => {
        if (before[at] === undefined) delete process.env[name];
        else process.env[name] = before[at];
      });
    }
  }

  /**
   * What L1 records of `which` as soon as there is something to clean up (the checkout, then its
   * server, then its app's name), and what it seeded.
   */
  async record(which: "p" | "q", extra: Partial<AppState> = {}): Promise<void> {
    const run = which === "p" ? this.p : this.q;
    const pass = this.pass();
    pass.apps[which] = {
      ...pass.apps[which],
      work: run.work,
      repo: run.repo,
      keyFile: run.keyFile,
      knownHostsFile: run.knownHostsFile,
      exampleCommit: run.exampleCommit,
      ...(run.appName === undefined ? {} : { appName: run.appName }),
      hostname: run.appHost,
      ...(run.server === undefined ? {} : { server: run.server }),
      ...extra,
    };
    await this.save();
  }

  /** The app's recorded state. */
  app(which: "p" | "q"): AppState {
    const app = this.pass().apps[which];
    if (app === undefined) throw new Error(`L1 recorded no ${which.toUpperCase()}: run L1 first.`);
    return app;
  }

  /** Puts `run` back together from `app`: its checkout, keys, environment and masked values. */
  private async restore(run: LiveRun, envs: AppEnvironments, app: AppState): Promise<void> {
    run.work = app.work;
    run.repo = app.repo;
    run.keyFile = app.keyFile;
    run.knownHostsFile = app.knownHostsFile;
    run.exampleCommit = app.exampleCommit;
    if (app.appName !== undefined) run.appName = app.appName;
    run.repoReady = true;
    run.server = app.server;
    run.env = await this.cliEnv(run, app);
    if (app.appName !== undefined) envs.apps.set("prod", app.appName);
    envs.provisioned.add("prod");
    if (app.destroyed === true) envs.destroyed.add("prod");
  }

  /**
   * The CLI's environment for `run`, as `prepareRepo` makes it (`CI=1`, the run's OpsCrew home,
   * the GitHub token; never an `OPSCREW_E2E_*` variable or an SSH agent), with {@link accountEnv}.
   */
  async cliEnv(
    run: LiveRun,
    app?: Pick<AppState, "moved">,
  ): Promise<Record<string, string | undefined>> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of [
      "HCLOUD_TOKEN",
      "DIGITALOCEAN_TOKEN",
      "DIGITALOCEAN_ACCESS_TOKEN",
      "SSH_AUTH_SOCK",
    ]) {
      delete env[name];
    }
    for (const name of Object.keys(env)) if (name.startsWith("OPSCREW_E2E_")) delete env[name];
    return {
      ...env,
      CI: "1",
      OPSCREW_HOME: join(run.work, "home"),
      GITHUB_TOKEN: this.settings.githubToken,
      OPSCREW_APP_ENV_FILE: join(run.work, "production.env"),
      ...(await this.accountEnv(app)),
    };
  }

  /**
   * Hetzner's token and the zone's account: A's token and R2 key with B's as the move's while
   * `app` isn't moved, B's alone once it is.
   */
  async accountEnv(app?: Pick<AppState, "moved">): Promise<Record<string, string>> {
    const { a, b } = await this.r2Keys();
    const moved = app?.moved === true;
    const own = moved ? b : a;
    return {
      HCLOUD_TOKEN: this.settings.hcloudToken,
      CLOUDFLARE_API_TOKEN: moved ? this.settings.tokenB : this.settings.cloudflareToken,
      ...storageKeyEnv(own),
      [OFFSITE_KEY_VARS.accessKeyId]: own.accessKeyId,
      [OFFSITE_KEY_VARS.secretAccessKey]: own.secretAccessKey,
      ...(moved
        ? {}
        : {
            OPSCREW_NEW_CLOUDFLARE_API_TOKEN: this.settings.tokenB,
            [NEW_STORAGE_KEY_VARS.accessKeyId]: b.accessKeyId,
            [NEW_STORAGE_KEY_VARS.secretAccessKey]: b.secretAccessKey,
            [NEW_OFFSITE_KEY_VARS.accessKeyId]: b.accessKeyId,
            [NEW_OFFSITE_KEY_VARS.secretAccessKey]: b.secretAccessKey,
          }),
    };
  }

  /** Each account's R2 key, from its token, masked under labels of their own. */
  async r2Keys(): Promise<{ a: R2Key; b: R2Key }> {
    const { accounts } = this.pass();
    this.r2.a ??= r2KeyOfToken(await tokenId(this.a, accounts.a), this.settings.cloudflareToken);
    this.r2.b ??= r2KeyOfToken(await tokenId(this.b, accounts.b), this.settings.tokenB);
    for (const [side, key] of Object.entries(this.r2) as ["a" | "b", R2Key][]) {
      this.p.scrubber.add(key.accessKeyId, `r2-key-id-${side}`);
      this.p.scrubber.add(key.secretAccessKey, `r2-secret-${side}`);
    }
    return { a: this.r2.a, b: this.r2.b };
  }

  /** P's or Q's app moved to B: its commands use B's token and keys from now on. */
  async markMoved(which: "p" | "q"): Promise<void> {
    const app = this.app(which);
    app.moved = true;
    const run = which === "p" ? this.p : this.q;
    run.env = await this.cliEnv(run, app);
    await this.save();
  }

  /** The app's health URL on its recorded hostname. */
  async healthUrl(which: "p" | "q"): Promise<string> {
    const run = which === "p" ? this.p : this.q;
    return `https://${this.app(which).hostname}${(await run.readPlan()).app.healthPath}`;
  }

  /**
   * After every CLI run: each version of the move's local files (`<state folder>/cloudflare-move/`,
   * the saved plans, `.opscrew/cloudflare.json`) kept in the pass's folder, since a finish or an
   * abort deletes them; the leak search reads every version.
   */
  private async keepMoveFiles(run: LiveRun): Promise<void> {
    if (run.repo === "" || this.folder === "") return;
    const paths = run.paths();
    const files = [
      ...(await textFiles(join(paths.stateDir, "cloudflare-move"))),
      ...(await textFiles(paths.files.plansDir)),
      paths.files.cloudflareRecord,
    ];
    for (const file of files) {
      if (!existsSync(file)) continue;
      const text = await readFile(file, "utf8").catch(() => "");
      if (text === "") continue;
      const name = createHash("sha256").update(text).digest("hex").slice(0, 32);
      const kept = join(this.folder, "kept", `${name}.txt`);
      if (!existsSync(kept)) {
        await writeFile(kept, `${relative(run.repo, file)}\n${text}`, { mode: 0o600 });
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // The zone in each account.

  /** The move's zone in `side`'s account, any status; undefined when it has none. */
  async zoneIn(side: "a" | "b"): Promise<ListedZone | undefined> {
    const zone = this.settings.domain;
    const cf = side === "a" ? this.a : this.b;
    const account = this.pass().accounts[side];
    const zones = await cf.list<ListedZone>(
      `/zones?name=${encodeURIComponent(zoneName(zone))}&account.id=${account}`,
    );
    return zones.find((item) => item.name === zoneName(zone));
  }

  /** The zone that serves now: A's while it is active there, else B's. */
  async servingZone(): Promise<{ side: "a" | "b"; zone: CloudflareZone }> {
    const a = await this.zoneIn("a");
    if (a?.status === "active") {
      return { side: "a", zone: { id: a.id, name: a.name, accountId: this.pass().accounts.a } };
    }
    const b = await this.zoneIn("b");
    if (b?.status !== "active") throw new Error("Neither account's zone is active.");
    return { side: "b", zone: { id: b.id, name: b.name, accountId: this.pass().accounts.b } };
  }

  /**
   * `side`'s inventory: the move's zone (status, plan, nameservers, records, settings and its own
   * pieces) and the account's pieces, each kind by name, or why it wasn't readable. Every address
   * in the records is masked from then on (`mask-address`). Also the raw records.
   */
  async inventory(side: "a" | "b"): Promise<{ inventory: Inventory; records: ListedRecord[] }> {
    const cf = side === "a" ? this.a : this.b;
    const account = `/accounts/${this.pass().accounts[side]}`;
    const zone = await this.zoneIn(side);
    const records =
      zone === undefined ? [] : await cf.list<ListedRecord>(`/zones/${zone.id}/dns_records`);
    for (const address of recordAddresses(records)) this.mask(address, "address");
    const settings: Record<string, string> = {};
    const pieces: AccountPieces = {};
    if (zone !== undefined) {
      this.mask(zone.id, `zone-id-${side}`);
      for (const setting of [
        "ssl",
        "min_tls_version",
        "always_use_https",
        "security_level",
        "cache_level",
      ]) {
        const got = await result<{ value?: unknown }>(cf, `/zones/${zone.id}/settings/${setting}`);
        settings[setting] = "unreadable" in got ? got.unreadable : String(got.value?.value);
      }
      const dnssec = await result<{ status?: string }>(cf, `/zones/${zone.id}/dnssec`);
      settings.dnssec = "unreadable" in dnssec ? dnssec.unreadable : String(dnssec.value?.status);
      const routing = await result<{ enabled?: boolean; status?: string }>(
        cf,
        `/zones/${zone.id}/email/routing`,
      );
      settings["email routing"] =
        "unreadable" in routing
          ? routing.unreadable
          : `${routing.value?.enabled === true ? "on" : "off"} (${routing.value?.status ?? "?"})`;
      const kinds = recordKindsCount(records);
      settings["email routing records"] = String(kinds.emailRouting);
      Object.assign(pieces, {
        "zone rulesets": await names(
          cf,
          `/zones/${zone.id}/rulesets`,
          (r: { phase?: string; name?: string; kind?: string }) =>
            r.kind === "zone" ? `${r.phase}: ${r.name}` : undefined,
        ),
        "page rules": await names(
          cf,
          `/zones/${zone.id}/pagerules`,
          (_r: unknown, at: number) => `page rule ${at + 1}`,
        ),
        "logpush jobs": await names(
          cf,
          `/zones/${zone.id}/logpush/jobs`,
          (r: { name?: string }) => r.name,
        ),
        "email routing rules": await names(
          cf,
          `/zones/${zone.id}/email/routing/rules`,
          (r: { name?: string; enabled?: boolean }, at: number) =>
            `${r.name || `rule ${at + 1}`}${r.enabled === false ? " (off)" : ""}`,
        ),
        "origin certificates": await names(
          cf,
          `/certificates?zone_id=${zone.id}`,
          (r: { revoked_at?: string | null }, at: number) =>
            r.revoked_at ? undefined : `origin certificate ${at + 1}`,
        ),
      });
    }
    Object.assign(pieces, {
      tunnels: await names(
        cf,
        `${account}/cfd_tunnel?is_deleted=false`,
        (r: { name?: string }) => r.name,
      ),
      "Access applications": await names(
        cf,
        `${account}/access/apps`,
        (r: { name?: string }) => r.name,
      ),
      "Access policies": await names(
        cf,
        `${account}/access/policies`,
        (r: { name?: string }) => r.name,
      ),
      "service tokens": await names(
        cf,
        `${account}/access/service_tokens`,
        (r: { name?: string }) => r.name,
      ),
      "login methods": await names(
        cf,
        `${account}/access/identity_providers`,
        (r: { type?: string; name?: string }) => `${r.type}: ${r.name}`,
      ),
      Workers: await names(cf, `${account}/workers/scripts`, (r: { id?: string }) => r.id),
      "Workers custom domains": await names(
        cf,
        `${account}/workers/domains`,
        (r: { hostname?: string; service?: string }) => `${r.hostname} → ${r.service}`,
      ),
      "Pages projects": await names(
        cf,
        `${account}/pages/projects`,
        (r: { name?: string }) => r.name,
      ),
      "R2 buckets": await r2Buckets(cf, account),
      "Turnstile widgets": await names(
        cf,
        `${account}/challenges/widgets`,
        (r: { name?: string }) => r.name,
      ),
      "Web Analytics sites": await names(
        cf,
        `${account}/rum/site_info/list`,
        (r: { host?: string; site_tag?: string }) => r.host || r.site_tag,
      ),
      members: await names(
        cf,
        `${account}/members`,
        (r: { roles?: { name?: string }[] }, at: number) =>
          `member ${at + 1} (${(r.roles ?? []).map((role) => role.name).join(", ")})`,
      ),
      "account API tokens": await names(cf, `${account}/tokens`, (r: { name?: string }) => r.name),
      notifications: await names(
        cf,
        `${account}/alerting/v3/policies`,
        (r: { name?: string }) => r.name,
      ),
    });
    const organization = await result<{ auth_domain?: string }>(
      cf,
      `${account}/access/organizations`,
    );
    if (!("unreadable" in organization) && organization.value?.auth_domain) {
      this.mask(organization.value.auth_domain, `team-${side}`);
      pieces["Zero Trust organization"] = [organization.value.auth_domain];
    }
    return {
      inventory: {
        ...(zone === undefined
          ? {}
          : {
              zone: {
                status: zone.status,
                plan: zone.plan?.name ?? "?",
                nameServers: zone.name_servers ?? [],
              },
            }),
        records: records.map(recordLine).sort(),
        settings,
        pieces,
      },
      records,
    };
  }

  /** Writes `inventory` into the pass's folder (for the lead's checklist, never committed). */
  async writeInventory(name: string, inventory: unknown): Promise<string> {
    const file = this.file(`${name}.json`);
    await writeFile(file, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
    return file;
  }

  /**
   * The real apps' hostnames, from the serving zone's records (OpsCrew's records and the Workers
   * custom domains, none of the pass's own), each masked by the zone's mask.
   */
  async realHosts(): Promise<string[]> {
    const { zone } = await this.servingZone();
    const cf = zone.accountId === this.pass().accounts.a ? this.a : this.b;
    const records = await cf.list<ListedRecord>(`/zones/${zone.id}/dns_records`);
    for (const address of recordAddresses(records)) this.mask(address, "address");
    return realAppHosts(records, `e2e-${this.pass().runId}`);
  }

  // -------------------------------------------------------------------------------------------
  // The move's commands.

  /**
   * `opscrew cloudflare move <first>` in `run`'s repository as a script runs it: after each stop,
   * the command it printed (`--approve <hash>`, its typed names among `names`, `--allow-downtime`
   * with `downtime`), until a run exits 0, or stops without a command to run next (a wait, a
   * refusal: its steps returned). Any other exit, a name it doesn't expect or a command printed
   * twice stops the leg.
   */
  async move(
    run: LiveRun,
    first: readonly string[],
    options: { label: string; names: readonly string[]; downtime?: boolean },
  ): Promise<MoveOutcome> {
    const outputs: string[] = [];
    let args = [...first];
    const seen = new Set<string>();
    for (let round = 1; round <= 30; round++) {
      const full = options.downtime === true ? withDowntime(args) : args;
      const ran = await run.opscrew("cloudflare", "move", ...full);
      outputs.push(ran.output);
      if (ran.exitCode === 0) return { kind: "done", outputs };
      if (ran.exitCode !== 1) {
        throw new Error(
          `${options.label}: opscrew cloudflare move exited with ${ran.exitCode}:\n${run.tail(ran.output)}`,
        );
      }
      const next = nextMoveCommand(ran.output);
      if (next === undefined) return { kind: "stopped", steps: nextSteps(ran.output), outputs };
      const unexpected = unexpectedNames(next, options.names);
      if (unexpected.length > 0) {
        throw new Error(
          `${options.label}: the printed command types ${unexpected.length} name(s) this leg doesn't expect, so nothing was approved:\n${run.tail(ran.output)}`,
        );
      }
      const key = next.join(" ");
      if (seen.has(key)) {
        throw new Error(
          `${options.label}: the move printed the same command again:\n${run.tail(ran.output)}`,
        );
      }
      seen.add(key);
      run.log(`${options.label}: running the command the move printed`);
      args = next;
    }
    throw new Error(`${options.label}: the move did not end after 30 runs.`);
  }

  /** {@link move}, which must end with exit 0. */
  async moveDone(
    run: LiveRun,
    first: readonly string[],
    options: { label: string; names: readonly string[]; downtime?: boolean },
  ): Promise<string[]> {
    const outcome = await this.move(run, first, options);
    if (outcome.kind === "stopped") {
      throw new Error(
        `${options.label} stopped without a command to run next:\n${this.scrub(outcome.steps.join("\n"))}\n${run.tail(outcome.outputs.at(-1) ?? "")}`,
      );
    }
    return outcome.outputs;
  }

  /** The names the move asks to type for `which`: the app's and its buckets' (and the zone's). */
  async typedNames(which: "p" | "q"): Promise<string[]> {
    const run = which === "p" ? this.p : this.q;
    const plan = await run.readPlan();
    return [
      plan.app.name,
      zoneName(this.settings.domain),
      ...[plan.storage?.objectStorage?.bucket, ...backupsBuckets(plan)].filter(
        (name): name is string => name !== undefined,
      ),
    ];
  }

  /** Commits and pushes the files the move changed in `run` (`opscrew/`), as the finish says to. */
  async commitMoved(run: LiveRun): Promise<void> {
    if ((await run.git("status", "--porcelain", "--", "opscrew")) === "") return;
    await run.git("add", "opscrew");
    await run.git(
      "commit",
      "-q",
      "-m",
      "chore: the files the move to the new Cloudflare account changed",
    );
    await run.git("push", "-q", "origin", "main");
  }

  // -------------------------------------------------------------------------------------------
  // The load and the probes.

  /**
   * Runs `body` under the pass's load: {@link PASS_RPS} requests a second to P's and Q's health
   * routes (every answer but a 2xx fails) and {@link REAL_RPS} to each real app's hostname (only a
   * 5xx or no answer fails). Returns `body`'s result and every failed request by target label;
   * the figures go to the state as `<label> load`.
   */
  async underLoad<T>(
    label: string,
    body: () => Promise<T>,
  ): Promise<{ result: T; failures: LoadFailure[] }> {
    const own = (["p", "q"] as const).filter((which) => {
      const app = this.pass().apps[which];
      return app?.appName !== undefined && app.destroyed !== true;
    });
    const targets = [
      ...(await Promise.all(
        own.map(async (which) => ({
          label: which.toUpperCase(),
          url: await this.healthUrl(which),
          rps: PASS_RPS,
          real: false,
        })),
      )),
      ...(await this.realHosts()).map((host, at) => ({
        label: `real ${at + 1}`,
        url: `https://${host}/`,
        rps: REAL_RPS,
        real: true,
      })),
    ];
    this.log(`${label}: the load runs on ${targets.length} hostnames`);
    const loads = targets.map((target) => ({
      target,
      load: steadyLoad(
        async () => {
          const answer = await fetch(target.url, {
            redirect: "manual",
            headers: { "User-Agent": "opscrew-e2e" },
            signal: AbortSignal.timeout(10_000),
          });
          await answer.arrayBuffer();
          return target.real ? edgeAnswer(answer.status) : answer.status;
        },
        target.rps,
        (failure) =>
          this.log(
            `${label}, ${target.label}: the request sent at ${failure.at} failed: ${failure.what}`,
          ),
      ),
    }));
    const stop = async () => {
      const summaries = await Promise.all(
        loads.map(async ({ target, load }) => ({ label: target.label, ...(await load.stop()) })),
      );
      const figures = loadFigures(summaries);
      for (const line of figures) this.log(`${label} load: ${line}`);
      this.pass().figures[`${label} load`] = figures.join("; ");
      return summaries.flatMap((summary) =>
        summary.failures.map((failure) => ({
          ...failure,
          what: `${summary.label}: ${failure.what}`,
        })),
      );
    };
    let result: T;
    try {
      result = await body();
    } catch (error) {
      await stop();
      throw error;
    }
    return { result, failures: await stop() };
  }

  /**
   * Runs `body` while the probes ask every {@link PROBE_MS} for P's, Q's and each real app's
   * hostname (labels only in what is kept): this computer's resolver and an HTTPS request; DNS
   * over HTTPS, then an HTTPS request to the edge address it gave, with the hostname as SNI; and
   * A's and B's nameservers asked directly. Samples go to `probes.jsonl`; also notes when the
   * public delegation first named B's nameservers. Returns `body`'s result, the samples, and that
   * time (epoch ms) when seen.
   */
  async withProbes<T>(
    body: () => Promise<T>,
  ): Promise<{ result: T; samples: ProbeSample[]; delegatedAt?: number }> {
    const hosts = [
      ...(["p", "q"] as const)
        .filter((which) => this.pass().apps[which] !== undefined)
        .map((which) => ({ label: which.toUpperCase(), host: this.app(which).hostname })),
      ...(await this.realHosts()).map((host, at) => ({ label: `real ${at + 1}`, host })),
    ];
    const [aZone, bZone] = [await this.zoneIn("a"), await this.zoneIn("b")];
    const servers = async (names: readonly string[]) =>
      (
        await Promise.all(names.map((name) => new Resolver().resolve4(name).catch(() => [])))
      ).flat();
    const nsA = await servers(aZone?.name_servers ?? []);
    const nsB = await servers(bZone?.name_servers ?? []);
    const bNames = (bZone?.name_servers ?? []).map((name) => name.toLowerCase()).sort();
    const origins = this.p.scrubber
      .entries()
      .filter(({ label }) => label.startsWith("server-"))
      .map(({ value }) => value);
    const samples: ProbeSample[] = [];
    let delegatedAt: number | undefined;
    let stopped = false;
    const file = this.file("probes.jsonl");
    const round = async (count: number) => {
      const at = Date.now();
      if (delegatedAt === undefined && count % 6 === 0 && bNames.length > 0) {
        const now = await publicNameservers(fetch, zoneName(this.settings.domain)).catch(() => []);
        if (
          now
            .map((name) => name.toLowerCase())
            .sort()
            .join() === bNames.join()
        )
          delegatedAt = at;
      }
      const taken = await Promise.all(
        hosts.flatMap(({ label, host }) => [
          probeHttps(at, label, "resolver", () => httpsStatus(host)),
          probeHttps(at, label, "doh-edge", async () => {
            const address = await dohAddress(host);
            return address === undefined ? "no A" : httpsStatus(host, address);
          }),
          ...(nsA.length === 0 ? [] : [probeNameservers(at, label, "ns-a", nsA, host, origins)]),
          ...(nsB.length === 0 ? [] : [probeNameservers(at, label, "ns-b", nsB, host, origins)]),
        ]),
      );
      samples.push(...taken);
      await appendFile(file, taken.map((sample) => `${JSON.stringify(sample)}\n`).join(""));
    };
    const loop = (async () => {
      for (let count = 0; !stopped; count++) {
        const started = Date.now();
        await round(count).catch((error: unknown) =>
          this.log(`a probe round failed: ${String(error)}`),
        );
        await sleep(Math.max(0, PROBE_MS - (Date.now() - started)));
      }
    })();
    try {
      const result = await body();
      return { result, samples, ...(delegatedAt === undefined ? {} : { delegatedAt }) };
    } finally {
      stopped = true;
      await loop;
    }
  }

  /** Whether the public delegation names B's nameservers now. */
  async delegatedToB(): Promise<boolean> {
    const b = await this.zoneIn("b");
    const wanted = (b?.name_servers ?? [])
      .map((name) => name.toLowerCase())
      .sort()
      .join();
    const now = await publicNameservers(fetch, zoneName(this.settings.domain)).catch(() => []);
    return (
      wanted !== "" &&
      now
        .map((name) => name.toLowerCase())
        .sort()
        .join() === wanted
    );
  }

  /**
   * The SSH hostname behind Access with Q's deploy service token (lead note on T2808): the status
   * and how long it took, or that Access held the stream until the 5 s limit.
   */
  async sshProbe(): Promise<string> {
    const outputs = await this.q.infraOutputs();
    const id = outputs.deploy_service_token_client_id;
    const secret = outputs.deploy_service_token_client_secret;
    const host = sshHostname(await this.q.readPlan());
    if (typeof id !== "string" || typeof secret !== "string" || host === undefined) {
      return "no service token or SSH hostname in Q's outputs";
    }
    this.p.scrubber.add(id, "deploy-service-token-client-id");
    this.p.scrubber.add(secret, "deploy-service-token-client-secret");
    const started = Date.now();
    try {
      const answer = await fetch(`https://${host}/`, {
        redirect: "manual",
        headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret },
        signal: AbortSignal.timeout(5_000),
      });
      await answer.body?.cancel();
      return `HTTP ${answer.status} in ${Date.now() - started} ms`;
    } catch (error) {
      const why = requestFailure(error);
      return why === "TimeoutError"
        ? "no answer within 5 s: Access held the stream to the limit"
        : `${why} after ${Date.now() - started} ms`;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Q's copies, read in either account's bucket.

  /** Q's backups bucket in `side`'s account, read with that account's R2 key (rclone in Docker). */
  async copiesBucket(side: "a" | "b"): Promise<BackupsBucket> {
    const plan = await this.q.readPlan();
    const [name] = backupsBuckets(plan);
    if (name === undefined) throw new Error("Q's plan has no backups bucket.");
    const keys = await this.r2Keys();
    const accountId = this.pass().accounts[side];
    return new BackupsBucket(
      this.q,
      r2Pass(side === "a" ? this.a : this.b, accountId),
      "r2",
      name,
      "auto",
      keys[side],
      accountId,
    );
  }

  /** Every object of Q's copies in `side`'s bucket with the SHA-256 of what it holds. */
  async copies(side: "a" | "b"): Promise<Record<string, string>> {
    const bucket = await this.copiesBucket(side);
    const found: Record<string, string> = {};
    for (const object of await bucket.objects()) {
      found[object] = createHash("sha256")
        .update(await bucket.read(object))
        .digest("hex");
    }
    return found;
  }

  // -------------------------------------------------------------------------------------------
  // The leak search and the cleanup.

  /**
   * The leak search over the whole pass (SC-2807): every secret the pass knows in every CLI output
   * of every leg, every version of the move's local files and saved plans, each app's commits of
   * every branch, its pull requests since the pass started, its audit log and its local files;
   * the servers' addresses in commits and pull requests, and in outputs outside the lines that
   * show them on purpose. Masks (the zone, the account ids, the records' addresses) are never
   * searched for. Returns the problems, by label and place only.
   */
  async leaks(): Promise<string[]> {
    const { secrets, addresses } = leakSearchValues(this.p.scrubber.entries());
    const problems: string[] = [];
    const search = (where: string, text: string, values: typeof secrets) => {
      const found = leakedLabels(text, values);
      if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
    };
    const sources: LeakSource[] = [];
    for (const [which, run] of [
      ["p", this.p],
      ["q", this.q],
    ] as const) {
      if (this.state?.apps[which] === undefined) continue;
      const label = ` (${which.toUpperCase()})`;
      sources.push(
        ...(await leakSourcesOf(
          {
            git: (...args) => run.git(...args),
            github: run.github,
            startedAt: new Date(this.pass().startedAt),
            auditDir: run.paths().auditDir,
          },
          label,
        )),
      );
      for (const source of await localLeakSources(run.paths())) {
        sources.push({ ...source, where: `${source.where}${label}` });
      }
    }
    for (const source of sources) {
      const shared = source.kind === "commits" || source.kind === "pull request";
      search(source.where, source.text, shared ? [...secrets, ...addresses] : secrets);
    }
    for (const dir of ["outputs", "kept"] as const) {
      for (const file of await readdir(join(this.folder, dir)).catch(() => [] as string[])) {
        const text = await readFile(join(this.folder, dir, file), "utf8");
        const [label = file, ...rest] = text.split("\n");
        const body = rest.join("\n");
        const where = dir === "outputs" ? `the output of ${label}` : `a kept version of ${label}`;
        search(where, body, secrets);
        if (dir === "outputs") {
          const lines = addressLinesOutsidePurpose(
            body,
            addresses.map(({ value }) => value),
          );
          if (lines > 0) problems.push(`${where} printed a server's address on ${lines} line(s)`);
        }
      }
    }
    return problems;
  }

  /**
   * What is left of P's and Q's in `side`'s account (`names`: the apps' names; `tag`: the run's
   * hostnames' tag), deleted when `remove`: their tunnels (connections first), Access
   * applications, policies and service tokens, DNS records holding the tag (marks included) in
   * the account's zone, and their R2 buckets (emptied with rclone first). Nothing else is
   * touched: every piece is matched by the apps' names. Returns what is left (or was removed).
   */
  async leftovers(side: "a" | "b", remove: boolean): Promise<string[]> {
    const cf = side === "a" ? this.a : this.b;
    const accountId = this.pass().accounts[side];
    const account = `/accounts/${accountId}`;
    const apps = (["p", "q"] as const).flatMap((which) => {
      const app = this.pass().apps[which];
      // Never an empty name, which every name would hold.
      return app?.appName === undefined || app.appName === "" ? [] : [app.appName];
    });
    if (apps.length === 0) return [];
    const ours = (name: string | undefined) =>
      name !== undefined && apps.some((app) => name.includes(app));
    const tag = `e2e-${this.pass().runId}`;
    const left: string[] = [];
    const sweep = async (
      what: string,
      path: string,
      pick: (item: { id: string; name?: string }) => boolean,
      before?: (id: string) => Promise<unknown>,
    ) => {
      for (const item of (
        await cf.list<{ id: string; name?: string }>(path).catch(() => [])
      ).filter(pick)) {
        left.push(`${side.toUpperCase()}: ${what} ${item.name ?? item.id}`);
        if (!remove) continue;
        await before?.(item.id);
        if (!(await retryDelete(() => cf.call("DELETE", `${path.split("?")[0]}/${item.id}`)))) {
          left.push(
            `${side.toUpperCase()}: Cloudflare did not delete ${what} ${item.name ?? item.id}`,
          );
        }
      }
    };
    await sweep("Access application", `${account}/access/apps`, (item) => ours(item.name));
    await sweep("Access policy", `${account}/access/policies`, (item) => ours(item.name));
    await sweep("service token", `${account}/access/service_tokens`, (item) => ours(item.name));
    await sweep(
      "tunnel",
      `${account}/cfd_tunnel?is_deleted=false`,
      (item) => ours(item.name),
      (id) => cf.call("DELETE", `${account}/cfd_tunnel/${id}/connections`),
    );
    const zone = await this.zoneIn(side);
    if (zone !== undefined && zone.status !== "moved") {
      await sweep(
        "DNS record",
        `/zones/${zone.id}/dns_records`,
        (item) =>
          item.name?.includes(tag) === true ||
          (item.name?.startsWith("_opscrew-move.") === true &&
            apps.some((app) => item.name?.includes(app))),
      );
    }
    const buckets = await r2Buckets(cf, account);
    for (const name of Array.isArray(buckets) ? buckets.filter(ours) : []) {
      left.push(`${side.toUpperCase()}: R2 bucket ${name}`);
      if (!remove) continue;
      const bucket = new BackupsBucket(
        this.p,
        r2Pass(cf, accountId),
        "r2",
        name,
        "auto",
        (await this.r2Keys())[side],
        accountId,
      );
      await bucket
        .remove()
        .catch((error: unknown) =>
          left.push(`${side.toUpperCase()}: R2 bucket ${name}: ${String(error)}`),
        );
    }
    return left;
  }

  /** Removes the pass's folder (L6, once nothing is left). */
  async removeFolder(): Promise<void> {
    await rm(this.folder, { recursive: true, force: true });
    this.removed = true;
  }
}

// ---------------------------------------------------------------------------------------------
// A leg: its steps in order, its waits, its state.

/** What a step may end with besides passing: a wait, after which the leg is run again. */
export interface StepWait {
  wait: string;
}

/**
 * One leg in one process: opens the pass before its first step (after checking the legs before it
 * passed), saves it after its last, records its outcome. A step that returns {@link StepWait} ends
 * the leg as `waiting` with that advice; the steps after a failure or a wait are skipped (unless
 * `always`).
 */
export class Leg {
  private ended: "failed" | "waiting" | undefined;

  constructor(
    private readonly pass: MovePass,
    readonly leg: MoveLeg,
  ) {
    beforeAll(async () => {
      await pass.open();
      const problem = legOrderProblem(pass.state, leg);
      if (problem !== undefined) {
        this.ended = "failed";
        throw new Error(`${leg} can't start yet: ${problem} (docs/e2e.md).`);
      }
      if (pass.state !== undefined) {
        pass.state.legs[leg] = { startedAt: new Date().toISOString(), outcome: "running" };
        await pass.save();
      }
    }, minutes(10));
    const startedAt = new Date().toISOString();
    afterAll(async () => {
      // L0 makes the state in its first step, so its record may start only here.
      const { state } = pass;
      if (state !== undefined) {
        state.legs[leg] ??= { startedAt, outcome: "running" };
        const record = state.legs[leg];
        record.endedAt = new Date().toISOString();
        if (record.outcome === "running") record.outcome = this.ended ?? "passed";
      }
      await pass.save();
    }, minutes(10));
  }

  step(
    title: string,
    timeoutMs: number,
    body: () => Promise<StepWait | undefined>,
    options: { always?: boolean } = {},
  ): void {
    it(`${this.leg}: ${title}`, { timeout: timeoutMs }, async (context) => {
      if (this.ended !== undefined && options.always !== true) context.skip();
      context.onTestFailed(() => {
        this.ended = "failed";
      });
      this.pass.log(`${this.leg}, step: ${title}`);
      try {
        const done = await body();
        if (done && "wait" in done) {
          this.ended = "waiting";
          const record = this.pass.state?.legs[this.leg];
          if (record !== undefined) {
            record.outcome = "waiting";
            record.note = this.pass.scrub(done.wait);
          }
          this.pass.log(
            `${this.leg} waits: ${done.wait} Run ${this.leg} again then (docs/e2e.md).`,
          );
        }
      } catch (error) {
        this.ended = "failed";
        throw this.pass.p.cleanError(error);
      } finally {
        await this.pass.save();
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers.

/** A zone as Cloudflare lists it. */
export interface ListedZone {
  id: string;
  name: string;
  status: string;
  plan?: { name?: string };
  name_servers?: string[];
  original_registrar?: string | null;
}

/** The move's zone: `OPSCREW_E2E_DOMAIN` without a first label when it has more than two. */
export function zoneName(domain: string): string {
  const labels = domain.split(".");
  return labels.length > 2 ? labels.slice(1).join(".") : domain;
}

/** The backups bucket names of `plan` (Q's off-server copies), when on R2. */
function backupsBuckets(plan: DeployPlan): string[] {
  const bucket = backupsBucketOf(plan);
  return bucket?.provider === "r2" ? [bucket.bucket] : [];
}

/** Each `kind` of the records, counted. */
function recordKindsCount(records: readonly ListedRecord[]): { emailRouting: number } {
  return { emailRouting: records.filter((record) => record.meta?.email_routing === true).length };
}

/** A token's id (a user's token, or the account's own), for its R2 key. */
async function tokenId(cf: Cloudflare, accountId: string): Promise<string> {
  for (const path of ["/user/tokens/verify", `/accounts/${accountId}/tokens/verify`]) {
    const verified = await cf.call("GET", path);
    const id = (verified.json as { result?: { id?: string } } | undefined)?.result?.id;
    if (verified.status === 200 && id !== undefined) return id;
  }
  throw new Error("Cloudflare did not say the token's id (tokens/verify), which its R2 key needs.");
}

/** One GET's `result`, or why it wasn't readable (`HTTP <status>[ code <n>]`). */
export async function result<T>(
  cf: Cloudflare,
  path: string,
): Promise<{ value: T | undefined } | { unreadable: string }> {
  const got = await cf.call("GET", path);
  const body = got.json as
    | { success?: boolean; result?: T; errors?: { code?: number }[] }
    | undefined;
  if (got.status === 200 && body?.success !== false) return { value: body?.result };
  const code = body?.errors?.[0]?.code;
  return { unreadable: `HTTP ${got.status}${code === undefined ? "" : ` code ${code}`}` };
}

/** One list's names (`pick` returns undefined to leave one out), or why it wasn't readable. */
async function names<T>(
  cf: Cloudflare,
  path: string,
  pick: (item: T, at: number) => string | undefined,
): Promise<string[] | { unreadable: string }> {
  const got = await result<T[]>(cf, path);
  if ("unreadable" in got) return got;
  return (got.value ?? []).flatMap((item, at) => {
    const name = pick(item, at);
    return name === undefined ? [] : [name];
  });
}

/** The account's R2 bucket names (R2 lists them under `result.buckets`). */
async function r2Buckets(
  cf: Cloudflare,
  account: string,
): Promise<string[] | { unreadable: string }> {
  const got = await result<{ buckets?: { name: string }[] }>(cf, `${account}/r2/buckets`);
  if ("unreadable" in got) return got;
  return (got.value?.buckets ?? []).map((bucket) => bucket.name);
}

/** What {@link BackupsBucket} needs of an R2 bucket: whether it is there, and its deletion. */
function r2Pass(cf: Cloudflare, accountId: string) {
  const path = (bucket: ProviderBucket) => `/accounts/${accountId}/r2/buckets/${bucket.bucket}`;
  return {
    exists: async (bucket: ProviderBucket) => {
      const got = await cf.call("GET", path(bucket));
      if (got.status === 404) return false;
      if (got.status === 200) return true;
      throw new Error(`Cloudflare answered HTTP ${got.status} for the bucket ${bucket.bucket}.`);
    },
    deleteThroughApi: async (bucket: ProviderBucket) => {
      await retryDelete(() => cf.call("DELETE", path(bucket)));
    },
  };
}

/** The text files under `dir` (JSON, state files and their backups; never the engines' data folders). */
async function textFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "tf" && entry.name !== ".terraform")
        found.push(...(await textFiles(path)));
    } else if (/\.(json|tfstate|backup|tfplan\.json)$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** The status of `https://<host>/` (redirects not followed), at `address` with `host` as SNI when given. */
function httpsStatus(host: string, address?: string): Promise<number> {
  if (address === undefined) {
    return fetch(`https://${host}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    }).then(async (answer) => {
      await answer.body?.cancel();
      return answer.status;
    });
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: address,
        servername: host,
        path: "/",
        headers: { host, "User-Agent": "opscrew-e2e" },
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("timeout", () =>
      request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
    );
    request.on("error", reject);
    request.end();
  });
}

/** The answers of Cloudflare's DNS over HTTPS for `name` and `type` (`A`, `DS`). */
export async function doh(name: string, type: string): Promise<{ type: number; data: string }[]> {
  const answer = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) },
  );
  if (!answer.ok) throw new Error(`DNS over HTTPS answered HTTP ${answer.status}.`);
  return ((await answer.json()) as { Answer?: { type: number; data: string }[] }).Answer ?? [];
}

/** The first IPv4 address of `host` from Cloudflare's DNS over HTTPS, or undefined. */
async function dohAddress(host: string): Promise<string | undefined> {
  return (await doh(host, "A")).find((record) => record.type === 1)?.data;
}

/** One HTTPS probe: ok for any answer below 500; an error by its code only. */
async function probeHttps(
  at: number,
  host: string,
  via: ProbeSample["via"],
  ask: () => Promise<number | string>,
): Promise<ProbeSample> {
  try {
    const got = await ask();
    if (typeof got === "string") return { at, host, via, ok: false, answer: got };
    return { at, host, via, ok: edgeAnswer(got) === 200, answer: `HTTP ${got}` };
  } catch (error) {
    return { at, host, via, ok: false, answer: requestFailure(error) ?? "error" };
  }
}

/**
 * One nameserver probe: `host`'s A record asked of `servers` directly; `A origin` when it names a
 * server of the pass (a pending zone's answer, R10.3), `A`, `CNAME`, or the error's code.
 */
async function probeNameservers(
  at: number,
  host: string,
  via: "ns-a" | "ns-b",
  servers: readonly string[],
  name: string,
  origins: readonly string[],
): Promise<ProbeSample> {
  const resolver = new Resolver({ timeout: 5_000, tries: 1 });
  resolver.setServers([...servers]);
  try {
    const addresses = await resolver.resolve4(name);
    const origin = addresses.some((address) => origins.includes(address));
    return { at, host, via, ok: true, answer: origin ? "A origin" : "A" };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "error";
    if (code === "ENODATA") {
      const cname = await resolver.resolveCname(name).catch(() => []);
      if (cname.length > 0) return { at, host, via, ok: true, answer: "CNAME" };
    }
    return { at, host, via, ok: false, answer: code === "ENOTFOUND" ? "NXDOMAIN" : code };
  }
}

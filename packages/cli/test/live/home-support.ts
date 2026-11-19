/**
 * The live pass of feature 029 (docs/e2e.md "Hosting at home"): a Hetzner Arm server stands in for
 * the home server, a Hetzner Cloud firewall on it for the router, and a second throwaway server for
 * the outside scanner. Each leg is its own vitest process (`-t "H<n>:"`), so the pass keeps its
 * state (`pass.json`), the app's checkout with OpsCrew's home and keys, every CLI output and every
 * version of the local files the leak scan reads in its own folder under `OPSCREW_TEST_TMP`.
 *
 * Here: the legs' gate, variables and order, the pass's state, the pass in one leg's process
 * ({@link HomePass}: the run put back together, the router's firewall, the scanner, the updater's
 * records, provision and the drills as a script runs them, the leak scan and the cleanup), and one
 * leg's steps ({@link Leg}). Every credential is read from the environment by its name, never
 * printed and never written to the pass's folder.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { providerProfile } from "@opscrew/agents";
import { DNS_UPDATER_RECORD_COMMENT } from "@opscrew/connector-ssh-host";
import {
  OUTSIDE_CHECK_JOBS,
  OUTSIDE_CHECK_WORKFLOW_FILE,
  pinnedVersion,
  runnerLabel,
  serviceSpec,
  shellQuote,
  usesTunnel,
} from "@opscrew/iac-templates";
import { type DeployPlan, PlanServiceSchema, type Region } from "@opscrew/plan-schema";
import { afterAll, beforeAll, it } from "vitest";
import { z } from "zod";
import {
  api,
  Cloudflare,
  type CloudflareZone,
  createThrowawayServer,
  deleteThrowaway,
  type FirewallRule,
  HETZNER_API,
  minutes,
  RootShell,
  retryDelete,
  waitFor,
} from "./cloud";
import { leakSearchValues, leftoverMatch, persistedEntries } from "./cloudflare-move-support";
import { opscrewUntilApproved } from "./environment-checks";
import { type CliRun, LiveRun, leakSourcesOf, serverSettings } from "./harness";
import { jobLog } from "./portainer-cloud";
import { MOVE_SERVICES } from "./retarget-anywhere-support";
import { approvedDrill, type DrillReport } from "./snapshots-checks";
import {
  addressLinesOutsidePurpose,
  approveHashes,
  ed25519FromKeyscan,
  leakedLabels,
} from "./support";

// ---------------------------------------------------------------------------------------------
// The legs and their variables.

/** `1` runs the pass. */
export const HOME_GATE = "OPSCREW_E2E_HOME";

/**
 * The legs of plan 18., in the order they run: H8 runs on the home server, so before H7, which
 * removes it.
 */
export const HOME_LEGS = ["H0", "H1", "H2", "H3", "H4", "H5", "H6", "H8", "H7"] as const;
export type HomeLeg = (typeof HOME_LEGS)[number];

/** The pass's app: it keeps a database on the server (PostgreSQL is added for H8). */
export const HOME_EXAMPLE = "flask-sqlite";

/** What every leg reads (H0 too: it checks both updater tokens and the repository). */
export const HOME_VARIABLES = [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
  "OPSCREW_E2E_DNS_UPDATER_TOKEN",
  "OPSCREW_E2E_DNS_UPDATER_TOKEN_B",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_TEST_TMP",
] as const;

/** Why a leg is skipped (the gate, then each missing variable), or `undefined` when it can run. */
export function legSkip(env: Record<string, string | undefined>): string | undefined {
  if (env[HOME_GATE] !== "1") return `set ${HOME_GATE}=1`;
  const missing = HOME_VARIABLES.filter((name) => (env[name]?.trim() ?? "") === "");
  return missing.length === 0 ? undefined : `set ${missing.join(", ")}`;
}

/**
 * The other legs whose names `title` holds as a word: `-t "H<n>:"` (or `-t "H<n>"`) would select a
 * step with such a title with that leg too.
 */
export function otherLegsNamed(leg: HomeLeg, title: string): HomeLeg[] {
  return HOME_LEGS.filter((name) => name !== leg && new RegExp(`\\b${name}\\b`).test(title));
}

/** The pass's folder, outside every vitest run folder so it outlasts each leg. */
export function passFolder(env: Record<string, string | undefined>): string {
  const root = env.OPSCREW_TEST_TMP?.trim() ?? "";
  if (root === "") throw new Error("Set OPSCREW_TEST_TMP: the pass keeps its state there.");
  return join(root, "opscrew-e2e-home");
}

// ---------------------------------------------------------------------------------------------
// The pass's state, kept between legs in `pass.json`.

const ServerSchema = z.object({
  id: z.number(),
  name: z.string(),
  serverType: z.string(),
  location: z.string(),
  hourlyGross: z.number(),
  ipv4: z.string(),
  ipv6: z.string().optional(),
  ipv6Network: z.string().optional(),
});

/** The pass's app and its home server: where the checkout is, and what H1 made. */
const AppStateSchema = z.object({
  work: z.string(),
  repo: z.string(),
  keyFile: z.string(),
  knownHostsFile: z.string(),
  exampleCommit: z.string(),
  hostname: z.string(),
  /** Set once design named the app. */
  appName: z.string().optional(),
  server: ServerSchema.optional(),
  /** The server's SSH host key fingerprint, confirmed at the first design. */
  fingerprint: z.string().optional(),
  /** The router's stand-in: the Hetzner Cloud firewall on the server. */
  firewallId: z.number().optional(),
  /** `destroy` ended (H7). */
  destroyed: z.boolean().optional(),
});
export type AppState = z.infer<typeof AppStateSchema>;

const ZoneTlsSchema = z.object({
  originCertificates: z.array(z.object({ id: z.string(), hostnames: z.array(z.string()) })),
  clientCertificates: z.array(z.string()),
  hostnameSettings: z.array(
    z.object({
      hostname: z.string(),
      certId: z.string().optional(),
      enabled: z.boolean().nullable(),
    }),
  ),
  minTls: z.object({ value: z.string(), editable: z.boolean() }),
});

const LegRecordSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string().optional(),
  outcome: z.enum(["running", "passed", "failed"]),
});

export const PassStateSchema = z.object({
  /** H1's run id: the hostname, the app's name and every Hetzner label carry it. */
  runId: z.string(),
  startedAt: z.string(),
  /** This computer's public IPv4 address: `server.sshFrom`, and the router's SSH source. */
  testerIpv4: z.string(),
  zone: z.object({ id: z.string(), name: z.string(), accountId: z.string() }),
  app: AppStateSchema.optional(),
  /** The outside scanner, made the first time a leg scans. */
  scanner: z
    .object({ server: ServerSchema, keyFile: z.string(), knownHostsFile: z.string() })
    .optional(),
  /** Which updater token the server holds: H7's rotation puts the second one there. */
  updaterToken: z.enum(["a", "b"]),
  /** The zone's origin TLS before H1's provision, for the cleanup's leftover decision. */
  tlsBefore: ZoneTlsSchema.optional(),
  legs: z.record(z.string(), LegRecordSchema),
  /** The figures for docs/e2e-coverage.md, by name, each a line without an address or a secret. */
  figures: z.record(z.string(), z.string()),
});
export type PassState = z.infer<typeof PassStateSchema>;

/** The pass's state read back from `pass.json`'s text; a plain error when it isn't one. */
export function parsePass(text: string): PassState {
  const parsed = PassStateSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      "pass.json in the pass's folder is not the pass's state: run H7 to clean up what it names, or delete the folder after cleaning up by hand (docs/e2e.md).",
    );
  }
  return parsed.data;
}

/**
 * Why `leg` can't start, from the legs recorded: H7 (the cleanup) runs after anything, and no
 * other leg once it ran; H8 needs H1 passed; H0 to H6 never run once a later one of them ran, and
 * each needs the one before it passed.
 */
export function legOrderProblem(state: PassState | undefined, leg: HomeLeg): string | undefined {
  if (leg === "H7") return undefined;
  if (state?.legs.H7 !== undefined) {
    return "H7 ran already: run H7 again to its end, then start the pass again with H0";
  }
  if (leg === "H8") {
    return state?.legs.H1?.outcome === "passed" ? undefined : "run H1 to its end first";
  }
  const rank = (name: HomeLeg) => HOME_LEGS.indexOf(name);
  const later = HOME_LEGS.filter(
    (name) =>
      name !== "H7" && name !== "H8" && rank(name) > rank(leg) && state?.legs[name] !== undefined,
  );
  if (later.length > 0) {
    return `${later.join(" and ")} ran already, so ${leg} doesn't run again: go on from there, or run H7`;
  }
  if (leg === "H0") return undefined;
  if (state === undefined) return "run H0 first";
  const before = HOME_LEGS[rank(leg) - 1] as HomeLeg;
  return state.legs[before]?.outcome === "passed" ? undefined : `run ${before} to its end first`;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers.

/**
 * The router's stand-in: TCP 80 and 443 from anywhere (443 left out with `https` false, a port
 * that doesn't answer), SSH from `tester` only, or from anywhere with `sshFromAnywhere` (a router
 * forwarding SSH by mistake).
 */
export function routerRules(
  tester: string,
  options: { sshFromAnywhere?: boolean; https?: boolean } = {},
): FirewallRule[] {
  const anywhere = ["0.0.0.0/0", "::/0"];
  return [
    {
      direction: "in",
      protocol: "tcp",
      port: "22",
      source_ips: options.sshFromAnywhere === true ? anywhere : [`${tester}/32`],
      description:
        options.sshFromAnywhere === true ? "ssh (forwarded by mistake)" : "ssh (this computer)",
    },
    { direction: "in", protocol: "tcp", port: "80", source_ips: anywhere, description: "http" },
    ...(options.https === false
      ? []
      : [
          {
            direction: "in" as const,
            protocol: "tcp" as const,
            port: "443",
            source_ips: anywhere,
            description: "https",
          },
        ]),
  ];
}

/** An address that never answers: TEST-NET-1 (`192.0.2.0/24`), a host part from 10 to 209. */
export function testNetAddress(random = Math.random): string {
  return `192.0.2.${10 + Math.floor(random() * 200)}`;
}

/** One port the scanner tries: `label` (`IPv4`, `IPv6`) names the address in what it prints. */
export interface ScanTarget {
  label: string;
  address: string;
  port: number;
}

/** What a port did for the scanner: answered, refused at once, or dropped (no answer in 6 s). */
export type ScanResult = "open" | "refused" | "filtered" | "error";

/**
 * The scanner's bash script: a TCP connection to each target through bash's `/dev/tcp`, with 6
 * seconds for each, printing `<label> <port> <result>` only (never an address).
 */
export function scanScript(targets: readonly ScanTarget[]): string {
  return targets
    .map(({ label, address, port }) => {
      if (!/^[A-Za-z0-9]+$/.test(label) || !/^[0-9a-fA-F.:]+$/.test(address)) {
        throw new Error("A scan target's label or address is not plain.");
      }
      return [
        `r=$(timeout 6 bash -c 'exec 3<>/dev/tcp/${address}/${port}' 2>&1); c=$?`,
        'if [ "$c" -eq 0 ]; then s=open; elif [ "$c" -eq 124 ]; then s=filtered; elif printf %s "$r" | grep -qi refused; then s=refused; else s=error; fi',
        `echo "${label} ${port} $s"`,
      ].join("; ");
    })
    .join("\n");
}

/** The scanner's results by `<label> <port>`, from {@link scanScript}'s output. */
export function parseScan(output: string): Record<string, ScanResult> {
  const results: Record<string, ScanResult> = {};
  for (const line of output.split(/\r?\n/)) {
    const found = /^(\S+) (\d+) (open|refused|filtered|error)$/.exec(line.trim());
    if (found !== null) results[`${found[1]} ${found[2]}`] = found[3] as ScanResult;
  }
  return results;
}

/** The plan with PostgreSQL (`db`) added, as a user adds a service to plan.yaml before design. */
export function withPostgres(plan: DeployPlan): DeployPlan {
  if (plan.services.some((service) => service.name === MOVE_SERVICES.postgres)) return plan;
  const spec = serviceSpec("postgres");
  const service = PlanServiceSchema.parse({
    name: MOVE_SERVICES.postgres,
    kind: "postgres",
    version: pinnedVersion(spec),
    memoryMb: spec.memory.defaultMb,
    reason: "Added in plan.yaml by the home live pass, for its restore drill and database check.",
    licence: spec.licence.id,
  });
  return { ...plan, services: [...plan.services, service] };
}

/**
 * The names a printed `opscrew provision … --confirm <name>` command types, each once (a trailing
 * full stop or backtick of the sentence around it left out).
 */
export function printedConfirms(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("opscrew provision")) continue;
    for (const [, name] of line.matchAll(/--confirm (\S+)/g)) {
      const plain = (name ?? "").replace(/[.,;:`)'"]+$/, "");
      if (plain !== "") names.add(plain);
    }
  }
  return [...names];
}

const AdviceSchema = z.object({
  proposals: z.array(z.object({ id: z.string(), urgency: z.string() })),
  notRead: z.array(z.string()),
});

/** The proposals' ids and what wasn't read, from `opscrew advise --json`'s report. */
export function adviceOf(stdout: string): z.infer<typeof AdviceSchema> {
  return AdviceSchema.parse(JSON.parse(stdout));
}

const OutsideCheckSchema = z.object({
  mode: z.enum(["proxied", "direct"]),
  http: z.string(),
  https: z.string(),
});

/** The last outside check this computer recorded (`.opscrew/server.json` → `own.home.outsideCheck`). */
export function outsideCheckOf(serverJson: string): z.infer<typeof OutsideCheckSchema> | undefined {
  const json = JSON.parse(serverJson) as { own?: { home?: { outsideCheck?: unknown } } };
  const check = json.own?.home?.outsideCheck;
  return check === undefined ? undefined : OutsideCheckSchema.parse(check);
}

/** The scrubber's labels of what each process reads again from the environment. */
const DERIVED_LABELS = ["dns-updater-token", "dns-updater-token-b"];

/** A DNS record of the app's hostname as Cloudflare lists it. */
export interface HomeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  comment?: string | null;
}

/** The SHA-256 of `text`, hex. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// The pass in one leg's process.

/** What the pass reads from the environment. */
function homeSettings(env: Record<string, string | undefined>) {
  return {
    ...serverSettings(env, "OPSCREW_E2E_OWN_SERVER_TYPE"),
    app: HOME_EXAMPLE,
    updaterTokens: {
      a: env.OPSCREW_E2E_DNS_UPDATER_TOKEN?.trim() ?? "",
      b: env.OPSCREW_E2E_DNS_UPDATER_TOKEN_B?.trim() ?? "",
    },
  };
}

/** How the site is served, as the interview's `server.serve` says it. */
export type Serve = "proxy" | "dns-only" | "tunnel";

/**
 * The pass in one leg's process: its state, the app's run (put back together from the state after
 * H1), Cloudflare's client, and the scrubber shared by everything printed.
 */
export class HomePass {
  readonly settings: ReturnType<typeof homeSettings>;
  readonly folder: string;
  readonly run: LiveRun;
  readonly cloudflare: Cloudflare;
  /** The pass's state; set by {@link open} once H0 made it. */
  state: PassState | undefined;
  /** The leg this process runs (set by {@link Leg}). */
  leg: HomeLeg | undefined;
  /** Each CLI output's label, with whether it may show the server's address (DNS only). */
  private readonly shown = new Map<string, boolean>();
  private savedOutputs = 0;
  private removed = false;

  constructor(env: Record<string, string | undefined>) {
    this.settings = homeSettings(env);
    this.folder = env.OPSCREW_TEST_TMP?.trim() ? passFolder(env) : "";
    this.run = new LiveRun({
      label: "home",
      name: "home",
      settings: this.settings,
      afterCli: () => this.afterCli(),
    });
    this.cloudflare = new Cloudflare(this.settings.cloudflareToken);
    this.run.scrubber.add(this.settings.updaterTokens.a, "dns-updater-token");
    this.run.scrubber.add(this.settings.updaterTokens.b, "dns-updater-token-b");
  }

  readonly log = (message: string) => this.run.log(message);

  /** The pass's state, which H0 makes. */
  pass(): PassState {
    if (this.state === undefined) throw new Error("The pass has no state yet: run H0 first.");
    return this.state;
  }

  /** The app's recorded state, which H1 makes. */
  app(): AppState {
    const app = this.pass().app;
    if (app === undefined) throw new Error("H1 recorded no app: run H1 first.");
    return app;
  }

  /** The zone as the cloud helpers take it. */
  zone(): CloudflareZone {
    return this.pass().zone;
  }

  private file(name: string): string {
    return join(this.folder, name);
  }

  /**
   * Opens the pass in this process: reads `pass.json` and the values masked so far, and puts the
   * app's run back together from what H1 recorded.
   */
  async open(): Promise<void> {
    await mkdir(join(this.folder, "outputs"), { recursive: true });
    await mkdir(join(this.folder, "kept"), { recursive: true });
    const { scrubber } = this.run;
    scrubber.add(
      Buffer.from(`x-access-token:${this.settings.githubToken}`).toString("base64"),
      "github-basic-auth",
    );
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
    const app = this.state?.app;
    if (app === undefined) return;
    const { run } = this;
    run.work = app.work;
    run.repo = app.repo;
    run.keyFile = app.keyFile;
    run.knownHostsFile = app.knownHostsFile;
    run.exampleCommit = app.exampleCommit;
    run.repoReady = true;
    if (app.appName !== undefined) run.appName = app.appName;
    run.env = this.cliEnv();
    if (app.server !== undefined) {
      run.server = app.server;
      run.root = this.shellOf(app.server.ipv4, run.keyFile, run.knownHostsFile);
    }
  }

  /** Saves the state, the values masked so far and this process's new CLI outputs. */
  async save(): Promise<void> {
    if (this.folder === "" || this.removed) return;
    await mkdir(join(this.folder, "outputs"), { recursive: true });
    if (this.state !== undefined) {
      await writeFile(this.file("pass.json"), `${JSON.stringify(this.state, null, 2)}\n`, {
        mode: 0o600,
      });
    }
    const known = persistedEntries(this.run.scrubber.entries()).filter(
      ({ label }) => !DERIVED_LABELS.includes(label),
    );
    await writeFile(this.file("known.json"), JSON.stringify(known), { mode: 0o600 });
    const outputs = [...this.run.outputs];
    const stamp = Date.now().toString(36);
    for (const [index, [label, output]] of outputs.entries()) {
      if (index < this.savedOutputs) continue;
      const shown = this.shown.get(label) === true ? "shown" : "search";
      await writeFile(
        join(this.folder, "outputs", `${stamp}-${String(index).padStart(3, "0")}.txt`),
        `${this.leg ?? "?"}\t${shown}\t${label}\n${output}`,
        { mode: 0o600 },
      );
    }
    this.savedOutputs = outputs.length;
  }

  /** Starts a new pass (H0), or keeps the one there (H0 run again before H1). */
  startPass(testerIpv4: string, zone: CloudflareZone): PassState {
    this.state ??= {
      runId: this.run.runId,
      startedAt: new Date().toISOString(),
      testerIpv4,
      zone,
      updaterToken: "a",
      legs: {},
      figures: {},
    };
    this.state.testerIpv4 = testerIpv4;
    this.state.zone = zone;
    return this.state;
  }

  /** Records the app's run as it is now, with `extra`, and saves. */
  async recordApp(extra: Partial<AppState> = {}): Promise<void> {
    const { run } = this;
    const state = this.pass();
    const hostname = extra.hostname ?? state.app?.hostname;
    if (hostname === undefined) throw new Error("The app has no hostname yet.");
    state.app = {
      ...state.app,
      work: run.work,
      repo: run.repo,
      keyFile: run.keyFile,
      knownHostsFile: run.knownHostsFile,
      exampleCommit: run.exampleCommit,
      hostname,
      ...(run.appName === undefined ? {} : { appName: run.appName }),
      ...(run.server === undefined ? {} : { server: run.server }),
      ...extra,
    };
    await this.save();
  }

  /** Records `figure` under `name` for the coverage page, and logs it. */
  figure(name: string, figure: string): void {
    this.pass().figures[name] = this.run.scrub(figure);
    this.log(`${name}: ${this.pass().figures[name]}`);
  }

  /** The updater token the server holds now (`OPSCREW_DNS_UPDATER_TOKEN`). */
  updaterToken(which = this.state?.updaterToken ?? "a"): string {
    return this.settings.updaterTokens[which];
  }

  /**
   * The CLI's environment, as `prepareRepo` makes it (`CI=1`, the run's OpsCrew home, the GitHub
   * token; never an `OPSCREW_E2E_*` variable, a cloud token or an SSH agent), with OpsCrew's
   * Cloudflare token and the updater's.
   */
  cliEnv(): Record<string, string | undefined> {
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
      OPSCREW_HOME: join(this.run.work, "home"),
      GITHUB_TOKEN: this.settings.githubToken,
      OPSCREW_APP_ENV_FILE: join(this.run.work, "production.env"),
      ...this.accountEnv(),
    };
  }

  /** OpsCrew's Cloudflare token and the updater token the server holds now. */
  accountEnv(): Record<string, string> {
    return {
      CLOUDFLARE_API_TOKEN: this.settings.cloudflareToken,
      OPSCREW_DNS_UPDATER_TOKEN: this.updaterToken(),
    };
  }

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

  private shellOf(host: string, keyFile: string, knownHostsFile: string): RootShell {
    return new RootShell(this.run.runner, { host, keyFile, knownHostsFile, env: this.run.env });
  }

  /** The app's health URL on its recorded hostname. */
  async healthUrl(): Promise<string> {
    return `https://${this.app().hostname}${(await this.run.readPlan()).app.healthPath}`;
  }

  /** `.opscrew/server.json`'s path. */
  serverJson(): string {
    return join(this.run.paths().stateDir, "server.json");
  }

  /** The last outside check this computer recorded. */
  /** `opscrew verify`, once more when its outside check didn't finish, as verify then says to. */
  async verify(): Promise<void> {
    await this.run.opscrewOk("verify");
    const check = await this.outsideCheck();
    if (check.http === "unfinished" || check.https === "unfinished") {
      this.log("the outside check didn't finish; verify again, as it says");
      await this.run.opscrewOk("verify");
    }
  }

  async outsideCheck(): Promise<z.infer<typeof OutsideCheckSchema>> {
    const check = outsideCheckOf(await readFile(this.serverJson(), "utf8"));
    if (check === undefined) throw new Error("verify recorded no outside check.");
    return check;
  }

  /** The SHA-256 of each engine state file, by name. */
  async stateHashes(): Promise<Record<string, string>> {
    const dir = this.run.paths().files.tfstateDir;
    const hashes: Record<string, string> = {};
    if (!existsSync(dir)) return hashes;
    for (const name of (await readdir(dir)).sort()) {
      hashes[name] = sha256(await readFile(join(dir, name), "utf8"));
    }
    return hashes;
  }

  /**
   * After every CLI run: whether its output may show the server's address (with DNS only, design
   * and status print it on purpose: H4, H5, or a plan that is neither proxied nor a tunnel), and
   * each version of the local files the leak scan reads (the saved plans, the state files,
   * `.opscrew/server.json`, `.opscrew/cloudflare.json`) kept in the pass's folder.
   */
  private async afterCli(): Promise<void> {
    const { run } = this;
    if (run.repo === "" || this.folder === "") return;
    const label = [...run.outputs.keys()].at(-1);
    if (label !== undefined) {
      const plan = await run.readPlan().catch(() => undefined);
      const direct = plan !== undefined && !usesTunnel(plan) && plan.dns.proxied !== true;
      this.shown.set(label, this.leg === "H4" || this.leg === "H5" || direct);
    }
    const paths = run.paths();
    const files = [paths.files.cloudflareRecord, this.serverJson()];
    for (const dir of [paths.files.plansDir, paths.files.tfstateDir]) {
      if (!existsSync(dir)) continue;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isFile()) files.push(join(dir, entry.name));
      }
    }
    await mkdir(join(this.folder, "kept"), { recursive: true });
    for (const file of files) {
      if (!existsSync(file)) continue;
      const text = await readFile(file, "utf8").catch(() => "");
      if (text === "") continue;
      const kept = join(this.folder, "kept", `${sha256(text).slice(0, 32)}.txt`);
      if (!existsSync(kept)) {
        await writeFile(kept, `${relative(run.repo, file)}\n${text}`, { mode: 0o600 });
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // The commands, as a script runs them.

  /**
   * The interview for the home server: the user's own server at its address (root, the test key),
   * at home, `serve`, SSH only from this computer; the app's hostname on Cloudflare.
   */
  async interview(serve: Serve): Promise<void> {
    const { run } = this;
    const answers = join(run.work, "answers.json");
    await writeFile(
      answers,
      JSON.stringify({
        provider: "own",
        expectedMonthlyUsers: "<1k",
        budgetMonthly: 20,
        uptime: "best-effort",
        dataCriticality: "important",
        dnsProvider: "cloudflare",
        domain: this.app().hostname,
        keepExternalServices: { s3: false },
        "server.host": run.ipv4(),
        "server.port": 22,
        "server.user": "root",
        "server.key": run.keyFile,
        "server.home": "yes",
        "server.serve": serve,
        "server.sshFrom": `${this.pass().testerIpv4}/32`,
      }),
    );
    await run.opscrewOk("interview", "--answers", answers);
  }

  /**
   * `opscrew provision` as a script runs it: `--plan-only`, then every hash it printed approved
   * with the names its printed command types (only the app's), until a run exits 0; a plan-only
   * run with nothing to approve finishes with `provision --yes`. `overrides` go into each run's
   * environment. Returns every run's output.
   */
  async provision(label: string, overrides: Record<string, string> = {}): Promise<string> {
    const { run } = this;
    const all: string[] = [];
    const tried = new Set<string>();
    for (let round = 1; round <= 5; round++) {
      const planned = await run.opscrewOkWith(overrides, "provision", "--plan-only", "--yes");
      all.push(planned.output);
      const hashes = approveHashes(planned.output);
      if (hashes.length === 0) {
        all.push((await run.opscrewOkWith(overrides, "provision", "--yes")).output);
        return all.join("\n");
      }
      const key = hashes.join(" ");
      if (tried.has(key)) {
        throw new Error(
          `${label}: provision planned the same plans again after they were approved:\n${run.tail(planned.output)}`,
        );
      }
      tried.add(key);
      const names = printedConfirms(planned.output);
      const others = names.filter((name) => name !== run.app());
      if (others.length > 0) {
        throw new Error(
          `${label}: the printed command types ${others.length} name(s) other than the app's, so nothing was approved:\n${run.tail(planned.output)}`,
        );
      }
      const applied = await run.opscrewWith(
        overrides,
        "provision",
        ...hashes.flatMap((hash) => ["--approve", hash]),
        ...names.flatMap((name) => ["--confirm", name]),
        "--yes",
      );
      all.push(applied.output);
      if (applied.exitCode === 0) return all.join("\n");
      run.log(`${label}: provision stopped after its approvals; planning again`);
    }
    throw new Error(`${label}: opscrew provision did not finish after 5 rounds of plans.`);
  }

  /** `opscrew <args>` as a script runs it: each `--approve <hash>` it prints, until it exits 0. */
  untilApproved(args: readonly string[], overrides: Record<string, string> = {}): Promise<CliRun> {
    return opscrewUntilApproved(this.run, args, (...all) =>
      this.run.opscrewWith(overrides, ...all),
    );
  }

  /** `opscrew restore --drill <args> --json` as a script runs it ({@link approvedDrill}). */
  async drill(args: readonly string[]): Promise<DrillReport> {
    return (await approvedDrill(this.run, args, "Drill hash")).report;
  }

  /** `opscrew restore --drill --remove` as a script runs it: the removal approved by its hash. */
  async removeDrill(): Promise<void> {
    const { applied } = await approvedDrill(this.run, ["--remove"], "Removal hash");
    if (applied.exitCode !== 0) {
      throw new Error(
        `opscrew restore --drill --remove exited with ${applied.exitCode}:
${this.run.tail(applied.output)}`,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // The router's stand-in and the scanner, at Hetzner.

  private hetzner(method: string, path: string, body?: unknown) {
    return api(HETZNER_API, this.settings.hcloudToken, method, path, body);
  }

  /** The id of the firewall `createServer` made with the home server (the run's only one). */
  async routerFirewallId(): Promise<number> {
    const selector = encodeURIComponent(`managed-by=opscrew-e2e,run=${this.pass().runId}`);
    const listed = await this.hetzner("GET", `/firewalls?label_selector=${selector}`);
    const firewalls = (listed.json as { firewalls?: { id: number }[] } | undefined)?.firewalls;
    const [only] = firewalls ?? [];
    if (listed.status !== 200 || firewalls?.length !== 1 || only === undefined) {
      throw new Error(
        `Hetzner did not list one firewall of the run (HTTP ${listed.status}, ${firewalls?.length ?? 0} listed).`,
      );
    }
    return only.id;
  }

  /** Sets the router's rules ({@link routerRules}) and waits until Hetzner applied them. */
  async setRouter(options: { sshFromAnywhere?: boolean; https?: boolean } = {}): Promise<void> {
    const id = this.app().firewallId;
    if (id === undefined) throw new Error("H1 recorded no firewall.");
    const set = await this.hetzner("POST", `/firewalls/${id}/actions/set_rules`, {
      rules: routerRules(this.pass().testerIpv4, options),
    });
    const actions = (set.json as { actions?: { id: number }[] } | undefined)?.actions;
    if (set.status !== 201 || actions === undefined) {
      throw new Error(`Hetzner refused the router's new rules (HTTP ${set.status}).`);
    }
    for (const action of actions) {
      await waitFor(
        "Hetzner applying the router's rules",
        minutes(3),
        async () => {
          const got = await this.hetzner("GET", `/firewalls/actions/${action.id}`);
          const status = (got.json as { action?: { status?: string } } | undefined)?.action?.status;
          if (status === "error") throw new Error("Hetzner's action ended with an error.");
          return status === "success" ? true : undefined;
        },
        3_000,
      );
    }
    this.log(
      `the router now lets in 80${options.https === false ? "" : ", 443"} and SSH ${options.sshFromAnywhere === true ? "from anywhere" : "from this computer"}`,
    );
  }

  /**
   * The outside scanner: a throwaway x86 server of the run with an SSH key of its own (Hetzner
   * refuses a second key resource for the same public key), made the first time; its addresses
   * masked, never searched for. Returns root's shell on it.
   */
  async scanner(): Promise<RootShell> {
    const state = this.pass();
    const { run } = this;
    if (state.scanner === undefined) {
      const keyFile = join(run.work, "keys", "scanner_ed25519");
      const knownHostsFile = join(run.work, "keys", "scanner_known_hosts");
      if (!existsSync(keyFile)) {
        const keygen = await run.runner.run(
          "ssh-keygen",
          ["-q", "-t", "ed25519", "-N", "", "-C", `opscrew-e2e-scan-${state.runId}`, "-f", keyFile],
          { env: run.env, timeoutMs: 60_000 },
        );
        if (keygen.exitCode !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr.trim()}`);
      }
      run.scrubber.add(await readFile(keyFile, "utf8"), "scanner-private-key");
      const regions = providerProfile("hetzner").regionLocations;
      const server = await createThrowawayServer({
        token: this.settings.hcloudToken,
        runId: state.runId,
        name: `opscrew-e2e-home-scan-${state.runId}`,
        publicKey: (await readFile(`${keyFile}.pub`, "utf8")).trim(),
        locations: regions[this.settings.region as Region] ?? [],
        ids: {},
        log: this.log,
      });
      run.scrubber.add(server.ipv4, "mask-scanner-ipv4");
      run.scrubber.add(server.ipv6, "mask-scanner-ipv6");
      state.scanner = { server, keyFile, knownHostsFile };
      await this.save();
      const hostKey = await waitFor(
        "the scanner's SSH host key",
        minutes(5),
        async () => {
          const scan = await run.runner.run(
            "ssh-keyscan",
            ["-T", "10", "-t", "ed25519", server.ipv4],
            { env: run.env, timeoutMs: 30_000 },
          );
          return ed25519FromKeyscan(scan.stdout);
        },
        5_000,
      );
      await writeFile(knownHostsFile, `${server.ipv4} ssh-ed25519 ${hostKey}\n`);
      const shell = this.shellOf(server.ipv4, keyFile, knownHostsFile);
      await waitFor(
        "root logging in on the scanner",
        minutes(3),
        async () => ((await shell.run("true", 30_000)).exitCode === 0 ? true : undefined),
        5_000,
      );
      const cloudInit = await shell.run("cloud-init status --wait", minutes(15));
      if (![0, 2].includes(cloudInit.exitCode)) {
        throw new Error(`cloud-init did not finish on the scanner (exit ${cloudInit.exitCode}).`);
      }
    }
    const { server, keyFile, knownHostsFile } = state.scanner;
    return this.shellOf(server.ipv4, keyFile, knownHostsFile);
  }

  /** The home server's ports `ports` tried from the scanner, over IPv4 and IPv6 as `families` say. */
  async scan(
    ports: readonly number[],
    families: readonly ("IPv4" | "IPv6")[] = ["IPv4", "IPv6"],
  ): Promise<Record<string, ScanResult>> {
    const server = this.app().server;
    if (server === undefined) throw new Error("H1 recorded no server.");
    const targets: ScanTarget[] = [];
    for (const family of families) {
      const address = family === "IPv4" ? server.ipv4 : server.ipv6;
      if (address === undefined) throw new Error(`The home server has no ${family} address.`);
      for (const port of ports) targets.push({ label: family, address, port });
    }
    const shell = await this.scanner();
    return parseScan(await shell.ok(`bash -c ${shellQuote(scanScript(targets))}`, minutes(3)));
  }

  // -------------------------------------------------------------------------------------------
  // The updater's records at Cloudflare.

  /** The A and AAAA records the address updater keeps at the app's hostname. */
  async updaterRecords(): Promise<HomeRecord[]> {
    const host = encodeURIComponent(this.app().hostname);
    const records = await this.cloudflare.list<HomeRecord>(
      `/zones/${this.zone().id}/dns_records?name=${host}`,
    );
    return records.filter(
      (record) =>
        record.comment === DNS_UPDATER_RECORD_COMMENT &&
        (record.type === "A" || record.type === "AAAA"),
    );
  }

  /** Waits up to `timeoutMs` until the updater's records satisfy `check` (records never printed). */
  waitForRecords(
    what: string,
    timeoutMs: number,
    check: (records: HomeRecord[]) => boolean,
  ): Promise<HomeRecord[]> {
    return waitFor(
      what,
      timeoutMs,
      async () => {
        const records = await this.updaterRecords();
        return check(records) ? records : undefined;
      },
      5_000,
    );
  }

  /** Sets the content of the updater's `record` (a new home address, as the stand-in makes one). */
  async setRecordContent(record: HomeRecord, content: string): Promise<void> {
    const set = await this.cloudflare.call(
      "PATCH",
      `/zones/${this.zone().id}/dns_records/${record.id}`,
      { content },
    );
    if (set.status !== 200)
      throw new Error(`Cloudflare refused the record's change (HTTP ${set.status}).`);
  }

  // -------------------------------------------------------------------------------------------
  // The leak scan and the cleanup.

  /** The outside check's workflow runs since the pass started (every leg's). */
  private async outsideCheckRuns(): Promise<number[]> {
    const { github } = this.run;
    const since = this.pass().startedAt.slice(0, 10);
    const got = await github.call(
      "GET",
      `/repos/${github.name}/actions/runs?per_page=100&created=${encodeURIComponent(`>=${since}`)}`,
    );
    if (got.status !== 200) throw new Error(`GitHub did not list the runs (HTTP ${got.status}).`);
    const runs =
      (got.json as { workflow_runs?: { id: number; path?: string }[] } | undefined)
        ?.workflow_runs ?? [];
    return runs
      .filter((run) => run.path?.endsWith(OUTSIDE_CHECK_WORKFLOW_FILE) === true)
      .map((run) => run.id);
  }

  /**
   * The leak scan over the whole pass (SC-2906): every secret the pass knows (the tokens, the
   * keys, OpsCrew's generated values, the tunnel's outputs) in every CLI output of every leg, every
   * kept version of the saved plans, state files, `server.json` and `cloudflare.json`, the commits
   * of every branch, the pull requests since the pass started, the audit log and the outside
   * check's run logs; the home server's addresses in commits, pull requests and those run logs, in
   * every output that doesn't show them on purpose (with DNS only), and its IPv6 address in
   * `server.json`, which never keeps a public address (the stand-in's IPv4 address is also its
   * address on the home network, which it keeps). This computer's address and the scanner's are
   * never searched for. Returns the problems, by label and place only.
   */
  async leaks(): Promise<string[]> {
    const { run } = this;
    const { secrets, addresses } = leakSearchValues(run.scrubber.entries());
    const ipv6 = addresses.filter(({ label }) => label === "server-ipv6");
    const problems: string[] = [];
    const search = (where: string, text: string, values: typeof secrets) => {
      const found = leakedLabels(text, values);
      if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
    };
    if (this.state?.app !== undefined && run.repoReady) {
      const sources = await leakSourcesOf({
        git: (...args) => run.git(...args),
        github: run.github,
        startedAt: new Date(this.pass().startedAt),
        auditDir: run.paths().auditDir,
      });
      for (const source of sources) {
        search(
          source.where,
          source.text,
          source.kind === "audit log" ? secrets : [...secrets, ...addresses],
        );
      }
      const ids = await this.outsideCheckRuns();
      for (const id of ids) {
        for (const job of OUTSIDE_CHECK_JOBS) {
          const where = `the outside check's ${job} job log (run ${id})`;
          const text = await jobLog(run.github, id, job).catch((error: unknown) => {
            problems.push(`${where} is unreadable: ${String(error)}`);
            return "";
          });
          search(where, text, [...secrets, ...addresses]);
        }
      }
      this.log(`the leak scan read the logs of ${ids.length} outside check runs`);
    }
    for (const dir of ["outputs", "kept"] as const) {
      for (const file of await readdir(join(this.folder, dir)).catch(() => [] as string[])) {
        const text = await readFile(join(this.folder, dir, file), "utf8");
        const [header = file, ...rest] = text.split("\n");
        const body = rest.join("\n");
        if (dir === "kept") {
          const serverRecord = header.replaceAll("\\", "/").endsWith("server.json");
          search(
            `a kept version of ${header}`,
            body,
            serverRecord ? [...secrets, ...ipv6] : secrets,
          );
          continue;
        }
        const [leg, shown, label = file] = header.split("\t");
        const where = `the output of ${label} (${leg})`;
        search(where, body, secrets);
        if (shown === "shown") continue;
        const lines = addressLinesOutsidePurpose(
          body,
          addresses.map(({ value }) => value),
        );
        if (lines > 0) problems.push(`${where} printed the server's address on ${lines} line(s)`);
      }
    }
    return problems;
  }

  /**
   * What is left of the pass, removed and listed: the run's servers, their keys and the firewall
   * at Hetzner; the app's runner on the repository; at Cloudflare the app's records (the run's
   * hostnames), tunnels, Access applications, policies and service tokens (by the app's name,
   * which is the run's alone), its origin TLS (by its hostnames) and its hostnames in OpsCrew's
   * shared rules; the repository's `main` put back to the example and reset. Returns what is still
   * left (each as a problem) and what was removed.
   */
  async cleanup(): Promise<{ removed: string[]; left: string[] }> {
    const state = this.pass();
    const { run } = this;
    const removed: string[] = [];
    const left: string[] = [];
    const app = state.app;
    left.push(
      ...(await deleteThrowaway({
        token: this.settings.hcloudToken,
        runId: state.runId,
        ids: {
          ...(app?.server === undefined ? {} : { serverId: app.server.id }),
          ...(app?.firewallId === undefined ? {} : { firewallId: app.firewallId }),
        },
      })),
    );
    if (app?.appName !== undefined) {
      const zone = this.zone();
      const hosts = [app.hostname, `www.${app.hostname}`];
      const match = leftoverMatch([app.appName], `e2e-${state.runId}`);
      const account = `/accounts/${zone.accountId}`;
      const sweep = async (
        what: string,
        path: string,
        pick: (name: string) => boolean,
        before?: (id: string) => Promise<unknown>,
      ) => {
        let items: { id: string; name?: string }[];
        try {
          items = await this.cloudflare.list<{ id: string; name?: string }>(path);
        } catch (error) {
          left.push(`Cloudflare: the ${what}s were not listed (${String(error)})`);
          return;
        }
        for (const item of items.filter((one) => pick(one.name ?? ""))) {
          await before?.(item.id);
          const deleted = await retryDelete(() =>
            this.cloudflare.call("DELETE", `${path.split("?")[0]}/${item.id}`),
          );
          (deleted ? removed : left).push(`Cloudflare: ${what} ${item.name ?? item.id}`);
        }
      };
      await sweep("Access application", `${account}/access/apps`, match.piece);
      await sweep("Access policy", `${account}/access/policies`, match.piece);
      await sweep("service token", `${account}/access/service_tokens`, match.piece);
      await sweep("tunnel", `${account}/cfd_tunnel?is_deleted=false`, match.piece, (id) =>
        this.cloudflare.call("DELETE", `${account}/cfd_tunnel/${id}/connections`),
      );
      await sweep("DNS record", `/zones/${zone.id}/dns_records`, match.record);
      if (state.tlsBefore !== undefined) {
        const tls = await this.cloudflare
          .removeTlsOfRun(zone, state.tlsBefore, hosts, this.log)
          .catch((error: unknown) => ({ removed: [], problems: [`origin TLS: ${String(error)}`] }));
        removed.push(...tls.removed.map((what) => `Cloudflare: ${what}`));
        left.push(...tls.problems);
      }
      left.push(
        ...(await this.cloudflare
          .removeRulesOfRun(zone, await this.cloudflare.sharedEntrypoints(zone), {
            hostnames: hosts,
            log: this.log,
          })
          .catch((error: unknown) => [`OpsCrew's shared rules: ${String(error)}`])),
      );
      const label = await run
        .readPlan()
        .then(runnerLabel)
        .catch(() => undefined);
      if (label !== undefined) {
        for (const runner of await run.github.runners().catch(() => [])) {
          if (!runner.labels.includes(label)) continue;
          const deleted = await run.github.call(
            "DELETE",
            `/repos/${run.github.name}/actions/runners/${runner.id}`,
          );
          (deleted.status === 204 ? removed : left).push(`GitHub: the runner ${runner.name}`);
        }
      }
    }
    if (app !== undefined && run.repoReady) {
      await run
        .restoreMain()
        .catch((error: unknown) => left.push(`main of ${run.github.name}: ${String(error)}`));
      await run.github
        .reset()
        .catch((error: unknown) => left.push(`reset ${run.github.name}: ${String(error)}`));
    }
    return { removed, left };
  }

  /**
   * Removes the pass's folder (H7, once nothing is left), keeping a copy of its CLI outputs beside
   * it (`opscrew-e2e-home-outputs-<run id>`), so a step that failed can still be read: they hold
   * no token (the CLI's redactor) and are removed by hand once read.
   */
  async removeFolder(): Promise<void> {
    const kept = join(dirname(this.folder), `opscrew-e2e-home-outputs-${this.pass().runId}`);
    await cp(join(this.folder, "outputs"), kept, { recursive: true }).catch(() => undefined);
    this.log(`its CLI outputs stay in ${kept}`);
    await rm(this.folder, { recursive: true, force: true });
    this.removed = true;
  }
}

// ---------------------------------------------------------------------------------------------
// A leg: its steps in order.

/** The leg this process opened: one a process. */
let openedLeg: HomeLeg | undefined;

/**
 * One leg in one process: opens the pass before its first step (after checking the legs before it
 * passed), saves it after each step and its last, and records its outcome. The steps after a
 * failure are skipped, unless `always`.
 */
export class Leg {
  private failed = false;
  /** The leg passed its checks and opened the pass: only then is anything recorded or saved. */
  private started = false;

  constructor(
    private readonly pass: HomePass,
    readonly leg: HomeLeg,
  ) {
    beforeAll(async () => {
      if (openedLeg !== undefined && openedLeg !== leg) {
        this.failed = true;
        throw new Error(
          `${leg} can't start: this run has ${openedLeg} too. Run one leg at a time with -t "${leg}:" (docs/e2e.md).`,
        );
      }
      openedLeg = leg;
      pass.leg = leg;
      await pass.open();
      const problem = legOrderProblem(pass.state, leg);
      if (problem !== undefined) {
        this.failed = true;
        throw new Error(`${leg} can't start yet: ${problem} (docs/e2e.md).`);
      }
      this.started = true;
      if (pass.state !== undefined) {
        pass.state.legs[leg] = { startedAt: new Date().toISOString(), outcome: "running" };
        await pass.save();
      }
    }, minutes(10));
    const startedAt = new Date().toISOString();
    afterAll(async () => {
      if (!this.started) return;
      // H0 makes the state in its first step, so its record may start only here.
      const { state } = pass;
      if (state !== undefined) {
        state.legs[leg] ??= { startedAt, outcome: "running" };
        const record = state.legs[leg];
        record.endedAt = new Date().toISOString();
        if (record.outcome === "running") record.outcome = this.failed ? "failed" : "passed";
      }
      await pass.save();
    }, minutes(10));
  }

  step(
    title: string,
    timeoutMs: number,
    body: () => Promise<void>,
    options: { always?: boolean } = {},
  ): void {
    const others = otherLegsNamed(this.leg, title);
    if (others.length > 0) {
      throw new Error(
        `${this.leg}'s step "${title}" names ${others.join(" and ")}: -t would select it with that leg too.`,
      );
    }
    it(`${this.leg}: ${title}`, { timeout: timeoutMs }, async (context) => {
      if (this.failed && options.always !== true) context.skip();
      context.onTestFailed(() => {
        this.failed = true;
      });
      this.pass.log(`${this.leg}, step: ${title}`);
      try {
        await body();
      } catch (error) {
        this.failed = true;
        throw this.pass.run.cleanError(error);
      } finally {
        await this.pass.save();
      }
    });
  }
}

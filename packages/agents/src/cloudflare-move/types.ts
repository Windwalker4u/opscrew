/**
 * The types of a move of an app to another Cloudflare account (`opscrew cloudflare move`): its
 * session, its services, the shadow roots, a step's stop, each command's options and result, and
 * the summary shown before the first change. A is the account that holds the zone when the move
 * starts, B the one it moves to.
 */
import type { CloudflareClient } from "@opscrew/connector-cloudflare";
import type { GitClient } from "@opscrew/connector-github";
import type { FetchLike, IacEngine } from "@opscrew/contracts";
import type { ProjectPaths } from "@opscrew/core";
import type { EnginePreference } from "@opscrew/iac-engine";
import type { CloudflareMove } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { DomainServices } from "../domain";
import type { CloudflareSetup, GitHubSetup, ProvisionServices } from "../provision";
import type { BucketSize } from "../retarget/bucket";
import type { RetargetGitHubApi } from "../retarget/types";
import type { HostAdapterApi } from "../shared";
import type { MoveRoot } from "./progress";
import type { MoveRecordPlan } from "./record";

/** A Cloudflare zone as the client reads it: its id, name, status, nameservers and account. */
export type MoveZone = Awaited<ReturnType<CloudflareClient["getZone"]>>;

/**
 * Collaborators that talk to the outside world. Each defaults to the real implementation built
 * from `PhaseDeps`; tests replace them with fakes.
 */
export interface MoveServices
  extends Pick<
    ProvisionServices,
    // The IaC engine (a fake in tests).
    | "engine"
    // The deploy user's shell on a server, and the Docker API there (rclone, Portainer's proxy).
    | "remote"
    | "docker"
    // The user's own server as its admin login, and the user's Portainer.
    | "own"
    | "portainer"
    // B's bucket keys, asked once in a terminal when the environment doesn't hold them.
    | "askStorageKey"
    | "sleep"
    | "now"
  > {
  /** A's Cloudflare client (default: `CLOUDFLARE_API_TOKEN`'s). */
  cloudflare?: CloudflareClient;
  /** B's Cloudflare client (default: `OPSCREW_NEW_CLOUDFLARE_API_TOKEN`'s). */
  newCloudflare?: CloudflareClient;
  /** GitHub's REST API (default: a client from the user's token); `null` means no token. */
  github?: RetargetGitHubApi | null;
  /**
   * The host adapter on a server, for the connector beside A's (default: `inspectHost` and
   * `applyHostPlan`).
   */
  host?: HostAdapterApi;
  /** The domain commands' registrars: the switch's nameservers and DS records. */
  registrars?: DomainServices;
  /** HTTPS and DNS-over-HTTPS from this computer (default: `deps.fetch`). */
  fetch?: FetchLike;
}

/** One account of the move: its client (with its own token), its id and the zone in it. */
export interface MoveAccount {
  client: CloudflareClient;
  accountId: string;
  /** Its name, when the session read it (B's always). */
  name?: string;
  /**
   * The zone in this account when the session opened; `undefined` when it has none (B's before
   * prepare adds it, A's once Cloudflare deleted the moved zone).
   */
  zone?: MoveZone;
}

/** Both accounts of the move. */
export interface MoveAccounts {
  /** A: the account that holds the zone when the move starts, with its zone's id. */
  a: MoveAccount & { zoneId: string };
  /** B: the account the zone moves to; its `CloudflareSetup` once its zone exists. */
  b: MoveAccount & { setup?: CloudflareSetup };
}

/** A covered environment: its name, its paths and its plan as last written. */
export type MoveEnvironment = MoveRecordPlan;

/** An environment of the app the move doesn't cover, since its domain is not in the zone. */
export interface StayingEnvironment {
  name: string;
  /** Its DNS is on Cloudflare (`dns.provider`). */
  cloudflare: boolean;
  /**
   * Its zone, when it is in another zone A's token sees (in any of its accounts) or its plan names
   * one; `undefined` off Cloudflare, or when A's token sees no zone for its domain.
   */
  zone?: string;
}

/** Everything the steps of one run share: both accounts checked, the engine ready. */
export interface MoveSession {
  deps: PhaseDeps;
  services: MoveServices;
  /** The app's paths (prod's, the app's local files beside them). */
  paths: ProjectPaths;
  /** The zone that moves. */
  zone: string;
  /** The environments the move covers: every deployed one whose domain is in the zone. */
  environments: MoveEnvironment[];
  /** The app's environments in another zone, or not on Cloudflare: they stay as they are. */
  staying: StayingEnvironment[];
  /** The app's environments in the zone that are not deployed (destroyed, or never applied). */
  skipped: string[];
  accounts: MoveAccounts;
  /**
   * The hostnames of the other OpsCrew apps in A's zone (its records with OpsCrew's comment and its
   * Workers custom domains that are none of this app's), sorted; read while A's zone is active.
   */
  otherHostnames: string[];
  git: GitClient;
  github: GitHubSetup;
  githubApi: RetargetGitHubApi;
  engine: IacEngine;
  /**
   * The engine's environment: the phase's, with `TF_ENCRYPTION` when it applies, as the first
   * covered environment's state reads it (its key name). A step that runs the engine for another
   * environment whose states have another key name builds that environment's own
   * (`existingStateEngine` with its paths). Never logged.
   */
  env: Record<string, string | undefined>;
  /** `--approve <hash>` until a step used it. */
  approve: string | undefined;
  /** The command that continues after a stop (`opscrew cloudflare move`, `… --finish`). */
  command: string;
}

/**
 * One of an environment's roots that holds Cloudflare resources, planned in B with a state and a
 * data folder of its own (data model 3).
 */
export interface ShadowRoot {
  /** The environment it belongs to. */
  environment: string;
  name: MoveRoot;
  /** The committed root module's folder (absolute). */
  dir: string;
  /** The shadow state file, under the environment's `cloudflare-move/tfstate/`. */
  statePath: string;
  /** Its `TF_DATA_DIR`, under the environment's `cloudflare-move/tf/`. */
  dataDir: string;
  /** The `-var`s with B's ids (`accountVariables`, and `custom_domains=false` for a site). */
  vars: Record<string, string>;
}

/** Why a step stopped the run on purpose, and how to go on. */
export interface StepStop {
  /** A non-interactive run's saved plan: the next run applies it with `--approve <hash>`. */
  pendingPlanHash?: string;
  /** What to do next, in plain words: the command to run again, and when. */
  next: string[];
}

/** What a command of the move reached. */
export interface MoveResult extends StepStop {
  /** The record's step, or `switched`, `finished` or `aborted`. */
  step: CloudflareMove["step"] | "switched" | "finished" | "aborted";
  /** True when the command did all it can; false when it stopped on purpose (`next` says why). */
  done: boolean;
}

/** What every command of the move takes. */
export interface MoveCommandOptions {
  /** `--approve <hash>`: apply the saved plan with this hash (from an earlier run) and go on. */
  approvePlanHash?: string;
  /** `--engine`: overrides `plan.infra.engine`. */
  engine?: EnginePreference;
  services?: MoveServices;
}

/** `opscrew cloudflare move [--to <account>]`: prepare, or continue it. */
export interface PrepareMoveOptions extends MoveCommandOptions {
  /** `--to`: B's id or exact name; without it a recorded move continues. */
  to?: string;
  /** Shown once before the first change; returning false stops with nothing changed. */
  confirmStart?: (summary: MoveSummary) => Promise<boolean>;
}

/** What a name typed to confirm a change or deletion stands for. */
export type TypedNameKind = "app" | "bucket" | "domain" | "zone";

/** A name the user types to confirm a change or deletion, and what it confirms. */
export interface TypedNameQuestion {
  kind: TypedNameKind;
  /** The name to type: the app's, a bucket's, the domain or the zone. */
  name: string;
  /** What typing it confirms, in words (for the prompt). */
  what: string;
}

/** The typed names of the switch, the finish and the abort. */
export interface TypedNameOptions {
  /** `--confirm <name>` (repeatable): the names a script types (the app, each bucket, the domain, the zone). */
  confirm?: readonly string[];
  /** Asks the user to type `question.name` in a terminal; true when it was typed. */
  typeName?: (question: TypedNameQuestion) => Promise<boolean>;
}

/** `opscrew cloudflare move --switch`. */
export interface SwitchMoveOptions extends MoveCommandOptions, TypedNameOptions {}

/** `opscrew cloudflare move --finish`. */
export interface FinishMoveOptions extends MoveCommandOptions, TypedNameOptions {
  /** `--allow-downtime`: the R2 window without a prompt (non-interactive runs). */
  allowDowntime?: boolean;
}

/** `opscrew cloudflare move --abort`. */
export interface AbortMoveOptions extends MoveCommandOptions, TypedNameOptions {}

/** One of the app's R2 buckets in A, as `rclone size` measured it on the app's server. */
export interface MoveBucketSize extends BucketSize {
  environment: string;
  /** The app's bucket (`storage`) or the snapshots' copies (`backups`). */
  root: Extract<MoveRoot, "storage" | "backups">;
  bucket: string;
}

/** What the move will do, shown before anything changes (plan 4.2). */
export interface MoveSummary {
  zone: string;
  from: { accountId: string };
  to: { accountId: string; name?: string };
  /** Each covered environment and its pieces in B, in words. */
  environments: { name: string; pieces: string[] }[];
  staying: StayingEnvironment[];
  skipped: string[];
  /** The other OpsCrew apps in the zone, by hostname: each needs its own prepare. */
  otherHostnames: string[];
  /** Each bucket copied once at prepare, with the copy's rough minutes. */
  buckets: (MoveBucketSize & { minutes: number })[];
  /** The finish's maintenance window per environment with an app bucket, in rough minutes. */
  windows: { environment: string; minutes: number }[];
  /** The summary as printed. */
  lines: string[];
}

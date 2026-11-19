import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalSshSource, MAX_SSH_SOURCES } from "@opscrew/connector-ssh-host";
import { listText, normalizeHostName, OpsCrewError, type ProjectPaths } from "@opscrew/core";
import {
  AppKeySchema,
  appsOf,
  EnvironmentNameSchema,
  environmentsOf,
  type Question,
  type RepositoryApp,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { FIRST_APP, mayHaveFurtherApps } from "../apps/choice";
import {
  deepDomainProblem,
  type OwnServerConnection,
  readOwnServer,
  recordOwnServer,
  type SharesReference,
} from "../shared";
import { ownServerKeyFile } from "../shared/own-server";
import {
  booleanAnswer,
  FIX_ANSWERS_HINT,
  type FollowUps,
  hasFollowUps,
  isBlank,
  portAnswer,
  withDefault,
} from "./follow-ups";
import type { InterviewAnswers } from "./questions";

/** The follow-ups for a server of the user's, reached with their own SSH login. */
const OWN_FIELDS = [
  "host",
  "home",
  "port",
  "user",
  "key",
  "reachable",
  "serve",
  "sshFrom",
] as const;
/**
 * The follow-ups for a server another of the user's OpsCrew apps runs on, one OpsCrew created for
 * that app (the first app): its repository folder on this computer, its app key (`.` for the
 * repository's first app) and its environment.
 */
export const SHARES_FIELDS = ["shares", "shares-app", "shares-env"] as const;
/** The follow-up answers for a server the user already has (`server.<field>` in answers files). */
export const SERVER_FIELDS = [...OWN_FIELDS, ...SHARES_FIELDS] as const;
/** One follow-up answer for a server the user already has. */
export type ServerField = (typeof SERVER_FIELDS)[number];
/**
 * The terminal's first question for a server the user already has: one of theirs, or the server
 * of another of their OpsCrew apps ({@link askServerQuestions}). Never an answer of its own: the
 * `server.shares` answers say the second.
 */
export const SERVER_KIND_ID = "server.kind";
/** Id of a follow-up question, for example `server.host`. */
export type ServerQuestionId = `server.${ServerField}` | typeof SERVER_KIND_ID;

/** A follow-up question for a server the user already has (same shape as a {@link Question}). */
export interface ServerQuestion extends Omit<Question, "id"> {
  id: ServerQuestionId;
}

/**
 * How OpsCrew reaches a server the user already has, as answered in the interview. Local only
 * (`.opscrew/server.json` → `own`): never in `opscrew/requirements.yaml`, the plan, pull requests
 * or commit messages. No password, passphrase or key material: the key is a path, or the SSH agent.
 */
export interface OwnServerAnswers {
  /** IP address or host name. */
  host: string;
  /** SSH port (22 by default). */
  port: number;
  /** The admin login: root or a user with passwordless sudo. */
  user: string;
  /** Absolute path to the private key; absent when `agent` is true. */
  keyPath?: string;
  /** Use the SSH agent. */
  agent: boolean;
  /**
   * True when the internet reaches the server directly; false means a Cloudflare Tunnel. Absent
   * for a server at home ({@link home}), which the router's forwards reach.
   */
  reachable?: boolean;
  /**
   * Present when the server is at home (`server.home yes`): it serves the site from the home's own
   * address, or through the tunnel.
   */
  home?: OwnServerHome;
  /**
   * How the site is served when the server is reachable and its domain is on Cloudflare: through
   * a Cloudflare Tunnel (recommended, the default), directly behind Cloudflare's proxy with
   * OpsCrew's web filter (`proxy`), or directly with DNS only. Without a Cloudflare domain only
   * `dns-only` applies.
   */
  serve: OwnServerServe;
}

/** The interview's answer to how the site is served (see {@link OwnServerAnswers.serve}). */
export type OwnServerServe = "tunnel" | "proxy" | "dns-only";

/** The answers about a server at home (see {@link OwnServerAnswers.home}). */
export interface OwnServerHome {
  /**
   * `server.sshFrom`: the addresses and networks that may reach SSH, in the form nft prints them;
   * absent leaves design's default (the home network and `fe80::/10`).
   */
  sshFrom?: string[];
}

const SERVE_VALUES = ["tunnel", "proxy", "dns-only"] as const;

/** A DNS name or a single host label; never starts with `-`, so `ssh` cannot read it as an option. */
const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
/** `/…`, `~/…`, `C:\…` or `C:/…`. */
const ABSOLUTE_PATH = /^(?:\/|~\/|[A-Za-z]:[\\/])[^\0\r\n]*$/;

/** A server's address: an IP address or a host name (never an `ssh` option). */
export const HostSchema = z.union([z.ipv4(), z.ipv6(), z.string().regex(HOST_NAME)]);

const OwnServerAnswersSchema = z
  .strictObject({
    host: HostSchema,
    port: z.int().min(1).max(65535),
    user: z.string().regex(USER_NAME),
    keyPath: z
      .string()
      .regex(ABSOLUTE_PATH)
      .refine((path) => !looksLikeKeyMaterial(path))
      .optional(),
    agent: z.boolean(),
    reachable: z.boolean().optional(),
    home: z
      .strictObject({
        sshFrom: z
          .array(z.string().refine((source) => canonicalSshSource(source) === source))
          .min(1)
          .max(MAX_SSH_SOURCES)
          .optional(),
      })
      .optional(),
    serve: z.enum(SERVE_VALUES),
  })
  .refine((own) => own.agent !== (own.keyPath !== undefined))
  .refine((own) => (own.home === undefined) === (own.reachable !== undefined));

function looksLikeKeyMaterial(text: string): boolean {
  return text.includes("-----BEGIN") || text.includes("PRIVATE KEY");
}

/** Keys that would hold a secret OpsCrew never takes. */
const SECRET_KEYS = /pass(word|phrase)?$|^secret$|^private_?key$/i;

const NEVER_A_PASSWORD =
  "OpsCrew never asks for or stores a password or passphrase: give the path to your SSH key, or `agent` to use the SSH agent (which also handles a key with a passphrase).";

/** Refuses answers whose keys would hold a password, passphrase or key (never echoing them). */
function refuseSecretAnswers(unknown: readonly string[]): void {
  const secret = unknown.filter((key) => SECRET_KEYS.test(key.replace(/^server\.?/, "")));
  if (secret.length > 0) {
    throw new OpsCrewError("INVALID_INPUT", `${secret.join(", ")}: ${NEVER_A_PASSWORD}`, {
      hint: "Remove it from the answers and give server.key instead.",
    });
  }
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * Whether the internet can probably reach `host`, from the address alone: `false` for private,
 * loopback, link-local and carrier-grade NAT addresses and for local names (`.local`, `.lan`,
 * `.home.arpa`, `.internal`, a single label); `true` for any other IP address; `undefined` for a
 * public-looking host name (it may point anywhere).
 */
export function suggestReachable(host: string): boolean | undefined {
  const name = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (z.ipv4().safeParse(name).success) return !PRIVATE_V4.some((range) => range.test(name));
  if (z.ipv6().safeParse(name).success) {
    return !(name === "::1" || /^f[cd]/.test(name) || /^fe[89ab]/.test(name));
  }
  const bare = name.replace(/\.$/, "");
  if (!bare.includes(".") || /\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(bare)) {
    return false;
  }
  return undefined;
}

/** Options of {@link buildServerQuestions} and {@link answersToOwnServer}. */
export interface OwnServerContext {
  /** The connection recorded earlier (`.opscrew/server.json` → `own`); pre-filled as defaults. */
  previous?: OwnServerConnection;
  /** Whether the internet reaches the server, as inspection suggests (wins over a guess). */
  suggestedReachable?: boolean;
  /**
   * Whether the app's domain is on Cloudflare (from the requirements answers). `false` leaves DNS
   * only as the way to serve the site; `undefined` offers every choice and design decides.
   */
  cloudflareDomain?: boolean;
  /**
   * The app's domain (from the requirements answers). Served through the tunnel or Cloudflare's
   * proxy it must be at most one level below its zone (Cloudflare's free certificate).
   */
  domain?: string;
  /**
   * The address typed in an earlier round of a terminal's questions ({@link askServerQuestions}):
   * `server.home`'s default is the one for it.
   */
  host?: string;
  /**
   * Whether the server is at home, as typed in an earlier round: the serving question's labels and
   * default follow it.
   */
  home?: boolean;
  /** The repository's root, which a relative `server.shares` folder is read from. */
  root?: string;
  /** The environment whose home folder (`HOME`, `USERPROFILE`) `~/` in `server.shares` starts at. */
  env?: Record<string, string | undefined>;
}

/**
 * `context` for a server of the user's own: a record of another app's server (`own.shares`)
 * pre-fills nothing, since its login is that app's `deploy`.
 */
function ownContext(context: OwnServerContext): OwnServerContext {
  if (context.previous?.shares === undefined) return context;
  const { previous: _shared, ...rest } = context;
  return rest;
}

/**
 * The serving answer when none is given: DNS only without Cloudflare; else the earlier one (for a
 * server at home only when it was at home then too); else Cloudflare's proxy at home and the
 * tunnel elsewhere.
 */
function serveDefault(context: OwnServerContext, home: boolean): OwnServerServe {
  if (context.cloudflareDomain === false) return "dns-only";
  const { previous } = context;
  if (home) return (previous?.home !== undefined ? previous.serve : undefined) ?? "proxy";
  return previous?.serve ?? "tunnel";
}

/**
 * Whether the server is at home when `server.home` isn't answered: the earlier answer for the same
 * address, else yes for a private or local address ({@link suggestReachable} false), else no.
 */
function homeDefault(context: OwnServerContext, host?: string): boolean {
  const { previous } = context;
  if (previous !== undefined && (host === undefined || sameHost(host, previous.host))) {
    return previous.home !== undefined;
  }
  return host !== undefined && suggestReachable(host) === false;
}

/** The serving choices for a server at home, in the order offered. */
const HOME_SERVE_OPTIONS = [
  {
    value: "proxy",
    label: "From your home's address, behind Cloudflare's proxy (recommended)",
    hint: "Your router forwards ports 80 and 443 to this server, and a filter lets only Cloudflare's addresses in, so visitors never see your home's address. OpsCrew keeps the DNS record current when your address changes.",
  },
  {
    value: "dns-only",
    label: "From your home's address, DNS only (no Cloudflare protection)",
    hint: "Your router forwards ports 80 and 443 to this server and everyone can reach it there; DNS shows your home's address to anyone who looks it up.",
  },
  {
    value: "tunnel",
    label: "Through a Cloudflare Tunnel",
    hint: "Works on any connection, with no forwards on your router: only Cloudflare reaches the app.",
  },
] as const;

/** What `server.home`'s help says about the ISP's terms and large media. */
const HOME_HELP =
  "Yes for a computer at home, such as a mini PC or a Raspberry Pi, that your router connects to the internet: OpsCrew serves the site from your home's own address and keeps its DNS record current when the address changes. Check your internet provider's terms first: residential plans often restrict running servers. Don't serve large media, such as videos or big downloads, through Cloudflare's proxy: Cloudflare's terms limit that without its paid services.";

/** The refusal of a `server.reachable` answer for a server at home. */
const HOME_NOT_REACHABLE =
  "server.reachable: a server at home is reached through your router's forwards; remove `server.reachable`";

const SERVE_OPTIONS = [
  {
    value: "tunnel",
    label: "Through a Cloudflare Tunnel (recommended)",
    hint: "No web port is opened on your server: only Cloudflare reaches the app, and deploys go through the tunnel too.",
  },
  {
    value: "proxy",
    label: "Directly, behind Cloudflare's proxy, with a filter",
    hint: "Ports 80 and 443 stay open, but a filter in Docker lets only Cloudflare's addresses in. Needs no Cloudflare Zero Trust. It fails closed: if the filter cannot be installed, Docker does not start and the site is down until it is fixed.",
  },
  {
    value: "dns-only",
    label: "Directly, DNS only (no Cloudflare protection)",
    hint: "Everyone can reach your server on ports 80 and 443; Cloudflare only answers DNS, so it neither hides nor protects the server.",
  },
] as const;

function reachableDefault(context: OwnServerContext, host?: string): boolean {
  if (context.suggestedReachable !== undefined) return context.suggestedReachable;
  const { previous } = context;
  if (previous?.reachable !== undefined && (host === undefined || sameHost(host, previous.host))) {
    return previous.reachable;
  }
  return (host === undefined ? undefined : suggestReachable(host)) ?? true;
}

const sameHost = (a: string, b: string) => normalizeHostName(a) === normalizeHostName(b);

/**
 * The follow-up questions for a server the user already has: address, whether it is at home, SSH
 * port (22), SSH user, key (a path, or the SSH agent), whether the internet can reach the server
 * and how it serves the site (labelled for home when it is at home by default). Never a password
 * or a passphrase, and never `server.sshFrom` (answers files only).
 */
export function buildServerQuestions(given: OwnServerContext = {}): ServerQuestion[] {
  const context = ownContext(given);
  const { previous } = context;
  const home = context.home ?? homeDefault(context, context.host);
  return [
    {
      id: "server.host",
      prompt: "What is your server's address?",
      help: "Its IP address or host name, for example 203.0.113.10 or server.example.com. OpsCrew keeps it on this computer only, never in your repository.",
      kind: "text",
      ...withDefault(previous?.host),
      required: true,
    },
    {
      id: "server.home",
      prompt: "Is this server at your home, on your home internet connection?",
      help: HOME_HELP,
      kind: "confirm",
      default: home,
      required: true,
    },
    {
      id: "server.port",
      prompt: "Which port do you connect to for SSH?",
      help: "The port this computer and GitHub Actions connect to, usually 22. When a router forwards another port to your server (for example 2222 to the server's 22), give the forwarded port (2222).",
      kind: "text",
      default: String(previous?.port ?? 22),
      required: true,
    },
    {
      id: "server.user",
      prompt: "Which user should OpsCrew log in as?",
      help: "root, or a user that can run sudo without a password.",
      kind: "text",
      default: previous?.user ?? "root",
      required: true,
    },
    {
      id: "server.key",
      prompt: "Which SSH key should OpsCrew use?",
      help: "The path to your private key, for example ~/.ssh/id_ed25519, or `agent` to use the key in your SSH agent (also for a key with a passphrase). OpsCrew never asks for a password or passphrase.",
      kind: "text",
      default: previous === undefined ? "agent" : (previous.keyPath ?? "agent"),
      required: true,
    },
    {
      id: "server.reachable",
      prompt: "Can the internet reach this server directly?",
      help: "Yes for a rented server with a public IP address. No for a server behind a router or firewall that doesn't forward to it: OpsCrew then serves the app through a Cloudflare Tunnel, which needs a domain on your Cloudflare account. Not asked for a server at home: your router's forwards reach it.",
      kind: "confirm",
      default: reachableDefault(context, context.host),
      required: true,
    },
    context.cloudflareDomain === false
      ? {
          id: "server.serve",
          prompt: "How should your server serve the site?",
          help: "Your domain is not on Cloudflare, so the site is served directly with DNS only: everyone can reach your server on ports 80 and 443. A Cloudflare Tunnel or Cloudflare's proxy needs the domain on your Cloudflare account.",
          kind: "single-select",
          options: [SERVE_OPTIONS[2]].map((option) => ({ ...option })),
          default: "dns-only",
          required: true,
        }
      : home
        ? {
            id: "server.serve",
            prompt: "How should your server at home serve the site?",
            help: "From your home's own address, your router forwards the web ports to the server; behind Cloudflare's proxy visitors never see that address. The tunnel needs no forwards and works on any connection. Without a domain on Cloudflare the only choice is dns-only.",
            kind: "single-select",
            options: HOME_SERVE_OPTIONS.map((option) => ({ ...option })),
            default: serveDefault(context, true),
            required: true,
          }
        : {
            id: "server.serve",
            prompt: "If the internet can reach your server, how should it serve the site?",
            help: "Matters for a server the internet can reach with a domain on Cloudflare; a server it cannot reach always uses the Cloudflare Tunnel, and without a domain on Cloudflare the only choice is dns-only (a tunnel or Cloudflare's proxy needs the domain on your Cloudflare account). The tunnel is the safest choice: nothing on the server is open to the web.",
            kind: "single-select",
            options: SERVE_OPTIONS.map((option) => ({ ...option })),
            default: serveDefault(context, false),
            required: true,
          },
  ];
}

/** The values of {@link SERVER_KIND_ID}. */
const SERVER_KINDS = { own: "own", shares: "shares" } as const;

/**
 * The terminal's first question for a server the user already has: one of theirs, reached with
 * their own SSH login, or the server of another of their OpsCrew apps, one OpsCrew created
 * (the default when the earlier answers named one).
 */
export function serverKindQuestion(
  context: Pick<OwnServerContext, "previous"> = {},
): ServerQuestion {
  return {
    id: SERVER_KIND_ID,
    prompt: "Which server should the app run on?",
    kind: "single-select",
    options: [
      {
        value: SERVER_KINDS.own,
        label: "A server of yours that OpsCrew reaches over SSH",
        hint: "rented anywhere, or a computer at home; OpsCrew logs in with your own SSH key",
      },
      {
        value: SERVER_KINDS.shares,
        label: "A server another of your OpsCrew apps runs on (one OpsCrew created)",
        hint: "beside that app, with no server to pay for; that app's repository must be on this computer, where it was provisioned",
      },
    ],
    default: context.previous?.shares === undefined ? SERVER_KINDS.own : SERVER_KINDS.shares,
    required: true,
  };
}

/** What {@link buildSharesQuestions} offers: the apps of the repository, and their environments. */
export interface SharesQuestionsContext {
  /** The connection recorded earlier: its `shares` pre-fills the answers. */
  previous?: OwnServerConnection;
  /** The apps of the named repository: `server.shares-app` is asked only when there are several. */
  apps?: readonly RepositoryApp[];
  /** The chosen app's environments: `server.shares-env` is asked only when there are several. */
  environments?: readonly string[];
}

/**
 * The questions naming the app whose server this app shares: its repository folder on this
 * computer, its app (only when the repository has several) and its environment (only when it has
 * several; prod by default).
 */
export function buildSharesQuestions(context: SharesQuestionsContext = {}): ServerQuestion[] {
  const previous = context.previous?.shares;
  const apps = context.apps ?? [];
  const environments = context.environments ?? [];
  return [
    {
      id: "server.shares",
      prompt: "Where is the repository of the app whose server this app should share?",
      help: "That app's repository folder on this computer, for example /home/you/code/inventory. That app must have been provisioned from this computer, on a server OpsCrew created: OpsCrew reads its plan, its server's address and its deploy key there, and copies only the server's public host key. Kept on this computer only.",
      kind: "text",
      ...withDefault(previous?.root),
      required: true,
    },
    ...(apps.length > 1
      ? [
          {
            id: "server.shares-app",
            prompt: "Which of that repository's apps runs on the server?",
            kind: "single-select",
            options: apps.map(({ key, dir }) => ({
              value: key ?? FIRST_APP,
              label: key === undefined ? `The first app (in ${dir})` : `"${key}" (in ${dir})`,
            })),
            default: previous?.app ?? FIRST_APP,
            required: true,
          } satisfies ServerQuestion,
        ]
      : []),
    ...(environments.length > 1
      ? [
          {
            id: "server.shares-env",
            prompt: "Which of its environments runs on the server?",
            kind: "single-select",
            options: environments.map((name) => ({ value: name, label: name })),
            default: previous?.environment ?? "prod",
            required: true,
          } satisfies ServerQuestion,
        ]
      : []),
  ];
}

/**
 * A `server.shares` answer as a folder on this computer: absolute, `~/` below the home folder (as
 * `server.key`'s is), or below `root`.
 */
function sharesFolder(answer: unknown, context: Pick<OwnServerContext, "root" | "env">): string {
  const typed = ownServerKeyFile(
    { agent: false, keyPath: String(answer).trim() },
    context.env ?? {},
  );
  return context.root === undefined ? resolve(typed ?? "") : resolve(context.root, typed ?? "");
}

/** True when `a` and `b` are the same folder (in any letter case on Windows). */
function sameFolder(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const folder = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return folder(a) === folder(b);
}

/** The questions of `built` with the id `id`: one round of a terminal's questions. */
function only(built: ServerQuestion[], id: ServerQuestionId): ServerQuestion[] {
  return built.filter((q) => q.id === id);
}

/**
 * Asks the questions naming the app whose server this app shares, one round each: its
 * repository's folder; its app, when that repository has several; its environment, when the app
 * has several.
 */
async function askSharesQuestions(
  ask: (questions: ServerQuestion[]) => Promise<InterviewAnswers>,
  context: OwnServerContext,
): Promise<InterviewAnswers> {
  const previous = context.previous === undefined ? {} : { previous: context.previous };
  const folder = await ask(only(buildSharesQuestions(previous), "server.shares"));
  if (isBlank(folder["server.shares"])) return folder;
  const root = sharesFolder(folder["server.shares"], context);
  const apps = (await mayHaveFurtherApps(root)) ? await appsOf(root) : [];
  const none: InterviewAnswers = {};
  const which =
    apps.length > 1
      ? await ask(only(buildSharesQuestions({ ...previous, apps }), "server.shares-app"))
      : none;
  const chosen = isBlank(which["server.shares-app"])
    ? undefined
    : String(which["server.shares-app"]).trim();
  const app = chosen === undefined || chosen === FIRST_APP ? undefined : chosen;
  const environments = await environmentsOf(root, app).catch((): string[] => []);
  const environment =
    environments.length > 1
      ? await ask(only(buildSharesQuestions({ ...previous, environments }), "server.shares-env"))
      : none;
  return { ...folder, ...which, ...environment };
}

/**
 * Asks the follow-up questions in a terminal: first which kind of server
 * ({@link serverKindQuestion}). For the server of another of the user's OpsCrew apps, the questions
 * naming that app ({@link buildSharesQuestions}). For a server of the user's, three rounds: the
 * address; then whether the server is at home, its default the one for that address; then the
 * rest, built for that address and that answer, so the serving question's labels and default
 * follow it, and without `server.reachable` at home. Answers every round's answers keyed by
 * question id, without the kind's.
 */
export async function askServerQuestions(
  ask: (questions: ServerQuestion[]) => Promise<InterviewAnswers>,
  context: OwnServerContext = {},
): Promise<InterviewAnswers> {
  const kind = await ask([serverKindQuestion(context)]);
  if (String(kind[SERVER_KIND_ID] ?? "").trim() === SERVER_KINDS.shares) {
    return askSharesQuestions(ask, context);
  }
  const first = await ask(only(buildServerQuestions(context), "server.host"));
  const host = isBlank(first["server.host"]) ? undefined : String(first["server.host"]).trim();
  const typed = { ...context, ...(host === undefined ? {} : { host }) };
  const second = await ask(only(buildServerQuestions(typed), "server.home"));
  const home = booleanAnswer(second["server.home"]);
  const rest = buildServerQuestions({ ...typed, ...(home === undefined ? {} : { home }) }).filter(
    (q) =>
      q.id !== "server.host" &&
      q.id !== "server.home" &&
      !(home === true && q.id === "server.reachable"),
  );
  return { ...first, ...second, ...(await ask(rest)) };
}

/**
 * Validates the follow-up answers for a server the user already has. Answers that were not given
 * fall back to the previous ones (port 22, the SSH agent and the reachability suggestion when
 * there are none; at home when the address is private or local). A server at home takes
 * `server.sshFrom` and refuses `server.reachable`. Throws `OpsCrewError("INVALID_INPUT")` naming each missing or invalid answer;
 * a password or passphrase is always refused, and never echoed. The answers naming another app's
 * server (`server.shares*`) are refused: only {@link answersToSharedServer} takes them.
 */
export function answersToOwnServer(
  split: Pick<FollowUps<ServerField>, "values" | "unknown">,
  options: OwnServerContext = {},
): OwnServerAnswers {
  const context = ownContext(options);
  const problems: string[] = [];
  refuseSecretAnswers(split.unknown);
  if (split.unknown.length > 0) {
    problems.push(
      `${split.unknown.join(", ")}: not a known answer (use ${OWN_FIELDS.map((f) => `server.${f}`).join(", ")})`,
    );
  }
  const { previous } = context;
  const given = (field: ServerField) => !isBlank(split.values[field]);
  const text = (field: ServerField) => String(split.values[field]).trim();
  const shares = SHARES_FIELDS.filter(given);
  if (shares.length > 0) {
    problems.push(
      `${shares.map((field) => `server.${field}`).join(", ")}: only \`opscrew interview\` and \`opscrew env add\` put an app on the server of another app`,
    );
  }

  let host = previous?.host;
  if (given("host")) {
    host = text("host").replace(/^\[(.*)\]$/, "$1");
    if (host.includes("@")) {
      problems.push("server.host: give only the address; the user goes into server.user");
      host = undefined;
    } else if (!HostSchema.safeParse(host).success) {
      problems.push("server.host: write an IP address or a host name such as server.example.com");
      host = undefined;
    }
  } else if (host === undefined) {
    problems.push("server.host (your server's address) is missing");
  }

  let port = previous?.port ?? 22;
  if (given("port")) {
    const value = portAnswer(split.values.port);
    if (value !== undefined) port = value;
    else problems.push("server.port: write a port number from 1 to 65535, usually 22");
  }

  let user = previous?.user;
  if (given("user")) {
    user = text("user");
    if (!USER_NAME.test(user)) {
      problems.push("server.user: write a login name such as root or ubuntu");
      user = undefined;
    }
  } else if (user === undefined) {
    problems.push("server.user (the SSH user) is missing");
  }

  let agent = previous?.agent ?? true;
  let keyPath = previous?.keyPath;
  if (given("key")) {
    const key = text("key");
    if (key.toLowerCase() === "agent") {
      agent = true;
      keyPath = undefined;
    } else if (looksLikeKeyMaterial(key)) {
      // Never echo what looks like a private key.
      throw new OpsCrewError(
        "INVALID_INPUT",
        "server.key must be the path to your SSH key file, never the key itself.",
        { hint: "Give the path, for example ~/.ssh/id_ed25519, or `agent` to use the SSH agent." },
      );
    } else if (!ABSOLUTE_PATH.test(key) || key.startsWith("-")) {
      problems.push(
        "server.key: write the full path to the private key, such as ~/.ssh/id_ed25519, or agent",
      );
    } else {
      agent = false;
      keyPath = key;
    }
  }

  let home = homeDefault(context, host);
  if (given("home")) {
    const answer = booleanAnswer(split.values.home);
    if (answer === undefined) problems.push("server.home: answer yes or no");
    else home = answer;
  }

  let reachable: boolean | undefined;
  if (given("reachable")) {
    if (home) problems.push(HOME_NOT_REACHABLE);
    else {
      reachable = booleanAnswer(split.values.reachable);
      if (reachable === undefined) problems.push("server.reachable: answer yes or no");
    }
  }

  const samePrevious =
    previous !== undefined && host !== undefined && sameHost(previous.host, host);
  let sshFrom = samePrevious ? previous.home?.sshFrom : undefined;
  if (given("sshFrom")) {
    if (!home) {
      problems.push(
        "server.sshFrom: only a server at home limits SSH to the networks it names; answer server.home yes, or remove server.sshFrom",
      );
    } else {
      const sources = sshSources(split.values.sshFrom);
      if (typeof sources === "string") problems.push(`server.sshFrom: ${sources}`);
      else sshFrom = sources;
    }
  }

  let serve = serveDefault(context, home);
  if (given("serve")) {
    const answer = text("serve").toLowerCase();
    if (!(SERVE_VALUES as readonly string[]).includes(answer)) {
      problems.push("server.serve: answer tunnel, proxy or dns-only");
    } else if (context.cloudflareDomain === false && answer !== "dns-only") {
      problems.push(
        "server.serve: without a domain on Cloudflare the site can only be served with DNS only (dns-only)",
      );
    } else {
      serve = answer as OwnServerServe;
    }
  }

  // Behind Cloudflare's proxy the web filter publishes the site on IPv4 only.
  const knownIpv4 =
    previous?.publicIpv4 !== undefined && host !== undefined && sameHost(previous.host, host);
  if (!home && serve === "proxy" && host?.includes(":") && !knownIpv4) {
    problems.push(
      "server.serve: proxy needs your server's public IPv4 address (behind Cloudflare's proxy OpsCrew publishes the site on IPv4 only); give the IPv4 address as server.host, or answer tunnel",
    );
  }

  // Through the tunnel or behind the proxy Cloudflare serves the domain with its own certificate.
  const unreachable =
    !home && host !== undefined && (reachable ?? reachableDefault(context, host)) === false;
  if (context.domain !== undefined && context.cloudflareDomain !== false) {
    const deep =
      unreachable || serve === "tunnel"
        ? deepDomainProblem(
            context.domain,
            home
              ? "serve it with DNS only (server.serve dns-only)"
              : "if the internet can reach your server, serve it with DNS only (server.reachable yes, server.serve dns-only)",
          )
        : serve === "proxy"
          ? deepDomainProblem(context.domain, "serve it with DNS only (server.serve dns-only)")
          : undefined;
    if (deep !== undefined) problems.push(`domain: ${deep.reason}; ${deep.next}`);
  }

  if (problems.length > 0 || host === undefined || user === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Some answers about your server are missing or not valid: ${problems.join("; ")}.`,
      { hint: FIX_ANSWERS_HINT },
    );
  }
  return OwnServerAnswersSchema.parse({
    host,
    port,
    user,
    ...(agent ? {} : { keyPath }),
    agent,
    ...(home
      ? { home: sshFrom === undefined ? {} : { sshFrom } }
      : { reachable: reachable ?? reachableDefault(context, host) }),
    serve,
  });
}

/**
 * `server.sshFrom`: space-separated addresses or networks (or a list of them), each in the form nft
 * prints it, without repeats; a plain reason when they aren't. The reason names positions, never
 * the values: one may be the home's public address.
 */
function sshSources(value: unknown): string[] | string {
  const items = Array.isArray(value)
    ? value.map((item) => String(item).trim())
    : String(value).trim().split(/\s+/);
  const bad = items.flatMap((item, i) =>
    canonicalSshSource(item) === null ? [String(i + 1)] : [],
  );
  if (bad.length > 0) {
    return `${bad.length === 1 ? "source" : "sources"} ${listText(bad)} ${bad.length === 1 ? "is not an address or network" : "are not addresses or networks"}: give IPv4 or IPv6 addresses or networks separated by spaces, such as 192.168.1.0/24 or 2001:db8::/32 (not every address, /0, nor a special IPv6 form such as ::1)`;
  }
  const sources = [...new Set(items.map((item) => canonicalSshSource(item) as string))];
  if (sources.length > MAX_SSH_SOURCES) {
    return `name at most ${MAX_SSH_SOURCES} sources (there are ${sources.length}); use networks that hold several addresses, such as 192.168.1.0/24`;
  }
  return sources;
}

/**
 * Records the answers in OpsCrew's local state (`.opscrew/server.json` → `own`, gitignored)
 * through `recordOwnServer`. For the same address and port as `pinned` (by default the connection
 * recorded there; another environment's on the same server) the pinned host key and the public
 * addresses are kept (a server at home keeps no public address); when either changed they are
 * dropped, so the next connection shows the new server's host key for confirmation again. The
 * home's network classification and outside check are written again by design and verify.
 */
export async function recordOwnServerAnswers(
  paths: ProjectPaths,
  answers: OwnServerAnswers,
  pinned?: OwnServerConnection,
): Promise<void> {
  const server = OwnServerAnswersSchema.parse(answers);
  pinned ??= await readOwnServer(paths);
  // A server at home keeps no public address: it is detected again on every run.
  const kept =
    pinned !== undefined && sameHost(pinned.host, server.host) && pinned.port === server.port
      ? {
          ...(pinned.hostKey !== undefined ? { hostKey: pinned.hostKey } : {}),
          ...(server.home === undefined && pinned.publicIpv4 !== undefined
            ? { publicIpv4: pinned.publicIpv4 }
            : {}),
          ...(server.home === undefined && pinned.publicIpv6 !== undefined
            ? { publicIpv6: pinned.publicIpv6 }
            : {}),
        }
      : {};
  await recordOwnServer(paths, { ...server, ...kept });
}

/** True when `path` is a folder on this computer. */
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The app whose server this app shares, from the `server.shares*` answers: its repository folder
 * on this computer (`server.shares`, which must exist; a relative one is read from
 * `context.root`), its app key (`server.shares-app`, `.` or absent for the repository's first app)
 * and its environment (`server.shares-env`, prod by default). Answers left out keep the ones of
 * `context.previous` for the same folder. With no server answer at all, an earlier record's
 * reference is kept: the same server again (as `opscrew env add` offers prod's). `undefined` when
 * the answers are about a server of the user's own ({@link answersToOwnServer}).
 * @throws OpsCrewError `INVALID_INPUT` naming each missing or invalid answer, and the address or
 * login answers given beside it (they come from the other app's server).
 */
export async function answersToSharedServer(
  split: Pick<FollowUps<ServerField>, "values" | "unknown">,
  context: Pick<OwnServerContext, "previous" | "root" | "env">,
): Promise<SharesReference | undefined> {
  const given = (field: ServerField) => !isBlank(split.values[field]);
  const text = (field: ServerField) => String(split.values[field]).trim();
  const previous = context.previous?.shares;
  if (!SHARES_FIELDS.some(given)) {
    return hasFollowUps(split) ? undefined : previous;
  }
  refuseSecretAnswers(split.unknown);
  const problems: string[] = [];
  if (split.unknown.length > 0) {
    problems.push(
      `${split.unknown.join(", ")}: not a known answer (use ${SHARES_FIELDS.map((f) => `server.${f}`).join(", ")})`,
    );
  }
  const own = OWN_FIELDS.filter(given);
  if (own.length > 0) {
    problems.push(
      `${own.map((field) => `server.${field}`).join(", ")}: the address and the login come from the other app's server; remove ${own.length === 1 ? "it" : "them"}, or remove server.shares to name a server of yours`,
    );
  }
  let root = previous?.root;
  if (given("shares")) {
    root = sharesFolder(text("shares"), context);
    if (!(await isFolder(root))) {
      problems.push(
        `server.shares: there is no folder ${root} on this computer; give the repository folder of the app whose server this app shares`,
      );
    }
  } else if (root === undefined) {
    problems.push(
      "server.shares (the repository folder of the app whose server this app shares) is missing",
    );
  }
  const same = sameFolder(root, previous?.root);
  let app = same ? previous?.app : undefined;
  if (given("shares-app")) {
    const key = text("shares-app");
    if (key === FIRST_APP) app = undefined;
    else if (AppKeySchema.safeParse(key).success) app = key;
    else {
      problems.push(
        `server.shares-app: write the app's key as \`opscrew app list\` shows it in that repository, or ${FIRST_APP} for its first app`,
      );
    }
  }
  let environment =
    previous !== undefined && same && app === previous.app ? previous.environment : "prod";
  if (given("shares-env")) {
    const name = text("shares-env");
    if (EnvironmentNameSchema.safeParse(name).success) environment = name;
    else problems.push("server.shares-env: write the environment's name, such as prod or staging");
  }
  if (problems.length > 0 || root === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Some answers about the server this app shares are missing or not valid: ${problems.join("; ")}.`,
      { hint: FIX_ANSWERS_HINT },
    );
  }
  return { root, ...(app === undefined ? {} : { app }), environment };
}

/**
 * Records a second app's login to the server it shares (`.opscrew/server.json` → `own`, local
 * only): the reference `shares`, the first app's address and port (`server`), the `deploy` user
 * and this app's own deploy key's path, which provision fills. For the same address and port the
 * public addresses of `pinned` (by default `previous`, this app's record so far; prod's for a new
 * environment) are kept; its pinned host key only while it is the first app's pin now
 * (`server.hostKey`), and `previous`'s `joined` with it: this app's own deploy key is on that
 * server already. A server recreated at the same address, with a new key, keeps neither.
 */
export async function recordSharedServerAnswers(
  paths: ProjectPaths,
  shares: SharesReference,
  server: { host: string; port: number; hostKey: string },
  previous?: OwnServerConnection,
  pinned: OwnServerConnection | undefined = previous,
): Promise<void> {
  const same = (record: OwnServerConnection | undefined): record is OwnServerConnection =>
    record !== undefined && sameHost(record.host, server.host) && record.port === server.port;
  const kept = same(pinned)
    ? {
        ...(pinned.hostKey === server.hostKey ? { hostKey: server.hostKey } : {}),
        ...(pinned.publicIpv4 === undefined ? {} : { publicIpv4: pinned.publicIpv4 }),
        ...(pinned.publicIpv6 === undefined ? {} : { publicIpv6: pinned.publicIpv6 }),
      }
    : {};
  const joined =
    same(previous) && previous.joined === true && previous.hostKey === server.hostKey
      ? { hostKey: server.hostKey, joined: true as const }
      : {};
  await recordOwnServer(paths, {
    host: server.host,
    port: server.port,
    user: "deploy",
    agent: false,
    keyPath: paths.files.deployKey,
    shares,
    ...kept,
    ...joined,
  });
}

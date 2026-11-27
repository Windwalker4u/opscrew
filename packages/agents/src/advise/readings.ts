/**
 * Advise's readings (feature 021, plan.md "5."): what its rules read about one environment,
 * gathered once per run, read-only, the independent sources at once. Each source is optional: what
 * can't be read is listed in `notRead` in plain words, never with an address, a token or a secret,
 * and the rest goes on.
 */
import { type CloudflareClient, cloudflareConnector } from "@opscrew/connector-cloudflare";
import type { GitHubClient } from "@opscrew/connector-github";
import type { CheckResult, UserFacingError } from "@opscrew/contracts";
import { errorText, isUserFacingError, listText } from "@opscrew/core";
import { CHECK_LABEL } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type CloudProvider,
  type DeployPlan,
  isCloudProvider,
  isCloudTarget,
  isHostingTarget,
  isServerlessProvider,
  type Requirements,
} from "@opscrew/plan-schema";
import { couldNotRun, runHostChecks } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { extraCatalogs } from "../design/run";
import { readEnvironmentRequirements } from "../environments/requirements";
import { ENGINE_NAMES } from "../hosting/facts";
import { sharedPreviewsLimit } from "../previews/host";
import { providerProfile, VPS_PROVIDERS } from "../providers";
import { renderedServers } from "../provision/disk-guard";
import type { ProvisionServices } from "../provision/types";
import { credentialInventory } from "../rotate/inventory";
import { ownServerHardening } from "../secure/own";
import { plannedWebSources } from "../secure/server-firewall";
import { hostChecksFor } from "../secure/servers";
import {
  gitClient,
  githubClientFromToken,
  githubCoordinates,
  hasDeployment,
  lastHostSetup,
  lastServerSetup,
} from "../shared";
import { appServers } from "../shared/servers";
import { otherAppsOnServer } from "../shares/guard";
import { type ResourceReading, readResources, readServerResources } from "../status/resources";
import { serverShell } from "../status/servers";
import { databaseWords, readDatabase } from "./database";
import { readHistory } from "./history";
import {
  type DatabaseReading,
  type PriceList,
  type Readings,
  type ServerHistory,
  type ServerReadings,
  THRESHOLDS,
} from "./types";

/** GitHub's reads advise makes (a `GitHubClient`, or a fake in tests). */
export type AdviseGitHub = Pick<
  GitHubClient,
  "dependabotAlerts" | "dependabotPulls" | "issuesSince" | "tokenExpiry"
>;

/** What advise reads through besides `deps`: fakes in tests. */
export interface ReadingsOptions {
  /** The servers' shells by address, the user's own server and Portainer, as `status` reads them. */
  services?: Pick<ProvisionServices, "remote" | "own" | "portainer" | "otherApps">;
  /** GitHub's reads (default: the client of the user's token; `null`: no token). */
  github?: AdviseGitHub | null;
  /** The Cloudflare token's check (default: `CLOUDFLARE_API_TOKEN`'s client; `null`: none set). */
  cloudflare?: Pick<CloudflareClient, "verifyToken"> | null;
}

/** One source's lines for the report: what was read, and what couldn't be, with why. */
interface Lines {
  checked: string[];
  notRead: string[];
}

/** A source's value, when it could be read, with its lines. */
type Read<T> = Lines & { value?: T };

const DAY_MS = 86_400_000;

/** What a user-facing error says, with its next step, redacted. */
function told(deps: Pick<PhaseDeps, "redactor">): (error: UserFacingError) => string {
  return (error) => deps.redactor.redact(errorText(error));
}

/**
 * `read`'s value with `what` checked; when it fails as OpsCrew tells users (a missing login, a
 * refusal, a server out of reach), `what` not read with `why` it failed (by default what the error
 * says, redacted). Anything else is a bug and stops the run.
 */
async function attempt<T>(
  deps: Pick<PhaseDeps, "redactor">,
  what: string,
  read: () => Promise<T>,
  why: (error: UserFacingError) => string = told(deps),
): Promise<Read<T>> {
  try {
    return { value: await read(), checked: [what], notRead: [] };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { checked: [], notRead: [`${what}: ${why(error)}`] };
  }
}

/**
 * Why a server couldn't be read, without the error's own text (it can name the server's address),
 * and the `command` that says more.
 */
function unreachable(command: string): (error: UserFacingError) => string {
  return (error) =>
    error.code === "PHASE_PRECONDITION"
      ? `this computer lacks the login or address OpsCrew needs (\`${command}\` says which)`
      : `OpsCrew could not reach it (\`${command}\` says why)`;
}

/** The figures of server `name` now, as `status` reads them. */
async function serverFigures(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  services: ReadingsOptions["services"],
): Promise<ResourceReading> {
  if (name === APP_SERVER) return readResources(deps, plan, { services });
  const { remote, login } = await serverShell(deps, plan, name, services);
  return readServerResources(deps, plan, name, remote, login.own);
}

/**
 * `secure`'s host checks on server `name` over its login's shell, as `secure` runs them there (on a
 * server the user owns, with what its last setup accepts), audited as `remote-exec` without the
 * address. The results leave out their target, which is the address.
 */
async function hostChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  services: ReadingsOptions["services"],
): Promise<CheckResult[]> {
  const { login, docker } = await serverShell(deps, plan, name, services);
  const hardening = login.own
    ? ownServerHardening(
        await (name === APP_SERVER ? lastHostSetup(deps, plan) : lastServerSetup(deps, name)),
        login,
      )
    : undefined;
  deps.reporter.step(`Running secure's host checks on server ${name} (read-only)`);
  // The web ports' networks the plan applied, which a server's own firewall is held to.
  const web = name === APP_SERVER ? await plannedWebSources(deps.paths.root, plan) : undefined;
  const results = await runHostChecks(docker, hostChecksFor(plan, name, hardening, web));
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "run secure's host checks (read-only)",
    target: `server ${name}`,
    decision: "allow",
  });
  return results.map(({ target: _address, ...result }) => result);
}

/** True when OpsCrew reaches server `name` over SSH: not a Portainer, this computer or a site. */
function overSsh(plan: DeployPlan, name: string): boolean {
  const { provider } = plan.target;
  return name !== APP_SERVER || isCloudProvider(provider) || provider === "own";
}

/**
 * Server `name`'s figures now and `secure`'s host checks on it, at once; a host check whose
 * command could not run is not read (without its message, which can hold the address).
 */
async function readServer(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  services: ReadingsOptions["services"],
  flags: string,
): Promise<Lines & { now?: ResourceReading; checks?: CheckResult[] }> {
  const [figures, checked] = await Promise.all([
    attempt(
      deps,
      `server ${name}'s figures`,
      () => serverFigures(deps, plan, name, services),
      unreachable(`opscrew status${flags}`),
    ),
    overSsh(plan, name)
      ? attempt(
          deps,
          `secure's host checks on server ${name}`,
          () => hostChecks(deps, plan, name, services),
          unreachable(`opscrew secure${flags}`),
        )
      : Promise.resolve<Read<CheckResult[]>>({ checked: [], notRead: [] }),
  ]);
  const now = figures.value;
  const results = checked.value;
  return {
    ...(now === undefined ? {} : { now }),
    ...(results === undefined ? {} : { checks: results.filter((r) => !couldNotRun(r)) }),
    checked: [...figures.checked, ...checked.checked],
    notRead: [
      ...figures.notRead,
      ...(now?.unavailable ?? []).map((entry) => `server ${name}: ${entry}`),
      ...checked.notRead,
      ...(results ?? [])
        .filter(couldNotRun)
        .map((r) => `server ${name}'s host check "${r.title}": its command could not run`),
    ],
  };
}

/** Advise reads a database only where it has a shell. */
const ONLY_OVER_SSH = "advise reads a database only on a server it reaches over SSH";

/**
 * The statistics of each PostgreSQL service in `plan` (research R20), on the server it runs on
 * (the app's or an extra one), over the shell that reaches Docker there, audited as `remote-exec`
 * without the address. In a Portainer, on this computer and a hosting account's own database:
 * not read, with the reason.
 */
async function readDatabases(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ReadingsOptions["services"],
  flags: string,
): Promise<Lines & { databases: DatabaseReading[] }> {
  const { target } = plan;
  if (isHostingTarget(target)) {
    const engine = target.database?.engine;
    return {
      databases: [],
      checked: [],
      notRead:
        engine === undefined
          ? []
          : [
              `the statistics of the hosting account's ${ENGINE_NAMES[engine]} database: ${ONLY_OVER_SSH}${engine === "postgres" ? "" : ", and only PostgreSQL"}`,
            ],
    };
  }
  const postgres = plan.services.filter((s) => s.kind === "postgres" && s.enabled);
  const read = await Promise.all(
    postgres.map(async (service): Promise<Read<DatabaseReading>> => {
      const server = service.server ?? APP_SERVER;
      const what = `the statistics of ${databaseWords(server, service.name)}`;
      if (!overSsh(plan, server)) {
        const where =
          target.provider === "portainer"
            ? "and it reaches your Portainer through its API"
            : "not on this computer";
        return { checked: [], notRead: [`${what}: ${ONLY_OVER_SSH}, ${where}`] };
      }
      const { value, checked, notRead } = await attempt(
        deps,
        what,
        async () => {
          const { docker } = await serverShell(deps, plan, server, services);
          deps.reporter.step(`Reading ${what} (read-only)`);
          const result = await readDatabase(docker, {
            app: plan.app.name,
            server,
            service: service.name,
            major: Number.parseInt(service.version, 10),
            now: () => deps.clock.now(),
            redact: (text) => deps.redactor.redact(text),
          });
          await deps.audit.append({
            kind: "remote-exec",
            actor: "opscrew",
            action: `read the statistics of PostgreSQL ${service.name} (read-only)`,
            target: `server ${server}`,
            decision: "allow",
          });
          return result;
        },
        unreachable(`opscrew status${flags}`),
      );
      // A check whose first query failed read nothing.
      const anything = value?.reading.blocked !== undefined || value?.reading.timedOut === true;
      return {
        ...(value === undefined ? {} : { value: value.reading }),
        checked: anything ? checked : [],
        notRead: [...notRead, ...(value?.notRead ?? [])],
      };
    }),
  );
  return {
    databases: read.flatMap((r) => (r.value === undefined ? [] : [r.value])),
    checked: read.flatMap((r) => r.checked),
    notRead: read.flatMap((r) => r.notRead),
  };
}

/**
 * `plan` with each server OpsCrew created at the location and type provision last rendered for it
 * (`renderedServers`, as provision's disk guard reads them): the servers that run. The rules size
 * and price those, so a type `--apply` wrote that provision hasn't applied yet is a proposal the
 * plan already holds.
 */
async function asDeployed(deps: PhaseDeps, plan: DeployPlan): Promise<DeployPlan> {
  const rendered = await renderedServers(deps.paths.root, plan);
  const { target } = plan;
  const app = rendered.get(APP_SERVER);
  const servers = plan.servers?.map((server) => {
    const was = rendered.get(server.name);
    return was === undefined || server.target.provider === "own"
      ? server
      : { ...server, target: { ...server.target, ...was } };
  });
  return {
    ...plan,
    target: app !== undefined && isCloudTarget(target) ? { ...target, ...app } : target,
    ...(servers === undefined ? {} : { servers }),
  };
}

/**
 * The price lists of each server OpsCrew created in `plan` (where it runs) and, for the cost rule's
 * comparison, of the other providers in the interview's region; the catalogue of each provider is
 * read once, live with its token or the dated static list (said in `notRead`).
 */
async function priceLists(
  deps: PhaseDeps,
  plan: DeployPlan,
  requirements: Requirements | undefined,
): Promise<Lines & { lists: PriceList[] }> {
  const warnings: string[] = [];
  const catalogFor = extraCatalogs(deps, undefined, (warning) => warnings.push(warning));
  const wanted = new Map<string, { provider: CloudProvider; location: string }>();
  const want = (provider: CloudProvider, location: string) =>
    wanted.set(`${provider} ${location}`, { provider, location });
  for (const { target } of [{ target: plan.target }, ...(plan.servers ?? [])]) {
    if (isCloudTarget(target)) want(target.provider, target.location);
  }
  const { provider } = plan.target;
  const region = requirements?.region;
  if (isCloudProvider(provider) && region) {
    for (const other of VPS_PROVIDERS.filter((id) => id !== provider)) {
      for (const location of providerProfile(other).regionLocations[region]) want(other, location);
    }
  }
  if (wanted.size > 0) deps.reporter.step("Reading the providers' prices (read-only)");
  const read = await Promise.all(
    [...wanted.values()].map(({ provider, location }) =>
      attempt(
        deps,
        `${providerProfile(provider).displayName}'s prices in ${location}`,
        async (): Promise<PriceList> => {
          const catalog = await catalogFor(provider, location);
          const [offers, extras] = await Promise.all([
            catalog.listOffers(location),
            catalog.extras(location),
          ]);
          return { provider, location, offers, extras };
        },
      ),
    ),
  );
  return {
    lists: read.flatMap((r) => (r.value === undefined ? [] : [r.value])),
    checked: read.flatMap((r) => r.checked),
    notRead: [
      ...[...new Set(warnings)]
        .sort()
        .map((warning) => deps.redactor.redact(`live prices: ${warning}`)),
      ...read.flatMap((r) => r.notRead),
    ],
  };
}

/** What GitHub tells advise: Dependabot, the token's expiry, the check's issues. */
type GitHubReadings = Pick<Readings, "check"> &
  Pick<Readings["upkeep"], "dependabot" | "pulls" | "tokens">;

/**
 * Dependabot's alerts and pull requests, the GitHub token's expiry and, with the scheduled check
 * on, its issues opened since `since`, at once. A token without "Dependabot alerts: Read" is a
 * line in `notRead`, not a failure.
 */
async function readGitHub(
  deps: PhaseDeps,
  plan: DeployPlan,
  github: ReadingsOptions["github"],
  since: string,
): Promise<Lines & GitHubReadings> {
  const checkOn = plan.observability?.check?.enabled === true;
  const what = listText([
    "Dependabot alerts",
    "Dependabot's open pull requests",
    "the GitHub token's expiry",
    ...(checkOn ? ["the scheduled check's issues"] : []),
  ]);
  const api = github === undefined ? await githubClientFromToken(deps) : github;
  if (api === null || api === undefined) {
    return {
      pulls: [],
      tokens: [],
      checked: [],
      notRead: [
        `${what}: no GitHub token is available (set GITHUB_TOKEN or run \`gh auth login\`)`,
      ],
    };
  }
  const where = await attempt(deps, what, () => githubCoordinates(gitClient(deps)));
  if (where.value === undefined) {
    return { pulls: [], tokens: [], checked: [], notRead: where.notRead };
  }
  const { owner, repo } = where.value;
  deps.reporter.step("Reading Dependabot's alerts and pull requests at GitHub (read-only)");
  const [alerts, pulls, expiry, issues] = await Promise.all([
    attempt(
      deps,
      "Dependabot alerts",
      () => api.dependabotAlerts(owner, repo),
      (error) =>
        error.code === "CREDENTIALS_INVALID"
          ? 'the GitHub token lacks the permission "Dependabot alerts: Read"; add it to the token to have them read'
          : told(deps)(error),
    ),
    attempt(deps, "Dependabot's open pull requests", () => api.dependabotPulls(owner, repo)),
    attempt(deps, "the GitHub token's expiry", () => api.tokenExpiry()),
    checkOn
      ? attempt(
          deps,
          `the scheduled check's issues of the last ${THRESHOLDS.historyDays} days`,
          () => api.issuesSince(owner, repo, CHECK_LABEL, since),
        )
      : Promise.resolve(undefined),
  ]);
  const sources = [alerts, pulls, expiry, ...(issues === undefined ? [] : [issues])];
  return {
    ...(alerts.value === undefined ? {} : { dependabot: alerts.value }),
    pulls: pulls.value ?? [],
    tokens: expiry.value === undefined ? [] : [{ service: "github", expiresAt: expiry.value }],
    ...(issues?.value === undefined ? {} : { check: issues.value }),
    checked: sources.flatMap((s) => s.checked),
    notRead: sources.flatMap((s) => s.notRead),
  };
}

/**
 * The Cloudflare token's expiry, when one is configured: Cloudflare's verify answer gives it when
 * one is set; an account-owned token, verified through the zone list, has none to read.
 */
async function readCloudflare(
  deps: PhaseDeps,
  cloudflare: ReadingsOptions["cloudflare"],
): Promise<Lines & Pick<Readings["upkeep"], "tokens">> {
  const client = cloudflare === undefined ? cloudflareConnector(deps).client : cloudflare;
  if (client === null || client === undefined) return { tokens: [], checked: [], notRead: [] };
  const what = "the Cloudflare token's expiry";
  const { value: check, checked, notRead } = await attempt(deps, what, () => client.verifyToken());
  if (check === undefined) return { tokens: [], checked, notRead };
  if (!check.ok) {
    return {
      tokens: [],
      checked: [],
      notRead: [`${what}: ${deps.redactor.redact(check.message)}`],
    };
  }
  if (check.expiresOn !== undefined) {
    return { tokens: [{ service: "cloudflare", expiresAt: check.expiresOn }], checked, notRead };
  }
  if (check.identity === "account API token") {
    return {
      tokens: [],
      checked: [],
      notRead: [`${what}: Cloudflare gives none for an account-owned token`],
    };
  }
  return { tokens: [], checked, notRead };
}

/**
 * The 14 days of each server from the self-hosted stack, when monitoring is on; what a query
 * didn't answer is listed with the server's name.
 */
async function readServerHistory(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ReadingsOptions["services"],
  flags: string,
): Promise<Lines & { histories?: Record<string, ServerHistory> }> {
  const read = await attempt(
    deps,
    `the monitoring stack's ${THRESHOLDS.historyDays} days of figures`,
    () => readHistory(deps, plan, services),
    unreachable(`opscrew status${flags}`),
  );
  const histories = read.value;
  if (histories === undefined) return { checked: [], notRead: read.notRead };
  return {
    histories,
    checked: read.checked,
    notRead: Object.entries(histories).flatMap(([name, history]) =>
      (history.notRead ?? []).map((entry) => `server ${name}'s history: ${entry}`),
    ),
  };
}

/**
 * The memory limits of the apps from other repositories that run on the app's server OpsCrew
 * created (FR-3016), read through its deploy login as the first app's guards read them: the size
 * rules count them beside the app's. When OpsCrew couldn't look, or can't read an app's record,
 * a line in `notRead` says so, and its memory isn't counted. What was counted is checked.
 */
async function readOtherApps(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ReadingsOptions["services"],
): Promise<Lines & { memoryMb: number }> {
  if (!isCloudTarget(plan.target) || !hasDeployment(plan)) {
    return { memoryMb: 0, checked: [], notRead: [] };
  }
  const what = "the other apps on the server";
  const found = await otherAppsOnServer(deps, plan, { services: services?.otherApps });
  if (!found.reached) {
    return {
      memoryMb: 0,
      checked: [],
      notRead: [`${what}: OpsCrew couldn't look (${found.reason})`],
    };
  }
  const active = found.apps.filter((record) => record.state === "active");
  return {
    memoryMb: active.reduce((sum, record) => sum + record.memoryMb, 0),
    checked:
      active.length === 0
        ? []
        : [
            `the memory limits of ${listText(active.map((record) => `"${record.app}"`))} on the server`,
          ],
    notRead: found.unreadable.map(
      (app) =>
        `the memory of "${app}" on the server: OpsCrew can't read its record, so the size advice doesn't count it`,
    ),
  };
}

/**
 * Everything advise's rules read about `plan`'s environment, read-only: per server its figures now
 * (as `status` reads them) and its 14 days from the self-hosted stack, `secure`'s host checks, the
 * plan (each server OpsCrew created as provision last rendered it), the interview's answers, the
 * providers' prices, Dependabot's alerts and pull requests, the GitHub and Cloudflare tokens' expiry,
 * the scheduled check's issues, the credentials' dates (names and dates only, nothing
 * recorded) and each PostgreSQL service's statistics; with what was read (`checked`). Every
 * remote command is fixed and read-only, audited by its reader as `remote-exec`. `flags` are the environment's ` --app …`/
 * ` --env …` for the commands it names.
 */
export async function readAdvice(
  deps: PhaseDeps,
  plan: DeployPlan,
  flags: string,
  options: ReadingsOptions = {},
): Promise<{ readings: Readings; checked: string[] }> {
  const at = deps.clock.now();
  const since = new Date(at.getTime() - THRESHOLDS.historyDays * DAY_MS).toISOString();
  const { services } = options;
  const names = isServerlessProvider(plan.target.provider) ? [] : appServers(plan);
  const [requirements, deployedPlan, sharedPreviews, look] = await Promise.all([
    attempt(deps, "the interview's answers", () => readEnvironmentRequirements(deps.paths)),
    asDeployed(deps, plan),
    sharedPreviewsLimit(deps.paths),
    // A look that fails as OpsCrew tells users is not read, and the rest goes on.
    attempt(deps, "the other apps on the server", () => readOtherApps(deps, plan, services)),
  ]);
  const others: Lines & { memoryMb: number } = {
    memoryMb: look.value?.memoryMb ?? 0,
    checked: look.value?.checked ?? [],
    notRead: [...look.notRead, ...(look.value?.notRead ?? [])],
  };
  // Beside the app on its server: the previews another environment runs there, or the apps from
  // other repositories (a server with those takes no previews).
  const besideMb = (sharedPreviews?.memoryMb ?? 0) + others.memoryMb;
  const [prices, servers, history, github, cloudflare, credentials, databases] = await Promise.all([
    priceLists(deps, deployedPlan, requirements.value),
    Promise.all(names.map((name) => readServer(deps, plan, name, services, flags))),
    readServerHistory(deps, plan, services, flags),
    readGitHub(deps, plan, options.github, since),
    readCloudflare(deps, options.cloudflare),
    // Read only: the listing never records a token seen for the first time.
    attempt(deps, "the credentials' dates", () => credentialInventory(deps, plan)),
    // Cloudflare's hosting and GitHub Pages run no database of the plan.
    names.length === 0 ? undefined : readDatabases(deps, plan, services, flags),
  ]);
  const read: Lines[] = [
    requirements,
    others,
    ...servers,
    history,
    prices,
    github,
    cloudflare,
    credentials,
    ...(databases === undefined ? [] : [databases]),
  ];
  const readings: Readings = {
    at: at.toISOString(),
    servers: Object.fromEntries(
      names.flatMap((name, i): [string, ServerReadings][] => {
        const now = servers[i]?.now;
        const past = history.histories?.[name];
        return now === undefined
          ? []
          : [[name, past === undefined ? { now } : { now, history: past }]];
      }),
    ),
    plan: deployedPlan,
    ...(sharedPreviews === undefined && others.memoryMb === 0 ? {} : { besideAppMb: besideMb }),
    ...(requirements.value === undefined ? {} : { requirements: requirements.value }),
    prices: prices.lists,
    upkeep: {
      ...(github.dependabot === undefined ? {} : { dependabot: github.dependabot }),
      pulls: github.pulls,
      tokens: [...github.tokens, ...cloudflare.tokens],
      ...(credentials.value === undefined ? {} : { credentials: credentials.value }),
      hostChecks: Object.fromEntries(
        names.flatMap((name, i) => {
          const checks = servers[i]?.checks;
          return checks === undefined ? [] : [[name, checks]];
        }),
      ),
    },
    ...(github.check === undefined ? {} : { check: github.check }),
    ...(databases === undefined || databases.databases.length === 0
      ? {}
      : { databases: databases.databases }),
    notRead: read.flatMap((r) => r.notRead),
    flags,
  };
  return { readings, checked: ["the plan", ...read.flatMap((r) => r.checked)] };
}

import { OpsCrewError } from "@opscrew/core";
import {
  APP_SERVER,
  type DeployPlan,
  type PlanService,
  postgresLogins,
  type SelfHostedServiceKind,
  servicesOn,
} from "@opscrew/plan-schema";
import { isClientExposedEnvName } from "../docker/stacks";
import { IMAGES } from "../pins";
import { planFilePath } from "../workflow/shared";
import type { ServiceInitStep } from "../workflow/switch";
import {
  DRAGONFLY_MIN_VCPUS,
  grantHashSecret,
  hasLogin,
  kafkaTool,
  POSTGRES_LOGINS,
  POSTGRES_OWNER_SECRET,
  postgresOwner,
  SERVICE_SPECS,
} from "./entries";
import type {
  DatabaseSettings,
  GeneratedSecret,
  ServiceContext,
  ServiceRotation,
  ServiceSpec,
} from "./types";

export * from "./postgres-logins";
export {
  DRAGONFLY_MIN_VCPUS,
  grantHashSecret,
  hasLogin,
  kafkaTool,
  POSTGRES_OWNER_SECRET,
  SERVICE_SPECS,
};

/** {@link SERVICE_SPECS} by kind: one entry for every kind (a test checks each is there). */
export const CATALOG = Object.fromEntries(
  SERVICE_SPECS.map((spec) => [spec.kind, spec]),
) as Readonly<Record<SelfHostedServiceKind, ServiceSpec>>;

/** The catalog's entry for `kind`. */
export function serviceSpec(kind: SelfHostedServiceKind): ServiceSpec {
  return CATALOG[kind];
}

/**
 * The kernel settings the enabled services on `server` (the app's by default, or an extra server's
 * name) need from its host, each a minimum (`vm.max_map_count` for OpenSearch and
 * Elasticsearch); empty when none does.
 */
export function hostSysctl(plan: DeployPlan, server = APP_SERVER): Record<string, string> {
  return Object.assign(
    {},
    ...servicesOn(plan, server).map((service) => serviceSpec(service.kind).hostSettings?.sysctl),
  );
}

/**
 * The image of `spec` without its registry, tag and digest, as Dependabot names it: `mysql`,
 * `apache/kafka`, `dragonflydb/dragonfly` (from `docker.dragonflydb.io/dragonflydb/dragonfly`;
 * Dependabot keeps the registry apart).
 */
export function imageName(spec: ServiceSpec): string {
  const ref = IMAGES[spec.image].ref;
  const name = ref.slice(0, ref.lastIndexOf(":", ref.indexOf("@")));
  // A first part with a dot or a port is a registry's host.
  return name.replace(/^[^/]*[.:][^/]*\//, "");
}

/** The version in the tag of the image OpsCrew pins: `8.4` for `mysql:8.4@…`, `26.2.5` for `v26.2.5`. */
export function pinnedVersion(spec: ServiceSpec): string {
  const ref = IMAGES[spec.image].ref;
  const tag = ref.slice(ref.lastIndexOf(":", ref.indexOf("@")) + 1, ref.indexOf("@"));
  return /^v?(\d+(?:\.\d+)*)/.exec(tag)?.[1] ?? tag;
}

/**
 * Refuses a service whose version is not the one OpsCrew pins, at the plan's precision (`8.4`
 * matches `8.4`, `4.3` matches `4.3.1`): the version would otherwise change in the plan only.
 * @throws OpsCrewError `INVALID_INPUT` naming both versions.
 */
export function checkServiceVersion(
  plan: DeployPlan,
  service: PlanService,
  spec: ServiceSpec,
): void {
  const wanted = service.version.split(".");
  const pinned = pinnedVersion(spec).split(".");
  if (wanted.length <= pinned.length && wanted.every((part, i) => part === pinned[i])) return;
  const file = planFilePath(plan);
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${file} asks for ${spec.title} ${service.version} (the service ${service.name}), but this version of OpsCrew runs ${spec.title} ${pinnedVersion(spec)}.`,
    {
      hint: `Set the service's version to ${spec.defaultVersion} in ${file} (services), then run the command again.`,
    },
  );
}

/** A service's data folders in its container by name: `data` for an entry with one folder. */
export function dataDirs(spec: ServiceSpec): [name: string, dir: string][] {
  return Object.entries(typeof spec.dataDir === "string" ? { data: spec.dataDir } : spec.dataDir);
}

/** The plan's services that run, in its order. */
export function enabledServices(plan: DeployPlan): PlanService[] {
  return plan.services.filter((service) => service.enabled);
}

/** A {@link ServiceContext} for rendering: no secret value ever reaches a rendered file. */
export function renderContext(
  plan: DeployPlan,
  service: PlanService,
  secretRef: (name: string) => string = (name) => {
    throw new Error(`${service.name}'s secret ${name} cannot appear in a rendered file`);
  },
): ServiceContext {
  return { plan, service, secretRef };
}

/**
 * What the app receives from the service of `ctx`: its catalog entry's conventional names, and
 * the app's own detected variable (`ctx.variable`) with the service's address.
 */
export function appVariables(ctx: ServiceContext): Record<string, string> {
  const spec = serviceSpec(ctx.service.kind);
  const address = spec.address(ctx);
  const variables = spec.conventionalVariables(ctx, address);
  return ctx.variable === undefined ? variables : { ...variables, [ctx.variable]: address };
}

/**
 * The settings of the SQL database of `ctx` one by one (PostgreSQL, MySQL, MariaDB), for an app
 * that reads them apart rather than as one URL: the host its address names, its port, database and
 * user, and the password as `ctx.secretRef` gives it. Undefined for every other kind.
 */
export function splitDatabaseSettings(ctx: ServiceContext): DatabaseSettings | undefined {
  return serviceSpec(ctx.service.kind).databaseSettings?.(ctx);
}

/**
 * The one-time setup steps of the services on `server` (the app's by default, or an extra
 * server's name), in the plan's order, for the deploy there (MongoDB's replica set).
 */
export function initStepsFor(plan: DeployPlan, server = APP_SERVER): ServiceInitStep[] {
  return servicesOn(plan, server).flatMap(
    (service) => serviceSpec(service.kind).init?.(renderContext(plan, service)) ?? [],
  );
}

/**
 * The secrets OpsCrew generates for `service`: its entry's, and with `logins: separate` a
 * PostgreSQL's `owner-password` and `runtime-password` too (047).
 */
export function serviceSecrets(service: PlanService): GeneratedSecret[] {
  const { secrets } = serviceSpec(service.kind);
  return postgresLogins(service) ? [...secrets, ...POSTGRES_LOGINS.secrets] : secrets;
}

/**
 * How `service`'s generated secrets rotate: its entry's rotation, and with `logins: separate` a
 * PostgreSQL's two logins' too, after its `password` (047); each of {@link serviceSecrets} once.
 */
export function serviceRotation(service: PlanService): ServiceRotation {
  const { rotation } = serviceSpec(service.kind);
  return postgresLogins(service)
    ? { ...rotation, secrets: [...rotation.secrets, ...POSTGRES_LOGINS.rotation] }
    : rotation;
}

/**
 * The split settings that hold a SQL database's login, by the names an app reads them by: the
 * user's and the password's (the host, port and database are the same for every login).
 */
const SPLIT_LOGIN: Readonly<Record<string, keyof DatabaseSettings>> = {
  DB_USERNAME: "user",
  DB_USER: "user",
  DB_PASSWORD: "password",
  DB_PASS: "password",
};

/** A PostgreSQL's URL's names an app reads besides the catalog's, as agents' `serviceUrlKind`. */
const POSTGRES_ALIAS =
  /^(?:DATABASE_URL|DATABASE_URI|SQLALCHEMY_DATABASE_URI|POSTGRES_UR[LI]|DB_UR[LI])$/;
/** `<prefix>_DATABASE_URL`/`_URI`; the capture is the prefix. */
const PREFIXED_ALIAS = /^(\w+?)_DATABASE_UR[LI]$/;
/**
 * Prefix segments that mark another database engine or a database that is not production's
 * (tests, Prisma's shadow database, local development): such names are never derived.
 */
const OTHER_DATABASE_SEGMENTS = new Set([
  "MONGO",
  "MONGODB",
  "MYSQL",
  "MARIADB",
  "SQLITE",
  "CLICKHOUSE",
  "MSSQL",
  "SQLSERVER",
  "ORACLE",
  "COCKROACH",
  "COCKROACHDB",
  "TIMESCALE",
  "NEO4J",
  "CASSANDRA",
  "LIBSQL",
  "TURSO",
  "PLANETSCALE",
  "REDIS",
  "ELASTIC",
  "ELASTICSEARCH",
  "TEST",
  "TESTS",
  "TESTING",
  "SHADOW",
  "DEV",
  "DEVELOPMENT",
  "LOCAL",
  "E2E",
  "CI",
  "STAGING",
]);

/**
 * True for a name agents derive from the app's PostgreSQL's address (`design` plans it as
 * `derived`, `assembleAppEnv` fills it): `DATABASE_URI`, `SQLALCHEMY_DATABASE_URI`,
 * `POSTGRES_URL`, `DB_URL` and `*_DATABASE_URL`/`_URI`, but not a name bundlers expose to browsers
 * nor a prefix naming another engine or a non-production database (`TEST_DATABASE_URL`).
 */
function postgresAlias(name: string): boolean {
  if (isClientExposedEnvName(name)) return false;
  if (POSTGRES_ALIAS.test(name)) return true;
  const prefix = PREFIXED_ALIAS.exec(name)?.[1];
  return (
    prefix !== undefined && !prefix.split("_").some((part) => OTHER_DATABASE_SEGMENTS.has(part))
  );
}

/**
 * The release command's database variables (047): for each PostgreSQL with `logins: separate`, the
 * names `app.env` has its address under, each with the owner's login `app_owner` and `secret`'s
 * `owner-password`, so the release never logs in as the runtime login. Those are:
 * - the catalog's names (`DATABASE_URL`) and the app's own detected variable, unless another
 *   service gives `app.env` that name (one service's own `variable` is its alone; else the first
 *   service's);
 * - when the app reads `DB_HOST` and the database is the one whose split settings `app.env` holds
 *   (the SQL database whose variable is `DATABASE_URL`, else the first), the user's and the
 *   password's split names the app reads;
 * - the app's other derived names for the first PostgreSQL's address ({@link postgresAlias}).
 *
 * `release.db.env` holds them, which the release reads after `app.env`. Empty without such a
 * PostgreSQL.
 */
export function releaseVariables(
  plan: DeployPlan,
  secret: (service: PlanService, name: string) => string,
): Record<string, string> {
  const running = enabledServices(plan);
  const own = new Set(running.flatMap((s) => (s.variable === undefined ? [] : [s.variable])));
  const context = (service: PlanService, secretRef: (name: string) => string): ServiceContext => ({
    plan,
    service,
    secretRef,
    ...(service.variable === undefined ? {} : { variable: service.variable }),
  });
  const owner = (service: PlanService) =>
    postgresOwner(context(service, (name) => secret(service, name)));
  const given = new Set<string>();
  const release: Record<string, string> = {};
  for (const service of running) {
    const mine = Object.keys(appVariables(context(service, () => ""))).filter(
      (name) =>
        !given.has(name) &&
        !isClientExposedEnvName(name) &&
        (!own.has(name) || service.variable === name),
    );
    for (const name of mine) given.add(name);
    if (!postgresLogins(service) || mine.length === 0) continue;
    const { address } = owner(service);
    for (const name of mine) release[name] = address;
  }
  const reads = new Set(plan.app.env.map((variable) => variable.name));
  const sql = running.filter((s) => serviceSpec(s.kind).databaseSettings !== undefined);
  const split = reads.has("DB_HOST")
    ? (sql.find((s) => s.variable === "DATABASE_URL") ?? sql[0])
    : undefined;
  if (split !== undefined && postgresLogins(split)) {
    const { settings } = owner(split);
    for (const [name, setting] of Object.entries(SPLIT_LOGIN)) {
      if (reads.has(name) && !given.has(name)) release[name] = settings[setting];
    }
  }
  const first = running.find((s) => s.kind === "postgres");
  if (first !== undefined && postgresLogins(first)) {
    for (const { name, source } of plan.app.env) {
      if (source === "derived" && !given.has(name) && postgresAlias(name)) {
        release[name] = owner(first).address;
      }
    }
  }
  return release;
}

/**
 * PostgreSQL's two logins for the app (feature 047, ADR 0037). `app_owner` owns the database `app`,
 * its schemas and everything the migrations create, and only the release command logs in as it.
 * `app_runtime`, for the web, the workers and cron, may only read and write data. The image's
 * superuser `app` keeps OpsCrew's administration and runs every script here.
 *
 * Each script is sh for the database's own image, with fixed names. No password is in an argument:
 * psql binds them with `\getenv` from its environment, and the SQL reaches psql on a pipe from the
 * shell's own `printf`. The scripts that log in over TCP (`host`) need `PGPASSWORD` from their
 * caller, as the snapshots' commands export it; the others use the container's socket, which the
 * image trusts.
 */
import { shellQuote } from "../runtime/services";

/** The login that owns the app's database and schema: the release command's. */
export const POSTGRES_OWNER = "app_owner";
/** The login with data rights only: the web's, the workers', cron's and a preview's seed's. */
export const POSTGRES_RUNTIME = "app_runtime";
/** The database container's variable with {@link POSTGRES_OWNER}'s password. */
export const OWNER_PASSWORD_ENV = "OPSCREW_OWNER_PASSWORD";
/** The database container's variable with {@link POSTGRES_RUNTIME}'s password. */
export const RUNTIME_PASSWORD_ENV = "OPSCREW_RUNTIME_PASSWORD";

/** One of the two logins. */
export type PostgresLogin = typeof POSTGRES_OWNER | typeof POSTGRES_RUNTIME;

const OWNER = POSTGRES_OWNER;
const RUNTIME = POSTGRES_RUNTIME;
/** The image's superuser and the app's database, as the catalog starts PostgreSQL. */
const SUPERUSER = "app";
const DATABASE = "app";

const ATTRIBUTES = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS";

/**
 * The statement and its error stay out of the server's log: they hold a password. Superuser
 * settings, so only these scripts' transactions can change them.
 */
const LOGGING_OFF = [
  "SET LOCAL log_statement = 'none';",
  "SET LOCAL log_min_error_statement = 'panic';",
];

/** The app's schemas: every one but the system's (names starting with `pg_` are reserved for it). */
const APP_SCHEMA = "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'";

/** No member of an extension: those stay the superuser's, who alone may own most of them. */
function notInExtension(catalog: string, oid: string): string {
  return `NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;
}

/**
 * Each of the app's schemas and objects the superuser owns, as two statements (research R4): its
 * `ALTER … OWNER TO app_owner`, and the runtime login's rights on it, or NULL where `PUBLIC`'s
 * suffice. `REASSIGN OWNED` can't take objects from the bootstrap superuser, which owns the system
 * catalogs. The schemas include `public`, which PostgreSQL 15 gives `pg_database_owner`. A sequence
 * of a column (serial, identity) moves with its table, so it gets only its grant; a table's row
 * type and every array type move with their own type, and a range's multirange needs its own
 * statement.
 *
 * The runtime login's rights on what exists are given here only, with the move: at the switch of
 * a database, or the load of a dump from before it. Later setups and loads leave them as they are,
 * so a migration that narrows them stays narrowed. What the owner creates later is covered by its
 * default privileges.
 */
const MOVES = [
  `SELECT format('ALTER SCHEMA %I OWNER TO ${OWNER}', n.nspname),`,
  `  format('GRANT USAGE ON SCHEMA %I TO ${RUNTIME}', n.nspname)`,
  "  FROM pg_namespace n",
  `  WHERE n.nspowner IN ('${SUPERUSER}'::regrole, 'pg_database_owner'::regrole) AND ${APP_SCHEMA}`,
  "UNION ALL",
  `SELECT format('ALTER %s %s OWNER TO ${OWNER}', CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, c.oid::regclass),`,
  `  CASE c.relkind WHEN 'S' THEN format('GRANT USAGE, SELECT ON SEQUENCE %s TO ${RUNTIME}', c.oid::regclass)`,
  `    ELSE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO ${RUNTIME}', c.oid::regclass) END`,
  "  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
  `  WHERE c.relowner = '${SUPERUSER}'::regrole AND ${APP_SCHEMA} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`,
  "  AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND (d.deptype = 'e' OR c.relkind = 'S' AND d.deptype IN ('a', 'i')))",
  "UNION ALL",
  `SELECT NULL, format('GRANT USAGE, SELECT ON SEQUENCE %s TO ${RUNTIME}', s.oid::regclass)`,
  "  FROM pg_class s JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid",
  "    AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')",
  "  JOIN pg_class c ON c.oid = d.refobjid JOIN pg_namespace n ON n.oid = c.relnamespace",
  `  WHERE s.relkind = 'S' AND c.relowner = '${SUPERUSER}'::regrole AND ${APP_SCHEMA} AND ${notInExtension("pg_class", "c.oid")}`,
  "UNION ALL",
  `SELECT format('ALTER ROUTINE %s OWNER TO ${OWNER}', p.oid::regprocedure), NULL`,
  "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace",
  `  WHERE p.proowner = '${SUPERUSER}'::regrole AND ${APP_SCHEMA} AND ${notInExtension("pg_proc", "p.oid")}`,
  "UNION ALL",
  `SELECT format('ALTER TYPE %s OWNER TO ${OWNER}', t.oid::regtype), NULL`,
  "  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace",
  `  WHERE t.typowner = '${SUPERUSER}'::regrole AND ${APP_SCHEMA} AND t.typtype IN ('c', 'd', 'e', 'm', 'r')`,
  "  AND (t.typtype <> 'c' OR (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c')",
  `  AND ${notInExtension("pg_type", "t.oid")}`,
  "UNION ALL",
  // PostgreSQL before 18 has no default privileges for large objects; those the runtime login makes
  // are its own.
  `SELECT format('ALTER LARGE OBJECT %s OWNER TO ${OWNER}', l.oid),`,
  `  format('GRANT SELECT, UPDATE ON LARGE OBJECT %s TO ${RUNTIME}', l.oid)`,
  `  FROM pg_largeobject_metadata l WHERE l.lomowner = '${SUPERUSER}'::regrole`,
];

/**
 * The setup's step 1 (data-model.md): each login created when missing, its password read from the
 * environment then only, so a rotation stays the only change of an existing one's. An existing
 * login with any other right stops the transaction with a message naming `service`.
 */
function roles(service: string): string[] {
  const create = (login: string, variable: string, env: string) => [
    `\\if :create_${variable}`,
    `\\getenv ${variable}_password ${env}`,
    `CREATE ROLE ${login} ${ATTRIBUTES} PASSWORD :'${variable}_password';`,
    "\\endif",
  ];
  return [
    ...LOGGING_OFF,
    "DO $$",
    "DECLARE taken text;",
    "BEGIN",
    `  SELECT r.rolname INTO taken FROM pg_roles r WHERE r.rolname IN ('${OWNER}', '${RUNTIME}')`,
    "    AND (NOT r.rolcanlogin OR r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls",
    "      OR EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid))",
    "    ORDER BY r.rolname LIMIT 1;",
    "  IF taken IS NOT NULL THEN",
    `    RAISE EXCEPTION 'The role % already exists in ${service} with other rights than OpsCrew gives it. Drop or rename it, then deploy again.', taken;`,
    "  END IF;",
    "END $$;",
    `SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER}') AS create_owner,`,
    `  NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME}') AS create_runtime \\gset`,
    ...create(OWNER, "owner", OWNER_PASSWORD_ENV),
    ...create(RUNTIME, "runtime", RUNTIME_PASSWORD_ENV),
  ];
}

/**
 * The setup's steps 2 to 5, the grants part (data-model.md), which needs no password: the owners
 * with the runtime login's rights on what moved ({@link MOVES}), what `PUBLIC` loses, and, through
 * the owner's global default privileges, the runtime login's data rights on whatever the owner
 * creates later (a new schema too). `CONNECT` stays with `PUBLIC`: without a schema's `USAGE` a
 * login reads nothing, and the devices' and the monitoring logins connect through it (research R6).
 * So the runtime login may also connect to the `postgres` database and make temporary tables
 * there, which is left as it is: none of the app's data is there.
 */
const GRANTS = [
  `ALTER DATABASE ${DATABASE} OWNER TO ${OWNER};`,
  ...MOVES,
  "\\gexec",
  `REVOKE TEMPORARY ON DATABASE ${DATABASE} FROM PUBLIC;`,
  "REVOKE ALL ON SCHEMA public FROM PUBLIC;",
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME};`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME};`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT USAGE ON SCHEMAS TO ${RUNTIME};`,
];

/**
 * Whether steps 1, 2, 3 and 5 hold: `t` or `f`. Step 4's rights come only with the moves of step
 * 2, and the app's migrations may narrow them. Each role is looked up with `to_regrole`, which
 * gives NULL rather than an error before the setup made it.
 */
const CHECK = [
  "SELECT (",
  `  (SELECT count(*) FROM pg_roles r WHERE r.rolname IN ('${OWNER}', '${RUNTIME}') AND r.rolcanlogin`,
  "    AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)",
  "    AND NOT EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid)) = 2",
  `  AND (SELECT d.datdba FROM pg_database d WHERE d.datname = '${DATABASE}') = to_regrole('${OWNER}')`,
  `  AND (SELECT n.nspowner FROM pg_namespace n WHERE n.nspname = 'public') = to_regrole('${OWNER}')`,
  "  AND NOT EXISTS (",
  ...MOVES.map((line) => `    ${line}`),
  "  )",
  `  AND NOT has_database_privilege('public', '${DATABASE}', 'TEMPORARY')`,
  "  AND NOT has_schema_privilege('public', 'public', 'USAGE, CREATE')",
  "  AND (SELECT count(*) FROM pg_default_acl d, aclexplode(d.defaclacl) a",
  `    WHERE d.defaclrole = to_regrole('${OWNER}') AND d.defaclnamespace = 0 AND a.grantee = to_regrole('${RUNTIME}')`,
  "    AND (d.defaclobjtype, a.privilege_type) IN (('r', 'SELECT'), ('r', 'INSERT'), ('r', 'UPDATE'),",
  "      ('r', 'DELETE'), ('S', 'USAGE'), ('S', 'SELECT'), ('n', 'USAGE'))) = 7",
  ") IS TRUE;",
];

/**
 * psql as the superuser on `database`, stopping at the first error: over the container's socket,
 * or over TCP to `host`.
 */
function psql(database: string, host?: string, flags = ""): string {
  const to = host === undefined ? "" : ` -h ${host}`;
  return `psql -X -q -v ON_ERROR_STOP=1${flags}${to} -U ${SUPERUSER} -d ${database}`;
}

/** `sql` on psql's stdin: `printf` is the shell's own, so the text is in no process's arguments. */
function piped(sql: readonly string[], database: string, host?: string, flags = ""): string {
  return `printf '%s\\n' ${shellQuote(sql.join("\n"))} | ${psql(database, host, flags)}`;
}

/** `lines` in one transaction, with only `pg_catalog` searched (the app's owner owns `public`). */
function transaction(lines: readonly string[]): string[] {
  return ["BEGIN;", "SET LOCAL search_path = pg_catalog;", ...lines, "COMMIT;"];
}

/**
 * The setup step's run (sh in the database's container, over its socket): data-model.md's steps 1
 * to 5 in one transaction, so a failure changes nothing. Running it again changes nothing either.
 * `service` is the database's service, named in the refusal of an existing login.
 */
export function loginsSetup(service: string): string {
  return piped(transaction([...roles(service), ...GRANTS]), DATABASE);
}

/**
 * The grants part alone (steps 2 to 5), in one transaction: what a load runs after `pg_restore`.
 * Over TCP to `host`, or the container's socket without it.
 */
export function loginsGrants(host?: string): string {
  return piped(transaction(GRANTS), DATABASE, host);
}

/**
 * The setup step's check: exits 0 only when all five steps hold, which costs a normal deploy one
 * query. Over TCP to `host`, or the container's socket without it.
 */
export function loginsCheck(host?: string): string {
  return `[ "$(${piped(["SET search_path = pg_catalog;", ...CHECK], DATABASE, host, " -At")})" = t ]`;
}

/**
 * A rotation's `begin` for `login` (sh in the database's container, with `OPSCREW_NEW` in the
 * exec's environment): its password set to the new value, skipped when that value already logs in.
 * The image trusts every login from 127.0.0.1, so that check goes to the container's own address.
 */
export function loginPassword(login: PostgresLogin): string {
  const change = [
    "BEGIN;",
    ...LOGGING_OFF,
    "\\getenv password OPSCREW_NEW",
    `ALTER ROLE ${login} PASSWORD :'password';`,
    "COMMIT;",
  ];
  return `PGPASSWORD="$OPSCREW_NEW" psql -X -q -w -h "$HOSTNAME" -U ${login} -d ${DATABASE} -c 'SELECT 1' > /dev/null 2>&1 || ${piped(change, DATABASE)}`;
}

/** Where a load runs, and whether its container can make the logins. */
export interface LoginsLoad {
  /** The database's host, reached over TCP with `PGPASSWORD` from the caller. */
  host: string;
  /** The superuser's `pg_dump -Fc` of the database, as a shell word. */
  file: string;
  /**
   * Whether the logins are made first, with the passwords from this container's environment (the
   * database's own container, or a copy of it); otherwise they must exist already.
   */
  setup: boolean;
}

/** Shown when a load finds no logins and may not make them; names the service only. */
function missingLogins(host: string): string {
  return `PostgreSQL ${host} has no logins ${OWNER} and ${RUNTIME}, so OpsCrew loaded nothing into it. Deploy the app there first, which creates them, then try again.`;
}

/**
 * The load of a dump with the two logins (data-model.md), one sh command list:
 * 1. the logins made (`setup`), or a refusal without them before anything is dropped;
 * 2. the database made anew, owned by the owner;
 * 3. `pg_restore` as the superuser and without `--no-owner`, so the dump's owners and grants come
 *    back (extensions stay the superuser's);
 * 4. the grants part, for the database's own grants, which a dump without `--create` lacks, and a
 *    dump from before the logins.
 */
export function loginsLoad(o: LoginsLoad): string {
  const roleCount = `SELECT count(*) FROM pg_roles WHERE rolname IN ('${OWNER}', '${RUNTIME}')`;
  const logins = o.setup
    ? piped(transaction(roles(o.host)), "postgres", o.host)
    : `{ [ "$(${psql("postgres", o.host, " -At")} -c "${roleCount}")" = 2 ] || { echo ${shellQuote(missingLogins(o.host))} >&2; false; }; }`;
  return [
    logins,
    `${psql("postgres", o.host)} -c "DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)" -c "CREATE DATABASE ${DATABASE} OWNER ${OWNER}"`,
    `pg_restore -h ${o.host} -U ${SUPERUSER} -d ${DATABASE} --single-transaction ${o.file}`,
    loginsGrants(o.host),
  ].join(" && ");
}

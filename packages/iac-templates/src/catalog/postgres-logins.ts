/**
 * PostgreSQL's two logins for the app (feature 047, ADR 0037). `app_owner` owns the database `app`,
 * its schemas and everything the migrations create, and only the release command logs in as it.
 * `app_runtime`, for the web, the workers and cron, may only read and write data. The image's
 * superuser `app` keeps OpsCrew's administration. It never runs the app's own code: the setup
 * only reads the catalogs and changes owners and rights, and a load restores the app's objects
 * and rows as `app_owner` ({@link loginsLoad}).
 *
 * Each script is sh for the database's own image, with fixed names. No password is in an argument:
 * psql binds them with `\getenv` from its environment, the owner's login reads its password from
 * the container's environment, and the SQL reaches psql on a pipe from the shell's own `printf`.
 * The scripts that log in over TCP (`host`) need the superuser's `PGPASSWORD` from their caller,
 * as the snapshots' commands export it; the others use the container's socket, which the image
 * trusts.
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
 * `ALTER <statement> … OWNER TO app_owner` for each object of `catalog` (as `o`) in the app's
 * schemas that the superuser owns, outside the extensions: `name` gives the object's name for it.
 */
function moves(
  statement: string,
  catalog: string,
  owner: string,
  namespace: string,
  name: string,
  more = "",
): string[] {
  return [
    `SELECT format('ALTER ${statement} %s OWNER TO ${OWNER}', ${name})`,
    `  FROM ${catalog} o JOIN pg_namespace n ON n.oid = o.${namespace}`,
    `  WHERE o.${owner} = '${SUPERUSER}'::regrole AND ${APP_SCHEMA} AND ${notInExtension(catalog, "o.oid")}${more}`,
  ];
}

/** An operator class's or family's name for `ALTER`: `schema.name USING method`. */
function usingMethod(name: string, method: string): string {
  return `format('%I.%I USING %I', n.nspname, o.${name}, (SELECT a.amname FROM pg_am a WHERE a.oid = o.${method}))`;
}

/**
 * One `ALTER … OWNER TO app_owner` for each of the app's schemas and objects the superuser owns
 * (research R4): `REASSIGN OWNED` can't take objects from the bootstrap superuser, which owns the
 * system catalogs. The schemas include `public`, which PostgreSQL 15 gives `pg_database_owner`.
 * Every extension's objects stay as they are, its own schema too (PostGIS's `topology`).
 *
 * A sequence of a column (serial, identity) moves with its table, and a table's row type and every
 * array type with their own type. A range's multirange moves with its range from PostgreSQL 17,
 * which refuses it alone; 16 moves it only alone.
 */
const MOVES = [
  `SELECT format('ALTER SCHEMA %I OWNER TO ${OWNER}', n.nspname) FROM pg_namespace n`,
  `  WHERE n.nspowner IN ('${SUPERUSER}'::regrole, 'pg_database_owner'::regrole) AND ${APP_SCHEMA}`,
  `  AND ${notInExtension("pg_namespace", "n.oid")}`,
  "  AND (n.nspname = 'public' OR NOT EXISTS (SELECT FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid WHERE d.classid = 'pg_namespace'::regclass AND d.objid = n.oid))",
  "UNION ALL",
  `SELECT format('ALTER %s %s OWNER TO ${OWNER}', CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, c.oid::regclass)`,
  "  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
  `  WHERE c.relowner = '${SUPERUSER}'::regrole AND ${APP_SCHEMA} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`,
  "  AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND (d.deptype = 'e' OR c.relkind = 'S' AND d.deptype IN ('a', 'i')))",
  ...[
    moves("ROUTINE", "pg_proc", "proowner", "pronamespace", "o.oid::regprocedure"),
    moves(
      "TYPE",
      "pg_type",
      "typowner",
      "typnamespace",
      "o.oid::regtype",
      " AND o.typtype IN ('c', 'd', 'e', 'm', 'r')" +
        " AND (o.typtype <> 'c' OR (SELECT c.relkind FROM pg_class c WHERE c.oid = o.typrelid) = 'c')" +
        " AND (o.typtype <> 'm' OR current_setting('server_version_num')::int < 170000)",
    ),
    moves("COLLATION", "pg_collation", "collowner", "collnamespace", "o.oid::regcollation"),
    moves(
      "STATISTICS",
      "pg_statistic_ext",
      "stxowner",
      "stxnamespace",
      "format('%I.%I', n.nspname, o.stxname)",
    ),
    moves(
      "TEXT SEARCH CONFIGURATION",
      "pg_ts_config",
      "cfgowner",
      "cfgnamespace",
      "o.oid::regconfig",
    ),
    moves(
      "TEXT SEARCH DICTIONARY",
      "pg_ts_dict",
      "dictowner",
      "dictnamespace",
      "o.oid::regdictionary",
    ),
    moves("OPERATOR", "pg_operator", "oprowner", "oprnamespace", "o.oid::regoperator"),
    moves(
      "OPERATOR CLASS",
      "pg_opclass",
      "opcowner",
      "opcnamespace",
      usingMethod("opcname", "opcmethod"),
    ),
    moves(
      "OPERATOR FAMILY",
      "pg_opfamily",
      "opfowner",
      "opfnamespace",
      usingMethod("opfname", "opfmethod"),
    ),
  ].flatMap((branch) => ["UNION ALL", ...branch]),
  "UNION ALL",
  `SELECT format('ALTER LARGE OBJECT %s OWNER TO ${OWNER}', l.oid)`,
  `  FROM pg_largeobject_metadata l WHERE l.lomowner = '${SUPERUSER}'::regrole`,
];

/**
 * The runtime login's rights on what the owner owns: `USAGE` on its schemas, data rights on its
 * tables and views, `USAGE, SELECT` on its sequences (a column's too) and `SELECT, UPDATE` on its
 * large objects. PostgreSQL before 18 has no default privileges for large objects; those the
 * runtime login makes are its own.
 */
const RUNTIME_RIGHTS = [
  `SELECT format('GRANT USAGE ON SCHEMA %I TO ${RUNTIME}', n.nspname) FROM pg_namespace n`,
  `  WHERE n.nspowner = '${OWNER}'::regrole AND ${APP_SCHEMA}`,
  "UNION ALL",
  `SELECT CASE c.relkind WHEN 'S' THEN format('GRANT USAGE, SELECT ON SEQUENCE %s TO ${RUNTIME}', c.oid::regclass)`,
  `  ELSE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO ${RUNTIME}', c.oid::regclass) END`,
  "  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
  `  WHERE c.relowner = '${OWNER}'::regrole AND ${APP_SCHEMA} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`,
  "UNION ALL",
  `SELECT format('GRANT SELECT, UPDATE ON LARGE OBJECT %s TO ${RUNTIME}', l.oid)`,
  `  FROM pg_largeobject_metadata l WHERE l.lomowner = '${OWNER}'::regrole`,
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
 * The refusal of a database with event triggers, naming `service`: a trigger's function runs as
 * whoever changes the database, so the superuser's setup would run code the owner may change.
 */
function eventTriggers(service: string): string {
  return `PostgreSQL ${service} has event triggers, and separate logins cannot run safely with them: OpsCrew changes the database as the superuser, which would run their code. Remove them with DROP EVENT TRIGGER, then try again.`;
}

/** The database's event triggers refused, in a transaction, before anything changes. */
function noEventTriggers(service: string): string[] {
  return [
    "DO $$",
    "BEGIN",
    `  IF EXISTS (SELECT FROM pg_event_trigger) THEN RAISE EXCEPTION '${eventTriggers(service).replaceAll("'", "''")}'; END IF;`,
    "END $$;",
  ];
}

/** Step 2: the database, then every schema and object the superuser owns, moved to the owner. */
const OWNERS = [`ALTER DATABASE ${DATABASE} OWNER TO ${OWNER};`, ...MOVES, "\\gexec"];

/**
 * The setup's steps 2 to 5, the grants part (data-model.md), which needs no password:
 * - the owners ({@link OWNERS});
 * - what `PUBLIC` loses. `CONNECT` stays with `PUBLIC`: without a schema's `USAGE` a login reads
 *   nothing, and the devices' and the monitoring logins connect through it (research R6). So the
 *   runtime login may also connect to the `postgres` database and make temporary tables there,
 *   which is left as it is: none of the app's data is there;
 * - the runtime login's rights on what exists ({@link RUNTIME_RIGHTS}), only while the owner has
 *   no default privileges yet: a new database, the switch of an existing one, or the load of a
 *   dump from before it. Later setups and loads leave them as they are, so a migration that
 *   narrows them stays narrowed;
 * - through the owner's global default privileges, its data rights on whatever the owner creates
 *   later (a new schema too).
 */
const GRANTS = [
  ...OWNERS,
  `REVOKE TEMPORARY ON DATABASE ${DATABASE} FROM PUBLIC;`,
  "REVOKE ALL ON SCHEMA public FROM PUBLIC;",
  `SELECT NOT EXISTS (SELECT FROM pg_default_acl d WHERE d.defaclrole = '${OWNER}'::regrole) AS first_grants \\gset`,
  "\\if :first_grants",
  ...RUNTIME_RIGHTS,
  "\\gexec",
  "\\endif",
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME};`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME};`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT USAGE ON SCHEMAS TO ${RUNTIME};`,
];

/**
 * Whether steps 1, 2, 3 and 5 hold: `t` or `f`. Step 4's rights are given once, and the app's
 * migrations may narrow them. Each role is looked up with `to_regrole`, which gives NULL rather
 * than an error before the setup made it.
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
 * to 5 in one transaction, after the refusal of event triggers, so a failure changes nothing.
 * Running it again changes nothing either. `service` is the database's service, named in the
 * refusals.
 */
export function loginsSetup(service: string): string {
  return piped(transaction([...noEventTriggers(service), ...roles(service), ...GRANTS]), DATABASE);
}

/**
 * The grants part alone (steps 2 to 5), in one transaction: the end of {@link loginsLoad}, which
 * every load of a dump runs whole. Over TCP to `host`, or the container's socket without it.
 */
export function loginsGrants(host?: string): string {
  return piped(transaction(GRANTS), DATABASE, host);
}

/**
 * The setup step's check: exits 0 only when steps 1, 2, 3 and 5 hold, which costs a normal deploy
 * one query. Over TCP to `host`, or the container's socket without it.
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
  /**
   * The database's host, reached over TCP: as the superuser with `PGPASSWORD` from the caller, and
   * as the owner with its password from this container's environment.
   */
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

/** An extended regular expression for the dump's table-of-contents lines of the kinds `kinds`. */
function entries(kinds: string): string {
  return `'^[0-9]+; [0-9]+ [0-9]+ (${kinds}) '`;
}

/** What the superuser restores first: the schemas, which extensions may live in, and extensions. */
const FIRST = "SCHEMA|EXTENSION|COMMENT - EXTENSION";
/** What the superuser restores last: the rights, which run no code. */
const LAST = "ACL|DEFAULT ACL";

/**
 * The extensions' own tables and sequences, whose rows or values a dump keeps, as `pg_restore -l`
 * lists them after the entry's ID and OIDs: `TABLE DATA <schema> <table> <owner>` or
 * `SEQUENCE SET <schema> <sequence> <owner>` (for example PostGIS's `topology.topology_id_seq`).
 */
const EXTENSION_TABLES = [
  "SET search_path = pg_catalog;",
  "SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE SET ' ELSE 'TABLE DATA ' END",
  "    || n.nspname || ' ' || c.relname || ' ' || pg_get_userbyid(c.relowner)",
  "  FROM pg_extension e CROSS JOIN LATERAL unnest(e.extconfig) AS x(oid)",
  "  JOIN pg_class c ON c.oid = x.oid JOIN pg_namespace n ON n.oid = c.relnamespace;",
];

/**
 * The dump's table-of-contents lines that are (`rows`) or aren't an extension's table's rows, each
 * compared whole without its ID and OIDs, owner included: the owner login's table named like one
 * (`cfg trap` beside `cfg`) never matches, and it can't own anything as the superuser.
 */
function extensionRows(rows: boolean): string {
  return `awk 'FILENAME == ARGV[1] { t[$0]; next } { e = $0; sub(/^[^ ]+ [^ ]+ [^ ]+ /, "", e) } (e in t) == ${rows ? 1 : 0}' "$d/extension-tables" "$d/toc"`;
}

/**
 * The load of a dump with the two logins (data-model.md), one sh command in a subshell, its lists
 * in a folder it removes. The app's objects and rows are restored as `app_owner`, which logs in
 * itself: a CHECK, a domain or a trigger can call the owner's functions during the restore, and
 * under the superuser's login (`--role` only sets the role) they could make the owner a superuser.
 * 1. the dump's table of contents, and the refusal of event triggers;
 * 2. the logins made (`setup`), or a refusal without them, before anything is dropped;
 * 3. the database made anew, the superuser's until its extensions are made, so the owner can't
 *    add anything to it before them;
 * 4. as the superuser, the dump's schemas and extensions, then the owners moved (the database's
 *    too);
 * 5. as the owner, everything else, without the owners (`--no-owner`: a dump from before the
 *    logins gives the owner every object), the rights and the extensions' tables' rows;
 * 6. as the superuser, the extensions' tables' rows, whose constraints are the extension's, and the
 *    rights, as the dump has them;
 * 7. the grants part, for the database's own grants, which a dump without `--create` lacks, and the
 *    runtime login's rights on a dump from before the logins.
 */
export function loginsLoad(o: LoginsLoad): string {
  const { host, file } = o;
  const roleCount = `SELECT count(*) FROM pg_roles WHERE rolname IN ('${OWNER}', '${RUNTIME}')`;
  const logins = o.setup
    ? piped(transaction(roles(host)), "postgres", host)
    : `{ [ "$(${psql("postgres", host, " -At")} -c "${roleCount}")" = 2 ] || { echo ${shellQuote(missingLogins(host))} >&2; false; }; }`;
  const restore = (login: string, list: string, flags = "") =>
    `pg_restore -h ${host} -U ${login} -d ${DATABASE}${flags} --single-transaction -L "$d/${list}" ${file}`;
  const steps = [
    'd="$(mktemp -d)"',
    `trap 'rm -rf "$d"' EXIT`,
    `pg_restore -l ${file} > "$d/toc"`,
    `{ ! grep -qE ${entries("EVENT TRIGGER")} "$d/toc" || { echo ${shellQuote(eventTriggers(host))} >&2; false; }; }`,
    logins,
    `${psql("postgres", host)} -c "DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)" -c "CREATE DATABASE ${DATABASE}"`,
    `{ grep -E ${entries(FIRST)} "$d/toc" || true; } > "$d/first"`,
    restore(SUPERUSER, "first", " --no-owner"),
    piped(transaction(OWNERS), DATABASE, host),
    `${piped(EXTENSION_TABLES, DATABASE, host, " -At")} > "$d/extension-tables"`,
    `{ ${extensionRows(false)} | grep -vE ${entries(`${FIRST}|${LAST}`)} || true; } > "$d/owner"`,
    `PGPASSWORD="$${OWNER_PASSWORD_ENV}" ${restore(OWNER, "owner", " --no-owner")}`,
    `{ grep -E ${entries(LAST)} "$d/toc"; ${extensionRows(true)}; true; } > "$d/last"`,
    restore(SUPERUSER, "last"),
    loginsGrants(host),
  ];
  return `( ${steps.join(" && ")} )`;
}

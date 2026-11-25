# Data model: An app's PostgreSQL never runs as the superuser

## The plan's field

```yaml
services:
  - name: db
    kind: postgres
    version: "17"
    options:
      logins: separate   # written by design; absent only on databases made before 047
```

- **`options.logins`:** optional, and `"separate"` is its only value. Any other value is refused
  with `must be "separate"`. Without it, PostgreSQL's options stay `{}` and parse exactly as before.
- **Provision's refusals:**
  - removed from a plan whose committed version (`HEAD`) has it: "The database db already has
    separate logins for the app and its migrations, and OpsCrew can't give the app the superuser
    again. Put `logins: separate` back under its options in opscrew/plan.yaml.";
  - a hand-written `logins: separate` below version 15: "PostgreSQL 14 can't use separate logins
    (OpsCrew's setup needs psql 15 or later). Upgrade db to 17 first, then add
    `logins: separate`." An older version without the field is never refused.

## The logins

| Login | Made by | Used by | Attributes | Owns |
|---|---|---|---|---|
| `app` | the image (`POSTGRES_USER`) | setup, snapshots, restores, moves' loads, rotation, devices' grants | superuser | extensions, the system |
| `app_owner` | the setup step | the release command only | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, no memberships | the database `app`, its schemas and every object the app's migrations create |
| `app_runtime` | the setup step | web, workers, cron, a preview's seed | the same | nothing |

## The setup step's grants (one transaction, as `app` over the socket)

1. **The roles:** each is created if missing, with `\getenv` and its env password. An existing role
   with another attribute or a membership stops the transaction with: "The role app_runtime
   already exists in db with other rights than OpsCrew gives it. Drop or rename it, then deploy
   again."
2. **The owners:** the database, then every schema and object the superuser owns move to
   `app_owner` (research R4).
3. **What `PUBLIC` loses:** `REVOKE TEMPORARY ON DATABASE app FROM PUBLIC` and
   `REVOKE ALL ON SCHEMA public FROM PUBLIC`. `CONNECT` stays with `PUBLIC`: with no schema or
   object rights a login connects but reads nothing, and the devices' and monitoring logins need
   it (research R6).
4. **The runtime login, now**, for each schema `app_owner` owns: `GRANT USAGE ON SCHEMA s`,
   `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA s`, and
   `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA s`, each `TO app_runtime`.
5. **The runtime login, later:** `ALTER DEFAULT PRIVILEGES FOR ROLE app_owner GRANT SELECT,
   INSERT, UPDATE, DELETE ON TABLES TO app_runtime`, the same for `USAGE, SELECT ON SEQUENCES` and
   for `USAGE ON SCHEMAS`.

Steps 2 to 5 are **the grants part**, which needs no password: the loads run it after a restore.
The step's **check** is one query that returns `t` only when all five hold.

## The secrets and env

| Secret (service `db`) | Format | Container env | App env (`app.env`) | Release env (`release.db.env`) |
|---|---|---|---|---|
| `password` | hex32 | `POSTGRES_PASSWORD` | not with `logins` | no |
| `owner-password` (new) | hex32 | `OPSCREW_OWNER_PASSWORD` | no | yes |
| `runtime-password` (new) | hex32 | `OPSCREW_RUNTIME_PASSWORD` | yes | no |

- **The variables** are those OpsCrew already derives for the service. In `app.env` they name
  `app_runtime`; in `release.db.env` the same names name `app_owner`:
  - `DATABASE_URL=postgresql://app_runtime:<runtime-password>@db:5432/app`;
  - the app's own detected variable;
  - the split settings (`DB_USERNAME` or `DB_USER`, `DB_PASSWORD` or `DB_PASS`).
- **The deploy secret** `OPSCREW_RELEASE_DB_ENV` holds `release.db.env`. The workflow writes it
  owner-only next to `app.env`, and only the `release` service reads it:
  `env_file: [app.env, release.db.env]`.
- **Without `logins`,** there is no new secret, file or env value.

## Rotation

| Secret | Mode | `recreate` | `seconds` | Env files rewritten |
|---|---|---|---|---|
| `password` | swap | false | 1 | `db.env` (and `app.env` without `logins`) |
| `owner-password` | swap | false | 1 | `db.env`, `release.db.env` |
| `runtime-password` | swap | false | 1 | `db.env`, `app.env` |

Each `begin` runs this as `app` over the socket, with `OPSCREW_NEW` in the exec's env:
`BEGIN; SET LOCAL log_statement = 'none'; \getenv pw OPSCREW_NEW; ALTER ROLE <login> PASSWORD
:'pw'; COMMIT;`. It is skipped when the new value already logs in.

## The load of a dump, with `logins`

1. the setup's run, where the load is in the database's container; elsewhere, the check that both
   roles exist;
2. `DROP DATABASE IF EXISTS app WITH (FORCE)`, then `CREATE DATABASE app OWNER app_owner`;
3. `pg_restore -U app -d app --single-transaction <file>`, without `--no-owner`;
4. the grants part.

## Provision's texts

- **The notice,** for a deployed environment without `logins`: "Your app logs in to PostgreSQL
  (db) as its superuser. To give it a login that can only read and write data, add
  `logins: separate` under db's options in opscrew/plan.yaml and run `npx opscrew provision`: it
  shows the switch before anything changes."
- **The notice below 15:** "db runs PostgreSQL 14, so your app logs in as its superuser. Separate
  logins for the app and its migrations come with an upgrade to PostgreSQL 15 or later." Design's
  summary says the same.
- **The switch's plan lines:**
  - "Take a snapshot of db now.";
  - "db restarts once (a few seconds) with two new passwords.";
  - "The next deploy creates app_owner and app_runtime and gives app_owner the app's tables, in
    one transaction. If it fails, nothing changes and the app keeps its current login.";
  - "From that deploy, the release command logs in as app_owner, and the app, workers and cron as
    app_runtime."

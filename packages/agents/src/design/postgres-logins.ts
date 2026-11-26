/**
 * PostgreSQL's two logins in design (047, ADR 0037): design writes `logins: separate` on every new
 * PostgreSQL 15 or later; an older one keeps its single login, which design and provision say. A
 * new PHP app's gets PgBouncer beside it too (`pooler: pgbouncer`, 050), as PHP opens a new
 * connection on every request.
 */
import { POOLER_MEMORY_MB, poolerName } from "@opscrew/iac-templates";
import type { PlanService, RuntimeLanguage } from "@opscrew/plan-schema";

/** The first PostgreSQL version the logins' setup runs on: it binds passwords with psql's `\getenv`. */
export const LOGINS_MIN_VERSION = 15;

/** True when PostgreSQL `version` (`17`, `16.4`) can have the two logins. */
export function loginsVersion(version: string): boolean {
  return Number.parseInt(version, 10) >= LOGINS_MIN_VERSION;
}

/**
 * The options of a new PostgreSQL at `version` for an app in `language`: its own logins from 15
 * on, and for a PHP app the pooler with them; else none.
 */
export function newPostgresOptions(
  version: string,
  language: RuntimeLanguage,
): { logins?: "separate"; pooler?: "pgbouncer" } {
  if (!loginsVersion(version)) return {};
  return language === "php" ? { logins: "separate", pooler: "pgbouncer" } : { logins: "separate" };
}

/** What design and provision say of a PostgreSQL below 15 (data-model.md). */
export function loginsUpgradeNotice(service: Pick<PlanService, "name" | "version">): string {
  return `${service.name} runs PostgreSQL ${service.version}, so your app logs in as its superuser. Separate logins for the app and its migrations come with an upgrade to PostgreSQL ${LOGINS_MIN_VERSION} or later.`;
}

/** Design's line on a PostgreSQL with the pooler (050): what it does and why. */
export function poolerLine(service: PlanService): string {
  return `PgBouncer (${poolerName(service)}, ${POOLER_MEMORY_MB} MB) keeps a few connections to ${service.name} open and hands them to each request in turn, where a PHP app would open a new one on every request. Migrations connect to ${service.name} directly.`;
}

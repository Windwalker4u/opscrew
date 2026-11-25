/**
 * PostgreSQL's two logins in design (047, ADR 0037): design writes `logins: separate` on every new
 * PostgreSQL 15 or later; an older one keeps its single login, which design and provision say.
 */
import type { PlanService } from "@opscrew/plan-schema";

/** The first PostgreSQL version the logins' setup runs on: it binds passwords with psql's `\getenv`. */
export const LOGINS_MIN_VERSION = 15;

/** True when PostgreSQL `version` (`17`, `16.4`) can have the two logins. */
export function loginsVersion(version: string): boolean {
  return Number.parseInt(version, 10) >= LOGINS_MIN_VERSION;
}

/** The options of a new PostgreSQL at `version`: its own logins from 15 on, else none. */
export function newPostgresOptions(version: string): { logins?: "separate" } {
  return loginsVersion(version) ? { logins: "separate" } : {};
}

/** What design and provision say of a PostgreSQL below 15 (data-model.md). */
export function loginsUpgradeNotice(service: Pick<PlanService, "name" | "version">): string {
  return `${service.name} runs PostgreSQL ${service.version}, so your app logs in as its superuser. Separate logins for the app and its migrations come with an upgrade to PostgreSQL ${LOGINS_MIN_VERSION} or later.`;
}

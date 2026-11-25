import type { PlanService, ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeFacts, makeRequirements, testPlan } from "../testing";
import { designComponents } from "./components";

type Service = ProjectFacts["services"][number];
const PG: Service = { kind: "postgres", evidence: ["dependency:pg"] };
const facts = makeFacts({ services: [PG] });
const NOTICE_14 =
  "db runs PostgreSQL 14, so your app logs in as its superuser. Separate logins for the app and its migrations come with an upgrade to PostgreSQL 15 or later.";

/** The components designed for an app on PostgreSQL over a previous plan whose db is `db`. */
function over(db: Partial<PlanService>) {
  const plan = testPlan();
  const previous = {
    ...plan,
    services: plan.services.map((s) => (s.name === "db" ? ({ ...s, ...db } as PlanService) : s)),
  };
  return designComponents({ facts, requirements: makeRequirements(), previous });
}

describe("design and PostgreSQL's two logins (047)", () => {
  it("writes logins: separate on a new PostgreSQL 15 or later", () => {
    const { components, lines } = designComponents({ facts, requirements: makeRequirements() });
    expect(components.services).toEqual([
      expect.objectContaining({ kind: "postgres", version: "17", options: { logins: "separate" } }),
    ]);
    expect(lines.join("\n")).not.toContain("superuser");
  });

  it("keeps a pinned PostgreSQL 14 without logins, and its summary says they come with 15", () => {
    const { components, lines } = over({ version: "14", options: {} });
    expect(components.services[0]).toMatchObject({ version: "14", options: {} });
    expect(lines).toContain(NOTICE_14);
  });

  it("keeps a database from before 047 as it is: no switch, and no edit of yours named", () => {
    const { components, lines, keptChanges } = over({ options: {} });
    expect(components.services[0]?.options).toEqual({});
    expect(keptChanges.join("\n")).not.toContain("the service db");
    expect(lines.join("\n")).not.toContain("superuser");
  });

  it("keeps logins: separate on a design run again", () => {
    const { components, keptChanges } = over({ options: { logins: "separate" } });
    expect(components.services[0]?.options).toEqual({ logins: "separate" });
    expect(keptChanges).toEqual([]);
  });
});

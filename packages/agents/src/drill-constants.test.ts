// The scheduled drills' names and bounds: ssh-host's copies (the host plan's drills step, its text
// and the check key's command) are the ones the drill script in iac-templates uses.
import * as sshHost from "@opscrew/connector-ssh-host";
import * as templates from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { testPlan } from "./testing";

describe("the drill constants in ssh-host", () => {
  it("equal iac-templates' drill constants", () => {
    expect(sshHost.DRILL_RECIPE).toBe(templates.DRILL_RECIPE_DIR);
    expect(sshHost.DRILL_VALUES).toBe(templates.DRILL_VALUES_FILE);
    expect(sshHost.DRILL_SCHEDULE_FILE).toBe(templates.DRILL_RECIPE_SCHEDULE);
    expect(sshHost.DRILL_DIR).toBe(templates.DRILL_DIR);
    expect(sshHost.DRILLS_LOG).toBe(templates.DRILLS_LOG);
    expect(sshHost.DRILL_SLOT_AFTER_HOURS).toBe(templates.DRILL_SLOT_AFTER_HOURS);
    expect(sshHost.DRILL_LIMIT_SECONDS).toBe(templates.DRILL_LIMIT_SECONDS);
    const plan = testPlan();
    expect(sshHost.drillProject(plan.app.name).name).toBe(
      templates.drillProject(plan, "20261118T120000Z").name,
    );
  });
});

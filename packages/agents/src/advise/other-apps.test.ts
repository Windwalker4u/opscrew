import type { HostFacts } from "@opscrew/connector-ssh-host";
import { describe, expect, it } from "vitest";
import { createdServerFacts, secondAppRecord, testPlan } from "../testing";
import { deployed, IPS, scenario } from "./__fixtures__/environment";
import { readAdvice } from "./readings";

/** The first app on one Hetzner server, whose inspection reports `facts` (or throws). */
async function firstApp(facts: HostFacts | Error) {
  const s = await scenario({ plan: deployed(testPlan()), host: {} });
  const inspect = async () => {
    if (facts instanceof Error) throw facts;
    return facts;
  };
  const options = { ...s.options, services: { ...s.options.services, otherApps: { inspect } } };
  const read = await readAdvice(s.deps, s.plan, "", options);
  const said = [s.deps.reporter.text(), JSON.stringify(s.deps.audit.entries), JSON.stringify(read)];
  return { ...read, said: said.join("\n") };
}

describe("advise beside apps from other repositories (FR-3016)", () => {
  it("counts the memory limits of the apps that run there beside the app's", async () => {
    const { readings, checked, said } = await firstApp(
      createdServerFacts([
        secondAppRecord({ memoryMb: 768 }),
        secondAppRecord({ app: "archive", state: "data-kept" }),
      ]),
    );
    expect(readings.sharedPreviewsMb).toBe(768);
    expect(checked).toContain('the memory limits of "inventory" on the server');
    expect(said).not.toContain(IPS.app);
  });

  it("says it couldn't count an app whose record OpsCrew can't read", async () => {
    const facts = createdServerFacts([secondAppRecord({ memoryMb: 512 })]);
    facts.apps.push({ name: "ledger", record: null });
    const { readings } = await firstApp(facts);
    expect(readings.sharedPreviewsMb).toBe(512);
    expect(readings.notRead).toContain(
      `the memory of "ledger" on the server: OpsCrew can't read its record, so the size advice doesn't count it`,
    );
  });

  it("says when it couldn't look, and counts nothing", async () => {
    const { readings, said } = await firstApp(new Error(`ssh: connect to host ${IPS.app}`));
    expect(readings.sharedPreviewsMb).toBeUndefined();
    expect(readings.notRead).toContain(
      "the other apps on the server: OpsCrew couldn't look (it could not be reached over SSH)",
    );
    expect(said).not.toContain(IPS.app);
  });

  it("adds nothing when the server holds no other app", async () => {
    const { readings, checked } = await firstApp(createdServerFacts());
    expect(readings.sharedPreviewsMb).toBeUndefined();
    expect(checked.join("\n")).not.toContain("on the server");
  });
});

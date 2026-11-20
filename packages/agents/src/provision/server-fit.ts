import { otherActiveApps, tunnelOf } from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import { edgeMemoryMb, edgeProxy } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { onAppServer } from "../design/placement";
import { ownServerMemory, type ServerApp } from "../design/sizing";
import { appMemoryMb } from "../shared/memory";
import { ownServerFacts } from "../shared/own-server";
import type { OwnServerInspection } from "./own";

/**
 * Design's memory check, run again by provision before it plans anything (FR-3024): on the app's
 * own server as `inspected` found it, the plan's limits on the app's server must fit beside the
 * other OpsCrew apps there (a second app's first app, from its plan, and the active records of
 * every other app, this app's own left out), the edge and the system's reserve. Only a server that
 * holds other apps is checked, so a limit raised by hand in opscrew/plan.yaml can't overcommit it.
 * Below 15% free it warns and goes on.
 * @throws OpsCrewError `PHASE_PRECONDITION` in design's words, ending "Nothing was changed.",
 * saying to run design and `again` after lowering the limits.
 */
export function requireServerFit(
  deps: Pick<PhaseDeps, "reporter">,
  plan: DeployPlan,
  inspected: Pick<OwnServerInspection, "facts" | "first">,
  again: string,
): void {
  const { facts, first } = inspected;
  const others: ServerApp[] = [
    ...(first === undefined
      ? []
      : [
          {
            name: first.plan.app.name,
            memoryMb: appMemoryMb(first.plan),
            tunnel: false,
          },
        ]),
    ...otherActiveApps(facts.apps, plan.app.name).map((record) => ({
      name: record.app,
      memoryMb: record.memoryMb,
      tunnel: tunnelOf(facts, record.app).installed,
    })),
  ];
  if (others.length === 0) return;
  const memory = ownServerMemory(
    ownServerFacts(facts).memoryGb * 1024,
    appMemoryMb(onAppServer(plan)),
    others,
    edgeMemoryMb(edgeProxy(plan)),
    undefined,
    { again },
  );
  if (memory?.refused !== undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", memory.refused.message, {
      hint: memory.refused.hint,
    });
  }
  if (memory?.warning !== undefined) deps.reporter.warn(memory.warning);
}

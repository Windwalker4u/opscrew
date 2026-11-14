import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  createTestPhaseDeps,
  FakeEngine,
  ownPlan,
  portainerPlan,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { rootVariables } from "./root-variables";
import { recordPortainerConnection, updateServerAddresses } from "./server-record";

const AGAIN = "opscrew rotate access-token";

describe("rootVariables", () => {
  it("gives an own server's root its recorded address", async () => {
    const deps = await createTestPhaseDeps();
    await updateServerAddresses(deps.paths, (current) => ({
      ...current,
      deployment: { ipv4: SERVER_IPV4 },
    }));
    const env: Record<string, string | undefined> = { TF_ENCRYPTION: "kept" };
    const plan = ownPlan({ access: "public", deployed: true });
    await rootVariables(deps, plan, { engine: new FakeEngine(), env }, AGAIN);
    expect(env).toEqual({ TF_ENCRYPTION: "kept", TF_VAR_server_ipv4: SERVER_IPV4 });
  });

  it("gives a Portainer root the recorded Portainer's address, never this computer's", async () => {
    const deps = await createTestPhaseDeps();
    await recordPortainerConnection(deps.paths, {
      url: "https://portainer.example.com:9443",
      environmentId: 3,
      environmentName: "local",
    });
    const env: Record<string, string | undefined> = {
      TF_VAR_portainer_origin: "https://elsewhere.example.com",
    };
    const plan = portainerPlan({ redeploy: "cloudflare", deployed: true });
    await rootVariables(deps, plan, { engine: new FakeEngine(), env }, AGAIN);
    expect(env.TF_VAR_portainer_origin).toBe("https://portainer.example.com:9443");
  });

  it("stops when this computer has no record of the Portainer", async () => {
    const deps = await createTestPhaseDeps();
    const plan = portainerPlan({ redeploy: "cloudflare", deployed: true });
    const error = await rootVariables(
      deps,
      plan,
      { engine: new FakeEngine(), env: {} },
      AGAIN,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toMatch(
      /no record of how OpsCrew reaches your Portainer/,
    );
    expect((error as OpsCrewError).hint).toContain(`then run \`${AGAIN}\` again`);
  });

  it("sets nothing for a cloud server", async () => {
    const deps = await createTestPhaseDeps();
    const env: Record<string, string | undefined> = {};
    await rootVariables(
      deps,
      testPlan({ deployed: true }),
      { engine: new FakeEngine(), env },
      AGAIN,
    );
    expect(env).toEqual({});
  });
});

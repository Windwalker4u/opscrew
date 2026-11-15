import { CloudflareClient, CloudflareError } from "@opscrew/connector-cloudflare";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortHarness } from "./abort.fakes";
import { ZONE } from "./session.fakes";
import { switchHarness } from "./switch.fakes";

afterEach(() => {
  vi.restoreAllMocks();
});

const FROM_RECORD = "can't read Cloudflare Registrar";

/** A's token refused on Cloudflare Registrar for want of the permission, as R10.8 saw it. */
function refuseRegistrarInA(accountA: string) {
  vi.spyOn(CloudflareClient.prototype, "getRegistration").mockImplementation(async (accountId) => {
    if (accountId === accountA) {
      throw new CloudflareError(
        `Cloudflare refused the request to read the registration of ${ZONE}: Authentication error (10000).`,
        { hint: "Edit the token." },
      );
    }
    return undefined;
  });
}

describe("findSwitchRegistrar: A's token without a Registrar permission", () => {
  it("Cloudflare's record names Cloudflare: the dashboard steps of the move between accounts", async () => {
    const h = await switchHarness({ registrar: "other" });
    h.deps.interactive = true;
    refuseRegistrarInA(h.aZone.accountId);
    h.bZone.originalRegistrar = "cloudflare, inc. (id: 1910)";
    const stopped = await h.run();
    expect(stopped.done).toBe(false);
    expect(stopped.next.join("\n")).toContain("Domain Registration");
    expect(h.deps.reporter.text()).toContain(FROM_RECORD);
    expect(h.deps.reporter.text()).toContain("Cloudflare Registrar");
  });

  it("Cloudflare's record names another registrar: the nameservers to set", async () => {
    const h = await switchHarness({ registrar: "other" });
    h.deps.interactive = true;
    refuseRegistrarInA(h.aZone.accountId);
    h.bZone.originalRegistrar = "porkbun llc";
    const stopped = await h.run();
    expect(stopped.done).toBe(false);
    expect(stopped.next[0]).toContain(h.bZone.nameServers[0]);
    expect(stopped.next.join("\n")).not.toContain("Domain Registration");
    expect(h.deps.reporter.text()).toContain(FROM_RECORD);
  });

  it("no record of the registrar: another registrar", async () => {
    const h = await switchHarness({ registrar: "other" });
    h.deps.interactive = true;
    refuseRegistrarInA(h.aZone.accountId);
    const stopped = await h.run();
    expect(stopped.done).toBe(false);
    expect(stopped.next[0]).toContain(h.bZone.nameServers[0]);
    expect(h.deps.reporter.text()).toContain(FROM_RECORD);
  });

  it("a readable registrar: read as before, no word of Cloudflare's record", async () => {
    const h = await switchHarness({ registrar: "cloudflare" });
    h.deps.interactive = true;
    h.bZone.originalRegistrar = "porkbun llc";
    const stopped = await h.run();
    expect(stopped.next.join("\n")).toContain("Domain Registration");
    expect(h.deps.reporter.text()).not.toContain(FROM_RECORD);
  });

  it.skipIf(!findExecutable("git"))(
    "the abort goes on past the registrar to its checks",
    async () => {
      const h = await abortHarness({ registrar: "other" });
      refuseRegistrarInA(h.aZone.accountId);
      h.web.ns = [...(h.bZone?.nameServers ?? [])];
      const error = await h.run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).message).toContain(
        "its nameservers are no longer those of the account Old",
      );
      expect(h.deps.reporter.text()).toContain(FROM_RECORD);
    },
  );
});

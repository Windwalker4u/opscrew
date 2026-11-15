import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Registrar } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { connectProject, OLD_DS, RUN_NOW, TOKEN, visibleText } from "../testing";
import { dsWaitStatus, readDs, removeDsAndWait, waitFor } from "./connect-ds";
import type { RegistryDsTtl } from "./registry-ds";

const DOMAIN = "example.com";
const ZONE = "zone-b";
const SECOND_DS = { keyTag: 2371, algorithm: 13, digestType: 2, digest: "ABCDEF0123" };

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** example.com at Porkbun with an old DS record; the public DNS's copy has an hour left. */
async function porkbunWithDs(now = RUN_NOW) {
  const cp = await connectProject();
  const pb = cp.other("porkbun");
  pb.own(DOMAIN);
  pb.dsRecords.set(DOMAIN, [{ ...OLD_DS }]);
  cp.dns.ds.set(DOMAIN, { records: [{ ...OLD_DS }, { ...SECOND_DS }], ttl: 3600 });
  const run = await cp.run({ now });
  const registrar = run.services.registrars?.porkbun as Registrar;
  const stateFile = join(run.deps.paths.root, ".opscrew", "cloudflare-move-ds.json");
  return { cp, pb, deps: run.deps, registrar, stateFile };
}

/** `deps` with the registry's nameservers answering `answer`, logging each domain asked. */
function withRegistry<T extends object>(deps: T, answer: RegistryDsTtl) {
  const asked: string[] = [];
  const registryDs = async (domain: string) => {
    asked.push(domain);
    return answer;
  };
  return { deps: { ...deps, registryDs }, asked };
}

describe("readDs", () => {
  it("reads the DS record's full TTL from the registry's own nameservers", async () => {
    const { deps: base, registrar } = await porkbunWithDs();
    const { deps, asked } = withRegistry(base, { kind: "published", ttlSeconds: 1800 });

    const ds = await readDs({ deps, domain: DOMAIN, registrar });

    expect(ds.registry).toEqual({ kind: "published", ttlSeconds: 1800 });
    // The resolver's copy keeps its own (remaining) TTL, for when that copy expires.
    expect(ds.ttlSeconds).toBe(3600);
    expect(asked).toEqual([DOMAIN]);
  });

  it("does not ask the registry when no DS record is published", async () => {
    const { cp, pb, deps: base, registrar } = await porkbunWithDs();
    pb.dsRecords.set(DOMAIN, []);
    cp.dns.ds.delete(DOMAIN);
    const { deps, asked } = withRegistry(base, { kind: "published", ttlSeconds: 1800 });

    const ds = await readDs({ deps, domain: DOMAIN, registrar });

    expect(ds.registry).toEqual({ kind: "none" });
    expect(asked).toEqual([]);
  });

  it("combines what the registrar's API lists with what the public DNS shows", async () => {
    const { cp, deps, registrar } = await porkbunWithDs();

    const ds = await readDs({ deps, domain: DOMAIN, registrar });

    expect(ds).toEqual({
      api: [OLD_DS],
      public: [OLD_DS, SECOND_DS],
      records: [OLD_DS, SECOND_DS],
      ttlSeconds: 3600,
      registry: { kind: "unreadable" },
      at: new Date(RUN_NOW),
    });
    expect(cp.project.cf.events).toEqual([`porkbun listDsRecords ${DOMAIN}`, `dns DS ${DOMAIN}`]);
  });

  it("reads only the public DNS without a registrar OpsCrew drives", async () => {
    const { cp, deps } = await porkbunWithDs();

    const ds = await readDs({ deps, domain: DOMAIN });

    expect(ds.api).toBeUndefined();
    expect(ds.records).toEqual([OLD_DS, SECOND_DS]);
    expect(cp.project.cf.events).toEqual([`dns DS ${DOMAIN}`]);
  });
});

describe("removeDsAndWait and dsWaitStatus", () => {
  it("removes the listed DS records, notes the wait in the given file and audits each removal", async () => {
    const { cp, pb, deps, registrar, stateFile } = await porkbunWithDs();
    const ds = await readDs({ deps, domain: DOMAIN, registrar });
    expect(await dsWaitStatus(stateFile, new Date(RUN_NOW), ds)).toBeUndefined();

    const note = await removeDsAndWait(
      {
        deps,
        domain: DOMAIN,
        registrarId: "porkbun",
        registrar,
        state: undefined,
        ds,
        zoneId: ZONE,
      },
      stateFile,
    );

    // 24 hours after the public copy expires (13:00), plus an hour after a removal.
    const written = {
      domain: DOMAIN,
      registrar: "porkbun",
      zoneId: ZONE,
      switchAfter: "2026-10-12T14:00:00.000Z",
      waitSeconds: 86400,
    };
    expect(note).toEqual(written);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(written);
    expect(pb.dsRecords.get(DOMAIN)).toEqual([]);
    expect(cp.project.cf.events.at(-1)).toBe(`porkbun removeDsRecord ${DOMAIN} 4012`);
    expect(deps.audit.entries.map((e) => [e.action, e.detail])).toEqual([
      [
        "remove DS record",
        `Porkbun: key tag 4012 (algorithm 8, digest type 2), before switching to zone ${ZONE}`,
      ],
    ]);

    const after = await readDs({ deps, domain: DOMAIN, registrar });
    expect(await dsWaitStatus(stateFile, new Date("2026-10-12T13:59:59.000Z"), after)).toEqual({
      waiting: true,
      switchAfter: "2026-10-12T14:00:00.000Z",
      waitSeconds: 86400,
    });
    expect(
      await dsWaitStatus(stateFile, new Date("2026-10-12T14:00:00.000Z"), after),
    ).toMatchObject({
      waiting: false,
    });
    expect(visibleText(deps)).not.toContain(TOKEN);
  });

  it("never moves an earlier run's switch time earlier or shortens its wait", async () => {
    const { deps, registrar, stateFile } = await porkbunWithDs();
    const ds = await readDs({ deps, domain: DOMAIN, registrar });
    const state = {
      domain: DOMAIN,
      registrar: "porkbun" as const,
      switchAfter: "2026-10-14T00:00:00.000Z",
      waitSeconds: 172800,
    };

    const note = await removeDsAndWait(
      { deps, domain: DOMAIN, registrarId: "porkbun", registrar, state, ds, zoneId: ZONE },
      stateFile,
    );

    expect(note).toMatchObject({ switchAfter: "2026-10-14T00:00:00.000Z", waitSeconds: 172800 });
  });

  it("stops before any change when the registrar's API cannot remove the records", async () => {
    const { cp, pb, deps, stateFile } = await porkbunWithDs();
    // Porkbun's API as it lists DS records, without the call that removes them
    const registrar = pb.api();
    const ds = await readDs({ deps, domain: DOMAIN, registrar });

    const error = await caught(
      removeDsAndWait(
        {
          deps,
          domain: DOMAIN,
          registrarId: "porkbun",
          registrar,
          state: undefined,
          ds,
          zoneId: ZONE,
        },
        stateFile,
      ),
    );

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "Porkbun's API cannot remove the DNSSEC (DS) records of example.com. Nothing was changed.",
    );
    expect(error.hint).toContain("key tag 4012");
    expect(cp.project.cf.events.some((e) => e.includes("removeDsRecord"))).toBe(false);
    expect(await dsWaitStatus(stateFile, new Date(RUN_NOW), ds)).toBeUndefined();
    expect(deps.audit.entries).toEqual([]);
  });

  it("starts the wait once the API lists no DS record after an interrupted removal, and only once", async () => {
    const { pb, deps, registrar, stateFile } = await porkbunWithDs();
    const ds = await readDs({ deps, domain: DOMAIN, registrar });
    // The removal goes through, then the run is interrupted before it notes the switch time.
    const remove = registrar.removeDsRecord?.bind(registrar);
    const interrupted: Registrar = {
      ...registrar,
      removeDsRecord: async (domain, keyTag) => {
        await remove?.(domain, keyTag);
        throw new Error("connection reset");
      },
    };
    await expect(
      removeDsAndWait(
        {
          deps,
          domain: DOMAIN,
          registrarId: "porkbun",
          registrar: interrupted,
          state: undefined,
          ds,
          zoneId: ZONE,
        },
        stateFile,
      ),
    ).rejects.toThrow("connection reset");
    expect(pb.dsRecords.get(DOMAIN)).toEqual([]);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({ dsSeen: RUN_NOW });

    // While the API still lists a DS record, the wait has not started.
    pb.dsRecords.set(DOMAIN, [{ ...OLD_DS }]);
    const listed = await readDs({ deps, domain: DOMAIN, registrar });
    expect(await dsWaitStatus(stateFile, new Date("2026-10-11T13:00:00.000Z"), listed)).toEqual({
      waiting: true,
      waitSeconds: 86400,
    });
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({ dsSeen: RUN_NOW });

    // The next run finds none listed: the wait starts then, and the note keeps that time.
    pb.dsRecords.set(DOMAIN, []);
    const gone = await readDs({ deps, domain: DOMAIN, registrar });
    const started = { waiting: true, switchAfter: "2026-10-12T14:00:00.000Z", waitSeconds: 86400 };
    expect(await dsWaitStatus(stateFile, new Date("2026-10-11T14:00:00.000Z"), gone)).toEqual(
      started,
    );
    const note = JSON.parse(await readFile(stateFile, "utf8"));
    expect(note.dsSeen).toBeUndefined();
    expect(note.switchAfter).toBe(started.switchAfter);
    expect(await dsWaitStatus(stateFile, new Date("2026-10-12T10:00:00.000Z"), gone)).toEqual(
      started,
    );
    expect(await dsWaitStatus(stateFile, new Date("2026-10-12T14:00:00.000Z"), gone)).toMatchObject(
      { waiting: false },
    );
  });

  it("stops on an unreadable note", async () => {
    const { deps, registrar, stateFile } = await porkbunWithDs();
    const ds = await readDs({ deps, domain: DOMAIN, registrar });
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, "{");

    const error = await caught(dsWaitStatus(stateFile, new Date(RUN_NOW), ds));

    expect(error.code).toBe("PHASE_PRECONDITION");
  });
});

describe("the wait from the registry's own TTL", () => {
  /** Removes the DS records with the registry answering `answer`; the note written. */
  async function removedWith(answer: RegistryDsTtl, state?: { waitSeconds: number }) {
    const { deps: base, registrar, stateFile } = await porkbunWithDs();
    const { deps } = withRegistry(base, answer);
    const ds = await readDs({ deps, domain: DOMAIN, registrar });
    const noted = state && { domain: DOMAIN, registrar: "porkbun" as const, ...state };
    return removeDsAndWait(
      { deps, domain: DOMAIN, registrarId: "porkbun", registrar, state: noted, ds, zoneId: ZONE },
      stateFile,
    );
  }

  it("TTL 1800: waits 2 hours after the public copy expires (13:00), plus the hour after a removal", async () => {
    expect(await removedWith({ kind: "published", ttlSeconds: 1800 })).toMatchObject({
      switchAfter: "2026-10-11T16:00:00.000Z",
      waitSeconds: 7200,
    });
  });

  it("TTL 86400: waits 48 hours", async () => {
    expect(await removedWith({ kind: "published", ttlSeconds: 86_400 })).toMatchObject({
      switchAfter: "2026-10-13T14:00:00.000Z",
      waitSeconds: 172_800,
    });
  });

  it("an unreadable registry (UDP 53 blocked): waits 24 hours", async () => {
    expect(await removedWith({ kind: "unreadable" })).toMatchObject({
      switchAfter: "2026-10-12T14:00:00.000Z",
      waitSeconds: 86_400,
    });
  });

  it("keeps a longer wait an earlier run noted", async () => {
    const note = await removedWith(
      { kind: "published", ttlSeconds: 1800 },
      { waitSeconds: 86_400 },
    );
    expect(note).toMatchObject({ switchAfter: "2026-10-12T14:00:00.000Z", waitSeconds: 86_400 });
  });

  it("keeps the noted wait once the registry no longer publishes the record, else 24 hours", () => {
    const ds = {
      public: [OLD_DS],
      records: [OLD_DS],
      ttlSeconds: 600,
      registry: { kind: "none" } as const,
      at: new Date(RUN_NOW),
    };
    const state = { switchAfter: "2026-10-11T16:00:00.000Z", waitSeconds: 7200 };
    expect(waitFor(state, ds)).toBe(7200);
    expect(waitFor(undefined, ds)).toBe(86_400);
    expect(waitFor(state, { ...ds, registry: { kind: "unreadable" } })).toBe(86_400);
  });
});

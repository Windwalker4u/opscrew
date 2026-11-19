import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ED25519_FINGERPRINT, LAN_IPV4, OWN_IPV4 } from "../testing";
import {
  type OwnServerConnectionInput,
  type PortainerConnectionInput,
  readOldOwnServer,
  readServerAddresses,
  recordOwnServer,
  recordPortainerConnection,
  restoreOldConnection,
  setAsideOldConnection,
  updateServerAddresses,
} from "./server-record";

const OLD_OWN: OwnServerConnectionInput = {
  host: OWN_IPV4,
  port: 22,
  user: "root",
  agent: true,
  reachable: true,
};
const NEW_OWN: OwnServerConnectionInput = {
  host: LAN_IPV4,
  port: 2222,
  user: "admin",
  agent: true,
  reachable: true,
};
const PORTAINER: PortainerConnectionInput = {
  url: "https://portainer.example.com:9443",
  environmentId: 2,
  environmentName: "home",
  created: { stacks: [{ id: 7, name: "opscrew-shop", role: "app" }], volumes: ["shop_db_data"] },
};
const OLD_ADDRESS = { ipv4: "198.51.100.10" };

async function paths() {
  return (await createTestPhaseDeps()).paths;
}

describe("a move's connections in server.json", () => {
  it("sets the old own server's login aside at the start, so `own` can take the new one", async () => {
    const p = await paths();
    await recordOwnServer(p, OLD_OWN);
    await updateServerAddresses(p, (current) => ({ ...current, retarget: { from: OLD_ADDRESS } }));

    await setAsideOldConnection(p, "own");
    const record = await readServerAddresses(p);
    expect(record.own).toBeUndefined();
    expect(record.retarget).toEqual({ from: OLD_ADDRESS, fromOwn: { ...OLD_OWN } });
    expect(await readOldOwnServer(p)).toEqual(OLD_OWN);

    // The new side's login goes to the usual slot; a second set-aside changes nothing.
    await recordOwnServer(p, NEW_OWN);
    await setAsideOldConnection(p, "own");
    expect((await readServerAddresses(p)).own).toEqual(NEW_OWN);
    expect(await readOldOwnServer(p)).toEqual(OLD_OWN);
  });

  it("sets the old Portainer connection aside with what OpsCrew created there", async () => {
    const p = await paths();
    await recordPortainerConnection(p, PORTAINER);
    await setAsideOldConnection(p, "portainer");
    const record = await readServerAddresses(p);
    expect(record.portainer).toBeUndefined();
    expect(record.retarget?.fromPortainer?.created.stacks).toEqual(PORTAINER.created?.stacks);
  });

  it.each([
    ["own", "the server your app is moving from"],
    ["portainer", "the Portainer your app is moving from"],
  ] as const)(
    "stops when the old %s connection is not on this computer, changing nothing",
    async (from, what) => {
      const p = await paths();
      await updateServerAddresses(p, (current) => ({
        ...current,
        retarget: { from: OLD_ADDRESS },
      }));
      const before = await readServerAddresses(p);
      const error = await setAsideOldConnection(p, from).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining(what),
      });
      expect((error as Error).message).toMatch(/Nothing was changed\.$/);
      expect(await readServerAddresses(p)).toEqual(before);
    },
  );

  it("sets nothing aside for a cloud server, whose address the move records itself", async () => {
    const p = await paths();
    await recordOwnServer(p, NEW_OWN);
    await setAsideOldConnection(p, "hetzner");
    const record = await readServerAddresses(p);
    expect(record.own).toEqual(NEW_OWN);
    expect(record.retarget).toBeUndefined();
  });

  it("puts the old login back on abort and forgets the new side's", async () => {
    const p = await paths();
    await recordOwnServer(p, OLD_OWN);
    await setAsideOldConnection(p, "own");
    await recordOwnServer(p, NEW_OWN);

    await restoreOldConnection(p, { from: "own", to: "own" });
    const record = await readServerAddresses(p);
    expect(record.own).toEqual(OLD_OWN);
    expect(record.retarget?.fromOwn).toBeUndefined();

    // Again (an interrupted abort): the restored login stays.
    await restoreOldConnection(p, { from: "own", to: "own" });
    expect((await readServerAddresses(p)).own).toEqual(OLD_OWN);
  });

  it("forgets the new own server's login when the move came from a cloud server", async () => {
    const p = await paths();
    await setAsideOldConnection(p, "digitalocean");
    await recordOwnServer(p, NEW_OWN);
    await updateServerAddresses(p, (current) => ({ ...current, retarget: { from: OLD_ADDRESS } }));
    await restoreOldConnection(p, { from: "digitalocean", to: "own" });
    const record = await readServerAddresses(p);
    expect(record.own).toBeUndefined();
    expect(record.retarget).toEqual({ from: OLD_ADDRESS });
  });

  it("puts the old Portainer back in place of a new own server", async () => {
    const p = await paths();
    await recordPortainerConnection(p, PORTAINER);
    await setAsideOldConnection(p, "portainer");
    await recordOwnServer(p, NEW_OWN);
    await restoreOldConnection(p, { from: "portainer", to: "own" });
    const record = await readServerAddresses(p);
    expect(record.own).toBeUndefined();
    expect(record.portainer?.environmentId).toBe(2);
    expect(record.retarget?.fromPortainer).toBeUndefined();
  });
});

describe("a server at home in server.json", () => {
  const LAN = "192.168.1.30";
  const HOME_OWN = {
    host: LAN,
    port: 22,
    user: "ana",
    agent: true,
    serve: "proxy" as const,
    home: {
      sshFrom: ["192.168.1.0/24", "fe80::/10"],
      network: {
        detectedAt: "2026-11-20T10:00:00Z",
        lan: { address: LAN, network: "192.168.1.0/24", interface: "eth0", gateway: "192.168.1.1" },
        ipv4: "seen" as const,
        noNat: false,
        warning: "cgnat-hop" as const,
        ipv6: "present" as const,
      },
      outsideCheck: {
        at: "2026-11-20T10:30:00Z",
        host: "shop.example.com",
        mode: "proxied" as const,
        http: "ok" as const,
        https: "ok" as const,
        runUrl: "https://github.com/owner/repo/actions/runs/123",
      },
    },
  } satisfies OwnServerConnectionInput;

  it("keeps the answers, the LAN facts, the classification and the last outside check", async () => {
    const p = await paths();
    await recordOwnServer(p, HOME_OWN);
    expect((await readServerAddresses(p)).own).toEqual(HOME_OWN);
    // Without NAT the server's own address is public: the LAN facts are left out.
    const { lan: _lan, ...network } = HOME_OWN.home.network;
    const noNat = { ...HOME_OWN, home: { network: { ...network, noNat: true } } };
    await recordOwnServer(p, noNat);
    expect((await readServerAddresses(p)).own).toEqual(noNat);
  });

  it("never keeps a public address or reachability for a server at home", async () => {
    const p = await paths();
    const detected = "198.51.100.73";
    const refused: OwnServerConnectionInput[] = [
      { ...HOME_OWN, publicIpv4: detected },
      { ...HOME_OWN, publicIpv6: "2001:db8:1:2::30" },
      { ...HOME_OWN, reachable: true },
      {
        ...HOME_OWN,
        home: {
          network: {
            ...HOME_OWN.home.network,
            lan: { ...HOME_OWN.home.network.lan, address: detected },
          },
        },
      },
      {
        ...HOME_OWN,
        home: {
          network: {
            ...HOME_OWN.home.network,
            lan: { ...HOME_OWN.home.network.lan, gateway: detected },
          },
        },
      },
      {
        ...HOME_OWN,
        home: {
          network: {
            ...HOME_OWN.home.network,
            lan: { ...HOME_OWN.home.network.lan, network: "198.51.100.0/24" },
          },
        },
      },
      // Only the known keys: no hop, no public address field.
      {
        ...HOME_OWN,
        home: { network: { ...HOME_OWN.home.network, publicIpv4: detected } },
      } as never,
      { ...HOME_OWN, home: { ...HOME_OWN.home, publicIpv4: detected } } as never,
    ];
    for (const own of refused) {
      await expect(recordOwnServer(p, own)).rejects.toThrow();
    }
    expect(await readServerAddresses(p)).toEqual({ schemaVersion: 1 });
  });

  it("takes SSH's sources only as nft prints them, at most 32", async () => {
    const p = await paths();
    const withSources = (sshFrom: string[]) => ({ ...HOME_OWN, home: { sshFrom } });
    for (const sshFrom of [
      [],
      ["192.168.1.7/24"],
      ["203.0.113.7/32"],
      ["0.0.0.0/0"],
      Array.from({ length: 33 }, (_, i) => `10.${i}.0.0/16`),
    ]) {
      await expect(recordOwnServer(p, withSources(sshFrom))).rejects.toThrow();
    }
    await recordOwnServer(p, withSources(["203.0.113.7", "2001:db8::/32"]));
    expect((await readServerAddresses(p)).own?.home?.sshFrom).toEqual([
      "203.0.113.7",
      "2001:db8::/32",
    ]);
  });

  it("reads a damaged home record as damaged, never as a server away from home", async () => {
    const p = await paths();
    await updateServerAddresses(p, () => ({ schemaVersion: 1, own: HOME_OWN }));
    const file = join(p.stateDir, "server.json");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace('"seen"', '"maybe"'));
    await expect(readServerAddresses(p)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining("own.home.network.ipv4 is not valid"),
    });
  });
});

describe("a second app on a server OpsCrew created for another app, in server.json", () => {
  const root = join(tmpdir(), "first-app");
  const SHARED_OWN = (p: { files: { deployKey: string } }): OwnServerConnectionInput => ({
    host: OWN_IPV4,
    user: "deploy",
    agent: false,
    keyPath: p.files.deployKey,
    shares: { root },
  });

  it("keeps the first app's folder, its app key and environment (prod by default), and joined", async () => {
    const p = await paths();
    await recordOwnServer(p, SHARED_OWN(p));
    expect((await readServerAddresses(p)).own?.shares).toEqual({ root, environment: "prod" });
    await recordOwnServer(p, {
      ...SHARED_OWN(p),
      shares: { root, app: "admin", environment: "staging" },
      hostKey: ED25519_FINGERPRINT,
      joined: true,
    });
    const own = (await readServerAddresses(p)).own;
    expect(own?.shares).toEqual({ root, app: "admin", environment: "staging" });
    expect(own?.joined).toBe(true);
  });

  it("refuses reachable, serve, home and any login but deploy beside shares", async () => {
    const p = await paths();
    for (const extra of [
      { reachable: true },
      { serve: "proxy" as const },
      { home: {} },
      { user: "root" },
    ]) {
      await expect(recordOwnServer(p, { ...SHARED_OWN(p), ...extra })).rejects.toThrow();
    }
    await expect(
      recordOwnServer(p, { ...SHARED_OWN(p), shares: { root: "first-app" } }),
    ).rejects.toThrow();
    expect((await readServerAddresses(p)).own).toBeUndefined();
  });

  it("refuses joined without the pinned host key or without shares", async () => {
    const p = await paths();
    await expect(recordOwnServer(p, { ...SHARED_OWN(p), joined: true })).rejects.toThrow();
    const { shares: _shares, ...alone } = SHARED_OWN(p);
    await expect(
      recordOwnServer(p, { ...alone, hostKey: ED25519_FINGERPRINT, joined: true }),
    ).rejects.toThrow();
    expect((await readServerAddresses(p)).own).toBeUndefined();
  });
});

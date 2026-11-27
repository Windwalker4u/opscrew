import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotRequest } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { type FakeCall, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  CREDENTIALS,
  CREDENTIALS_ENV,
  fakeTime,
  kamateraFetch,
  queued,
  refused,
} from "./__fixtures__/fixtures";
import {
  COMMAND,
  OTHER_ID,
  POWER_COMMAND,
  SERVER_IDS,
  SHOP_ID,
  server,
  serverList,
  snapshot,
  WORKER_ID,
} from "./__fixtures__/servers";
import { KamateraClient, readKamateraCredentials } from "./client";
import { kamateraServerApi } from "./servers";

/** A root password and an address, as a command's log may hold them. */
const PASSWORD = fakeSecret("generic-password", "kamatera-root");
const ADDRESS = "203.0.113.47";

/** Every value OpsCrew must never show: the API key, the servers' ids, a password, an address. */
const SECRETS = [...Object.values(CREDENTIALS), ...SERVER_IDS, PASSWORD, ADDRESS];

/** The name OpsCrew gives the snapshot it takes at the fake clock's start. */
const TAKEN = "opscrew-shop-shop-20261126T100000Z";

function setup(routes: Record<string, FakeReply | FakeReply[]>) {
  const fake = kamateraFetch(routes);
  const time = fakeTime();
  const redactor = new Redactor();
  // As the connector does: the values are registered when they are read.
  readKamateraCredentials(CREDENTIALS_ENV, redactor);
  const client = new KamateraClient({
    credentials: CREDENTIALS,
    redactor,
    fetch: fake.fetch,
    sleep: time.sleep,
    now: time.now,
  });
  const api = kamateraServerApi(client, { redactor, now: time.now });
  return { api, calls: fake.calls, time };
}

/** The requests sent, as `METHOD /path?query`. */
const requests = (calls: FakeCall[]) => calls.map((call) => `${call.method} ${call.path}`);

/** The bodies of the `POST`s sent, in order. */
const posted = (calls: FakeCall[]) =>
  calls.filter((call) => call.method === "POST").map((call) => call.body);

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const errorText = (error: OpsCrewError) =>
  `${error.message} ${error.hint ?? ""} ${String(error.cause ?? "")}`;

const request = (labels: Record<string, string> = { app: "shop" }): SnapshotRequest => ({
  name: "shop before destroy",
  description: "Taken by OpsCrew",
  labels,
});

describe("findAppServers", () => {
  it("returns the servers named exactly app or app-<name>, each nameOnly, its id its name", async () => {
    const { api, calls } = setup({
      "GET /service/servers": serverList(
        server("shop"),
        server("shop-worker", { id: WORKER_ID, power: "off", datacenter: "US-NY2" }),
        server("shopfront", { id: OTHER_ID }),
        server("myshop", { id: OTHER_ID }),
        server("SHOP", { id: OTHER_ID }),
        server("shop_2", { id: OTHER_ID }),
        server("shopfront(1)", { id: OTHER_ID }),
        server("myshop(1)", { id: OTHER_ID }),
      ),
    });
    expect(await api.findAppServers("shop")).toEqual([
      { id: "shop", name: "shop", status: "on", nameOnly: true },
      { id: "shop-worker", name: "shop-worker", status: "off", nameOnly: true },
    ]);
    expect(requests(calls)).toEqual(["GET /service/servers"]);
  });

  it("returns every server with the app's name, since Kamatera's names aren't unique", async () => {
    const { api } = setup({
      "GET /service/servers": serverList(server("shop"), server("shop", { id: OTHER_ID })),
    });
    expect(await api.findAppServers("shop")).toEqual([
      { id: "shop", name: "shop", status: "on", nameOnly: true },
      { id: "shop", name: "shop", status: "on", nameOnly: true },
    ]);
  });

  it("stops at a duplicate Kamatera renamed <name>(1), naming it and its datacenter", async () => {
    const { api } = setup({
      "GET /service/servers": serverList(
        server("shop"),
        server("shop(1)", { id: OTHER_ID, datacenter: "EU-FR" }),
      ),
    });
    const error = await failure(api.findAppServers("shop"));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "Kamatera has the server shop(1) in EU-FR: a duplicate Kamatera made and renamed when a create of a name it already had was sent again. It still bills, and OpsCrew never takes it over.",
    );
    expect(error.hint).toBe(
      "Delete it in your Kamatera account's console (its Terminate action), then run the command again.",
    );
  });

  it("names every duplicate of the app's servers, whatever their number", async () => {
    const { api } = setup({
      "GET /service/servers": serverList(
        server("shop-worker(1)", { id: WORKER_ID, datacenter: "US-NY2" }),
        server("shop(12)", { id: OTHER_ID, datacenter: "AS-SG" }),
      ),
    });
    const error = await failure(api.findAppServers("shop"));
    expect(error.message).toBe(
      "Kamatera has the servers shop-worker(1) in US-NY2 and shop(12) in AS-SG: duplicates Kamatera made and renamed when a create of a name it already had was sent again. They still bill, and OpsCrew never takes them over.",
    );
    expect(error.hint).toBe(
      "Delete them in your Kamatera account's console (its Terminate action), then run the command again.",
    );
  });
});

describe("snapshotServer", () => {
  it("snapshots the one server with the name, waits for its command and answers its id", async () => {
    const { api, calls, time } = setup({
      "GET /service/servers": serverList(server("shop"), server("shop-worker", { id: WORKER_ID })),
      "POST /server/snapshot": [
        COMMAND,
        { body: [snapshot(17, "before-upgrade"), snapshot(1745411375, TAKEN)] },
      ],
      "GET /service/queue": [queued("pending"), queued("complete")],
    });
    expect(await api.snapshotServer("shop", request())).toEqual({
      snapshotId: "shop:1745411375",
    });
    expect(requests(calls)).toEqual([
      "GET /service/servers",
      "POST /server/snapshot",
      "GET /service/queue?id=4242",
      "GET /service/queue?id=4242",
      "POST /server/snapshot",
    ]);
    // The server by its id, never by its name: Kamatera's API reads a name as a pattern.
    expect(posted(calls)).toEqual([{ id: SHOP_ID, create: TAKEN }, { id: SHOP_ID }]);
    expect(time.waits).toEqual([2_000]);
  });

  it("refuses a request that names no app, before any call", async () => {
    const { api, calls } = setup({});
    const error = await failure(api.snapshotServer("shop", request({})));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "OpsCrew names a Kamatera snapshot after its app, and the snapshot of the server shop names none.",
    );
    expect(calls).toEqual([]);
  });

  it("stops waiting after 15 minutes, or the request's limit, with a plain message", async () => {
    const routes = {
      "GET /service/servers": serverList(server("shop")),
      "POST /server/snapshot": COMMAND,
      "GET /service/queue": queued("running"),
    };
    const first = setup(routes);
    const error = await failure(first.api.snapshotServer("shop", request()));
    expect(error.message).toBe(
      "Kamatera's command to snapshot the server shop did not finish within 15 minutes.",
    );
    expect(error.hint).toContain("your Kamatera account's console");
    expect(first.time.now() - Date.parse("2026-11-26T10:00:00Z")).toBe(15 * 60_000);

    const second = setup(routes);
    const limited = await failure(
      second.api.snapshotServer("shop", { ...request(), timeoutMs: 60_000 }),
    );
    expect(limited.message).toContain("did not finish within 1 minute.");
  });

  it("says so when Kamatera doesn't list the snapshot it finished", async () => {
    const { api } = setup({
      "GET /service/servers": serverList(server("shop")),
      "POST /server/snapshot": [COMMAND, { body: [snapshot(17, "before-upgrade")] }],
      "GET /service/queue": queued("complete"),
    });
    const error = await failure(api.snapshotServer("shop", request()));
    expect(error.message).toBe(
      `Kamatera finished the snapshot ${TAKEN} of the server shop, but doesn't list it.`,
    );
    expect(error.hint).toBe(
      "Check the server's snapshots in your Kamatera account's console before taking another: each one is billed per GB a month.",
    );
  });

  it("refuses a server name Kamatera has twice, or not at all, before any change", async () => {
    const twice = setup({
      "GET /service/servers": serverList(server("shop"), server("shop", { id: OTHER_ID })),
    });
    const error = await failure(twice.api.snapshotServer("shop", request()));
    expect(error.message).toBe(
      "Kamatera has 2 servers named shop, so OpsCrew can't tell which one is the app's.",
    );
    expect(error.hint).toBe(
      "Keep the app's server and rename or terminate the others in your Kamatera account's console, then try again.",
    );
    expect(requests(twice.calls)).toEqual(["GET /service/servers"]);

    const none = setup({ "GET /service/servers": serverList(server("shop-worker")) });
    const missing = await failure(none.api.snapshotServer("shop", request()));
    expect(missing.message).toBe("Kamatera has no server named shop.");
    expect(missing.hint).toBe(
      "It may have been terminated or renamed: check the servers in your Kamatera account's console.",
    );
    expect(requests(none.calls)).toEqual(["GET /service/servers"]);
  });
});

describe("listSnapshots", () => {
  it("lists OpsCrew's snapshots of the server, oldest first, by the time their names end with", async () => {
    const { api, calls } = setup({
      "GET /service/servers": serverList(server("shop"), server("shop-worker", { id: WORKER_ID })),
      "POST /server/snapshot": {
        body: [
          snapshot(3, "opscrew-shop-shop-20261126T120000Z", "11/26/2026 12:00:04"),
          snapshot(1, "opscrew-shop-shop-20261120T080000Z", "11/20/2026 08:00:03"),
          snapshot(9, "before-upgrade"),
          snapshot(5, "opscrew-shop-shop-worker-20261121T000000Z"),
          snapshot(6, "opscrew-shop-shop-20261121"),
        ],
      },
    });
    expect(await api.listSnapshots("shop")).toEqual([
      { id: "shop:1", createdAt: "2026-11-20T08:00:00.000Z" },
      { id: "shop:3", createdAt: "2026-11-26T12:00:00.000Z" },
    ]);
    expect(requests(calls)).toEqual(["GET /service/servers", "POST /server/snapshot"]);
    expect(posted(calls)).toEqual([{ id: SHOP_ID }]);
  });
});

describe("deleteSnapshot", () => {
  it("deletes the snapshot through its server and waits for the command", async () => {
    const { api, calls } = setup({
      "GET /service/servers": serverList(server("shop")),
      "POST /server/snapshot": COMMAND,
      "GET /service/queue": [queued("pending"), queued("complete")],
    });
    await api.deleteSnapshot("shop:1745411375");
    expect(requests(calls)).toEqual([
      "GET /service/servers",
      "POST /server/snapshot",
      "GET /service/queue?id=4242",
      "GET /service/queue?id=4242",
    ]);
    expect(posted(calls)).toEqual([{ id: SHOP_ID, delete: "1745411375" }]);
  });

  it("stops waiting after 15 minutes with a plain message", async () => {
    const { api } = setup({
      "GET /service/servers": serverList(server("shop")),
      "POST /server/snapshot": COMMAND,
      "GET /service/queue": queued("running"),
    });
    const error = await failure(api.deleteSnapshot("shop:17"));
    expect(error.message).toBe(
      "Kamatera's command to delete the snapshot 17 of the server shop did not finish within 15 minutes.",
    );
  });

  it("refuses an id OpsCrew didn't give out, before any call", async () => {
    const { api, calls } = setup({});
    for (const id of ["1745411375", "shop:", ":17", "shop:abc", "shop:17:2"]) {
      const error = await failure(api.deleteSnapshot(id));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toBe(
        `"${id}" is not a Kamatera snapshot id: OpsCrew writes them as <server name>:<snapshot id>.`,
      );
    }
    expect(calls).toEqual([]);
  });
});

describe("power", () => {
  it("powers the server off without forcing it and waits for the command", async () => {
    const { api, calls } = setup({
      "GET /service/servers": serverList(server("shop")),
      "POST /service/server/poweroff": POWER_COMMAND,
      "GET /service/queue": [queued("pending"), queued("complete")],
    });
    await api.powerOff("shop");
    expect(requests(calls)).toEqual([
      "GET /service/servers",
      "POST /service/server/poweroff",
      "GET /service/queue?id=4243",
      "GET /service/queue?id=4243",
    ]);
    expect(posted(calls)).toEqual([{ id: SHOP_ID }]);
  });

  it("leaves a server that is already off, and stops waiting for a shutdown after 5 minutes", async () => {
    const off = setup({ "GET /service/servers": serverList(server("shop", { power: "off" })) });
    await off.api.powerOff("shop");
    expect(requests(off.calls)).toEqual(["GET /service/servers"]);

    const slow = setup({
      "GET /service/servers": serverList(server("shop")),
      "POST /service/server/poweroff": POWER_COMMAND,
      "GET /service/queue": queued("running"),
    });
    const error = await failure(slow.api.powerOff("shop"));
    expect(error.message).toBe(
      "Kamatera's command to power the server shop off did not finish within 5 minutes.",
    );
  });

  it("powers the server on and waits, and leaves one that is already on", async () => {
    const { api, calls } = setup({
      "GET /service/servers": serverList(server("shop", { power: "off" })),
      "POST /service/server/poweron": POWER_COMMAND,
      "GET /service/queue": queued("complete"),
    });
    await api.powerOn("shop");
    expect(requests(calls)).toEqual([
      "GET /service/servers",
      "POST /service/server/poweron",
      "GET /service/queue?id=4243",
    ]);
    expect(posted(calls)).toEqual([{ id: SHOP_ID }]);

    const on = setup({ "GET /service/servers": serverList(server("shop")) });
    await on.api.powerOn("shop");
    expect(requests(on.calls)).toEqual(["GET /service/servers"]);
  });

  it("restarts the server and waits for the command", async () => {
    const { api, calls } = setup({
      "GET /service/servers": serverList(server("shop")),
      "POST /service/server/reboot": POWER_COMMAND,
      "GET /service/queue": queued("complete"),
    });
    await api.restart?.("shop");
    expect(requests(calls)).toEqual([
      "GET /service/servers",
      "POST /service/server/reboot",
      "GET /service/queue?id=4243",
    ]);
    expect(posted(calls)).toEqual([{ id: SHOP_ID }]);
  });

  it("says which command failed and points to the console", async () => {
    const { api } = setup({
      "GET /service/servers": serverList(server("shop")),
      "POST /service/server/reboot": POWER_COMMAND,
      "GET /service/queue": queued("error", "Server is locked"),
    });
    const error = await failure(Promise.resolve(api.restart?.("shop")));
    expect(error.message).toMatch(/^Kamatera's command to restart the server shop failed/);
    expect(error.hint).toContain("your Kamatera account's console");
  });
});

describe("rebuild", () => {
  it("reverts the server to its snapshot through its id and waits for the command", async () => {
    const { api, calls } = setup({
      "GET /service/servers": serverList(server("shop"), server("shop-worker", { id: WORKER_ID })),
      "POST /server/snapshot": COMMAND,
      "GET /service/queue": [queued("pending"), queued("complete")],
    });
    await api.rebuild("shop", "shop:1745411375");
    expect(requests(calls)).toEqual([
      "GET /service/servers",
      "POST /server/snapshot",
      "GET /service/queue?id=4242",
      "GET /service/queue?id=4242",
    ]);
    expect(posted(calls)).toEqual([{ id: SHOP_ID, revert: "1745411375" }]);
  });

  it("stops waiting after 15 minutes with a plain message", async () => {
    const { api } = setup({
      "GET /service/servers": serverList(server("shop")),
      "POST /server/snapshot": COMMAND,
      "GET /service/queue": queued("running"),
    });
    const error = await failure(api.rebuild("shop", "shop:17"));
    expect(error.message).toBe(
      "Kamatera's command to revert the server shop to the snapshot 17 did not finish within 15 minutes.",
    );
  });

  it("refuses another server's snapshot, or an id OpsCrew didn't give out, before any call", async () => {
    const { api, calls } = setup({});
    const other = await failure(api.rebuild("shop", "shop-worker:17"));
    expect(other.code).toBe("INVALID_INPUT");
    expect(other.message).toBe(
      "The snapshot shop-worker:17 is of the Kamatera server shop-worker, not shop: Kamatera reverts a server only to its own snapshots.",
    );
    expect(other.hint).toBe("`opscrew snapshot list` shows each snapshot with its server.");
    const invalid = await failure(api.rebuild("shop", "17"));
    expect(invalid.code).toBe("INVALID_INPUT");
    expect(calls).toEqual([]);
  });

  it("refuses a server name Kamatera has twice, before any change", async () => {
    const { api, calls } = setup({
      "GET /service/servers": serverList(server("shop"), server("shop", { id: OTHER_ID })),
    });
    const error = await failure(api.rebuild("shop", "shop:17"));
    expect(error.message).toContain("Kamatera has 2 servers named shop");
    expect(requests(calls)).toEqual(["GET /service/servers"]);
  });

  it("offers no reinstall, so a server that fails its first boot is made again as a new one", () => {
    const { api } = setup({});
    expect(api.reinstall).toBeUndefined();
  });
});

describe("a command's log", () => {
  const LOG = `Snapshot created\nPassword ${PASSWORD}\nIP ${ADDRESS}`;

  it("never reaches a result or an error once the command is complete", async () => {
    const { api } = setup({
      "GET /service/servers": serverList(server("shop")),
      "POST /server/snapshot": [COMMAND, { body: [] }],
      "GET /service/queue": queued("complete", LOG),
    });
    const error = await failure(api.snapshotServer("shop", request()));
    for (const value of [PASSWORD, ADDRESS]) expect(errorText(error)).not.toContain(value);
  });

  // The client puts a failed command's log in its error today (client.ts, `#commandFailed`),
  // redacting only the values it knows. This flips to `it` once the client leaves the log out.
  it.fails("never reaches the error of a failed command", async () => {
    const { api } = setup({
      "GET /service/servers": serverList(server("shop")),
      "POST /service/server/poweroff": POWER_COMMAND,
      "GET /service/queue": queued("error", LOG),
    });
    const error = await failure(api.powerOff("shop"));
    for (const value of [PASSWORD, ADDRESS]) expect(errorText(error)).not.toContain(value);
  });
});

describe("server API leaks", () => {
  it("puts no key and no server id in any error or result, even when Kamatera repeats one", async () => {
    const echo = `${CREDENTIALS.clientId} ${CREDENTIALS.secret} ${SHOP_ID} ${WORKER_ID}`;
    const list = serverList(server("shop"), server("shop-worker", { id: WORKER_ID, power: "off" }));
    const errors: OpsCrewError[] = [];
    const results: unknown[] = [];
    for (const reply of [refused(echo), { status: 404, body: { message: echo } }]) {
      const { api } = setup({ "GET /service/servers": list, "POST /": reply });
      errors.push(await failure(api.snapshotServer("shop", request())));
      errors.push(await failure(api.listSnapshots("shop")));
      errors.push(await failure(api.deleteSnapshot("shop:17")));
      errors.push(await failure(api.powerOff("shop")));
      errors.push(await failure(api.powerOn("shop-worker")));
      errors.push(await failure(api.rebuild("shop", "shop:17")));
    }
    // A failed list gives OpsCrew no server id to mask; the key is masked all the same.
    const { api } = setup({
      "GET /service/servers": refused(`${CREDENTIALS.clientId} ${CREDENTIALS.secret}`),
    });
    errors.push(await failure(api.findAppServers("shop")));
    const duplicate = setup({
      "GET /service/servers": serverList(server("shop(1)", { id: OTHER_ID })),
    });
    errors.push(await failure(duplicate.api.findAppServers("shop")));
    const found = setup({
      "GET /service/servers": list,
      "POST /server/snapshot": { body: [snapshot(1, "opscrew-shop-shop-20261120T080000Z")] },
    });
    results.push(await found.api.findAppServers("shop"), await found.api.listSnapshots("shop"));

    for (const error of errors) {
      for (const value of SECRETS) expect(errorText(error)).not.toContain(value);
    }
    const shown = JSON.stringify(results);
    for (const value of SECRETS) expect(shown).not.toContain(value);

    const fixtures = join(import.meta.dirname, "__fixtures__");
    for (const name of await readdir(fixtures)) {
      const text = await readFile(join(fixtures, name), "utf8");
      for (const value of [...Object.values(CREDENTIALS), PASSWORD]) {
        expect(text).not.toContain(value);
      }
    }
  });
});

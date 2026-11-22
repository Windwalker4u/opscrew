import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import type { FakeCall, FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  accessToken,
  CREDENTIALS,
  CREDENTIALS_ENV,
  fakeTime,
  ovhFetch,
  PROJECT,
} from "./__fixtures__/fixtures";
import {
  IMAGE,
  instance,
  OPERATION,
  OTHER,
  operation,
  image as referenceImage,
  SERVER,
  SNAPSHOT,
  snapshot,
  V1,
  V2,
  v1Instance,
  WORKER,
} from "./__fixtures__/servers";
import { OVHCLOUD_API_URL, OvhcloudClient, readOvhcloudCredentials } from "./client";
import { ovhcloudServerApi } from "./servers";

/** Every value OpsCrew must never show: the three credentials and the access token. */
const SECRETS = [...Object.values(CREDENTIALS), accessToken("1")];

function setup(routes: Record<string, FakeReply | FakeReply[]>, fetch?: FetchLike) {
  const fake = ovhFetch(routes);
  const time = fakeTime();
  const redactor = new Redactor();
  // As the connector does: the values are registered when they are read.
  readOvhcloudCredentials(CREDENTIALS_ENV, redactor);
  const client = new OvhcloudClient({
    credentials: CREDENTIALS,
    redactor,
    fetch: fetch ?? fake.fetch,
    sleep: time.sleep,
    now: time.now,
  });
  const api = ovhcloudServerApi(client, { redactor, sleep: time.sleep, now: time.now });
  return { api, calls: fake.calls, time };
}

/** The API's requests (not the sign-in), as `METHOD /path?query`. */
function requests(calls: FakeCall[]): string[] {
  return calls
    .filter((call) => call.url.startsWith(OVHCLOUD_API_URL))
    .map((call) => `${call.method} ${call.path}`);
}

/** The body of the first `POST` to the API (not the sign-in's). */
function postBody(calls: FakeCall[]): unknown {
  return calls.find((call) => call.method === "POST" && call.url.startsWith(OVHCLOUD_API_URL))
    ?.body;
}

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("findAppServers", () => {
  it("returns the instances named exactly app or app-<name>, each nameOnly", async () => {
    const { api, calls } = setup({
      [`GET ${V2}/compute/instance`]: {
        body: [
          instance({ id: SERVER, name: "shop" }),
          instance({ id: WORKER, name: "shop-worker", powerState: "SHUTOFF" }),
          instance({ id: OTHER, name: "shopfront" }),
          instance({ id: OTHER, name: "myshop" }),
          instance({ id: OTHER, name: "SHOP" }),
          instance({ id: OTHER, name: "shop_2" }),
        ],
      },
    });
    expect(await api.findAppServers("shop")).toEqual([
      { id: SERVER, name: "shop", status: "ACTIVE", nameOnly: true },
      { id: WORKER, name: "shop-worker", status: "SHUTOFF", nameOnly: true },
    ]);
    // OVHcloud narrows the list by name (a substring match); OpsCrew matches the names exactly.
    expect(requests(calls)).toEqual([`GET ${V2}/compute/instance?name=shop`]);
  });

  it("reports an instance OVHcloud is still creating by its requested name", async () => {
    const { api } = setup({
      [`GET ${V2}/compute/instance`]: {
        body: [instance({ name: "shop", resourceStatus: "CREATING", powerState: null })],
      },
    });
    expect(await api.findAppServers("shop")).toEqual([
      { id: SERVER, name: "shop", status: "CREATING", nameOnly: true },
    ]);
  });

  it("leaves out an instance OVHcloud is deleting", async () => {
    const { api } = setup({
      [`GET ${V2}/compute/instance`]: {
        body: [
          instance({ id: OTHER, name: "shop", resourceStatus: "DELETING" }),
          instance({ id: WORKER, name: "shop-worker" }),
        ],
      },
    });
    expect(await api.findAppServers("shop")).toEqual([
      { id: WORKER, name: "shop-worker", status: "ACTIVE", nameOnly: true },
    ]);
  });

  it("reports none when the project has no instance of the app", async () => {
    const { api } = setup({ [`GET ${V2}/compute/instance`]: { body: [] } });
    expect(await api.findAppServers("shop")).toEqual([]);
  });
});

describe("snapshots", () => {
  const NAME = `opscrew-shop-${SERVER}-20261121T100000Z`;
  const request = { name: "opscrew-shop-x", description: "d", labels: { app: "shop" } };

  it("snapshots the instance in its region as opscrew-<app>-<server id>-<time>, and waits until it is ready", async () => {
    const { api, calls, time } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance({ region: "DE1" }) },
      [`POST ${V2}/compute/snapshot`]: {
        body: snapshot({ name: NAME, resourceStatus: "CREATING", size: null }),
      },
      [`GET ${V2}/compute/snapshot/${SNAPSHOT}`]: [
        { body: snapshot({ name: NAME, resourceStatus: "CREATING", size: null }) },
        { body: snapshot({ name: NAME }) },
      ],
    });
    expect(await api.snapshotServer(SERVER, request)).toEqual({ snapshotId: SNAPSHOT });
    expect(requests(calls)).toEqual([
      `GET ${V2}/compute/instance/${SERVER}`,
      `POST ${V2}/compute/snapshot`,
      `GET ${V2}/compute/snapshot/${SNAPSHOT}`,
      `GET ${V2}/compute/snapshot/${SNAPSHOT}`,
    ]);
    expect(
      calls.find((call) => call.method === "POST" && call.path.endsWith("/snapshot"))?.body,
    ).toEqual({
      targetSpec: { name: NAME, instance: { id: SERVER }, location: { region: "DE1" } },
    });
    expect(time.waits).toEqual([5000]);
  });

  it("stops plainly when OVHcloud reports the snapshot in error, with its task's words", async () => {
    const { api } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
      [`POST ${V2}/compute/snapshot`]: { body: snapshot({ resourceStatus: "CREATING" }) },
      [`GET ${V2}/compute/snapshot/${SNAPSHOT}`]: {
        body: snapshot({
          resourceStatus: "ERROR",
          tasks: [
            {
              type: "snapshot#create",
              status: "ERROR",
              errors: [{ message: `Quota exceeded for project ${PROJECT}` }],
            },
          ],
        }),
      },
    });
    const error = await failure(api.snapshotServer(SERVER, request));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      `OVHcloud reports the snapshot ${SNAPSHOT} of the instance ${SERVER} in error: Quota exceeded for project [REDACTED:OVH_CLOUD_PROJECT_SERVICE]`,
    );
    expect(error.hint).toContain("control panel");
  });

  it("gives up waiting after the request's timeout, plainly, and takes no second snapshot", async () => {
    const { api, calls, time } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
      [`POST ${V2}/compute/snapshot`]: { body: snapshot({ resourceStatus: "CREATING" }) },
      [`GET ${V2}/compute/snapshot/${SNAPSHOT}`]: {
        body: snapshot({ resourceStatus: "CREATING" }),
      },
    });
    const error = await failure(api.snapshotServer(SERVER, { ...request, timeoutMs: 12_000 }));
    expect(error.message).toBe(
      `OVHcloud did not finish the snapshot ${NAME} of the instance ${SERVER} within 12 seconds: it is CREATING.`,
    );
    expect(error.hint).toContain("before taking another one");
    expect(time.waits).toEqual([5000, 5000, 2000]);
    expect(requests(calls).filter((r) => r.startsWith("POST"))).toHaveLength(1);
  });

  it("waits 15 minutes by default", async () => {
    const { api, time } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
      [`POST ${V2}/compute/snapshot`]: { body: snapshot({ resourceStatus: "CREATING" }) },
      [`GET ${V2}/compute/snapshot/${SNAPSHOT}`]: {
        body: snapshot({ resourceStatus: "CREATING" }),
      },
    });
    const error = await failure(api.snapshotServer(SERVER, request));
    expect(error.message).toContain("within 15 minutes");
    expect(time.waits.reduce((a, b) => a + b, 0)).toBe(15 * 60_000);
  });

  it("refuses a request that names no app before calling OVHcloud", async () => {
    const { api, calls } = setup({});
    const error = await failure(api.snapshotServer(SERVER, { ...request, labels: {} }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(requests(calls)).toEqual([]);
  });

  it("lists the instance's snapshots OpsCrew took, oldest first, with their sizes where known", async () => {
    const { api, calls } = setup({
      [`GET ${V2}/compute/snapshot`]: {
        body: [
          snapshot({
            id: "11111111-1111-4111-8111-111111111111",
            name: `opscrew-shop-${SERVER}-20261121T120000Z`,
            createdAt: "2026-11-21T12:00:00Z",
            resourceStatus: "CREATING",
            size: null,
          }),
          snapshot({
            id: "22222222-2222-4222-8222-222222222222",
            name: `opscrew-shop-${SERVER}-20261120T080000Z`,
            createdAt: "2026-11-20T08:00:00Z",
            size: 2.5 * 1024 ** 3,
          }),
          snapshot({ id: OTHER, name: "before-upgrade", createdAt: "2026-11-19T08:00:00Z" }),
          snapshot({
            id: WORKER,
            name: `opscrew-shop-${OTHER}-20261119T080000Z`,
            createdAt: "2026-11-19T08:00:00Z",
          }),
          // Being deleted: gone in a moment, so not one of the instance's snapshots any more.
          snapshot({
            id: "33333333-3333-4333-8333-333333333333",
            name: `opscrew-shop-${SERVER}-20261118T080000Z`,
            createdAt: "2026-11-18T08:00:00Z",
            resourceStatus: "DELETING",
          }),
        ],
      },
    });
    expect(await api.listSnapshots(SERVER)).toEqual([
      {
        id: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-11-20T08:00:00Z",
        sizeGb: 2.5,
      },
      { id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-11-21T12:00:00Z" },
    ]);
    expect(requests(calls)).toEqual([`GET ${V2}/compute/snapshot?instanceId=${SERVER}`]);
  });

  it("deletes a snapshot and waits until OVHcloud no longer has it", async () => {
    const gone = {
      status: 404,
      body: { class: "Client::NotFound::InstanceSnapshotDoesNotExist", message: "not found" },
    };
    const { api, calls, time } = setup({
      [`DELETE ${V2}/compute/snapshot/${SNAPSHOT}`]: {
        body: snapshot({ resourceStatus: "DELETING" }),
      },
      [`GET ${V2}/compute/snapshot/${SNAPSHOT}`]: [
        { body: snapshot({ resourceStatus: "DELETING" }) },
        gone,
      ],
    });
    await api.deleteSnapshot(SNAPSHOT);
    expect(requests(calls)).toEqual([
      `DELETE ${V2}/compute/snapshot/${SNAPSHOT}`,
      `GET ${V2}/compute/snapshot/${SNAPSHOT}`,
      `GET ${V2}/compute/snapshot/${SNAPSHOT}`,
    ]);
    expect(time.waits).toEqual([5000]);
  });

  it("gives up waiting for a deletion after 15 minutes, plainly", async () => {
    const { api } = setup({
      [`DELETE ${V2}/compute/snapshot/${SNAPSHOT}`]: { body: snapshot() },
      [`GET ${V2}/compute/snapshot/${SNAPSHOT}`]: {
        body: snapshot({ resourceStatus: "DELETING" }),
      },
    });
    const error = await failure(api.deleteSnapshot(SNAPSHOT));
    expect(error.message).toBe(
      `OVHcloud did not finish deleting the snapshot ${SNAPSHOT} within 15 minutes: it is DELETING.`,
    );
    expect(error.hint).toContain("control panel");
  });

  it("passes on OVHcloud's 404 when the snapshot to delete is already gone", async () => {
    const { api } = setup({
      [`DELETE ${V2}/compute/snapshot/${SNAPSHOT}`]: {
        status: 404,
        body: { class: "Client::NotFound::InstanceSnapshotDoesNotExist", message: "not found" },
      },
    });
    const error = await failure(api.deleteSnapshot(SNAPSHOT));
    expect(error.message).toContain("not found");
  });
});

describe("rebuild and power", () => {
  const reinstall = `${V1}/region/GRA11/instance/${SERVER}/reinstall`;

  it("rebuilds the instance from the snapshot and waits until OVHcloud finished and it is active", async () => {
    const { api, calls, time } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
      [`POST ${reinstall}`]: { body: operation() },
      [`GET ${V1}/operation/${OPERATION}`]: [
        { body: operation({ status: "in-progress" }) },
        { body: operation({ status: "completed" }) },
      ],
      [`GET ${V1}/instance/${SERVER}`]: [
        { body: v1Instance({ status: "REBUILD" }) },
        { body: v1Instance({ status: "ACTIVE" }) },
      ],
    });
    await api.rebuild(SERVER, SNAPSHOT);
    expect(requests(calls)).toEqual([
      `GET ${V2}/compute/instance/${SERVER}`,
      `POST ${reinstall}`,
      `GET ${V1}/operation/${OPERATION}`,
      `GET ${V1}/operation/${OPERATION}`,
      `GET ${V1}/instance/${SERVER}`,
      `GET ${V1}/instance/${SERVER}`,
    ]);
    expect(postBody(calls)).toEqual({
      imageId: SNAPSHOT,
      imageRegionName: "GRA11",
    });
    expect(time.waits).toEqual([5000, 5000]);
  });

  it.each(["in-error", "canceled"])(
    "stops plainly when OVHcloud's rebuild ends %s",
    async (status) => {
      const { api } = setup({
        [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
        [`POST ${reinstall}`]: { body: operation() },
        [`GET ${V1}/operation/${OPERATION}`]: { body: operation({ status }) },
      });
      const error = await failure(api.rebuild(SERVER, SNAPSHOT));
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toBe(
        `OVHcloud could not rebuild the instance ${SERVER} from the snapshot ${SNAPSHOT}: its operation ended ${status}.`,
      );
      expect(error.hint).toContain("control panel");
    },
  );

  it("stops plainly when the rebuilt instance is in error", async () => {
    const { api } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
      [`POST ${reinstall}`]: { body: operation() },
      [`GET ${V1}/operation/${OPERATION}`]: { body: operation({ status: "completed" }) },
      [`GET ${V1}/instance/${SERVER}`]: { body: v1Instance({ status: "ERROR" }) },
    });
    const error = await failure(api.rebuild(SERVER, SNAPSHOT));
    expect(error.message).toBe(
      `OVHcloud reports the instance ${SERVER} in error after rebuilding it from the snapshot ${SNAPSHOT}.`,
    );
  });

  it("gives up waiting for OVHcloud's rebuild after 15 minutes, plainly", async () => {
    const { api, time } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
      [`POST ${reinstall}`]: { body: operation() },
      [`GET ${V1}/operation/${OPERATION}`]: { body: operation({ status: "in-progress" }) },
    });
    const error = await failure(api.rebuild(SERVER, SNAPSHOT));
    expect(error.message).toBe(
      `OVHcloud did not finish rebuilding the instance ${SERVER} from the snapshot ${SNAPSHOT} within 15 minutes: its operation is in-progress.`,
    );
    expect(error.hint).toContain("control panel");
    expect(time.waits.reduce((a, b) => a + b, 0)).toBe(15 * 60_000);
  });

  it("waits 15 minutes in all, the operation and the instance together", async () => {
    const { api, time } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
      [`POST ${reinstall}`]: { body: operation() },
      [`GET ${V1}/operation/${OPERATION}`]: [
        ...Array.from({ length: 120 }, () => ({ body: operation({ status: "in-progress" }) })),
        { body: operation({ status: "completed" }) },
      ],
      [`GET ${V1}/instance/${SERVER}`]: { body: v1Instance({ status: "REBUILD" }) },
    });
    const error = await failure(api.rebuild(SERVER, SNAPSHOT));
    expect(error.message).toBe(
      `OVHcloud did not finish rebuilding the instance ${SERVER} from the snapshot ${SNAPSHOT} within 15 minutes: it is REBUILD.`,
    );
    expect(time.waits.reduce((a, b) => a + b, 0)).toBe(15 * 60_000);
  });

  it("shuts the instance down with a stop and waits until it is SHUTOFF, never forcing it", async () => {
    const { api, calls, time } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: [
        { body: instance() },
        {
          body: instance({
            resourceStatus: "UPDATING",
            tasks: [{ type: "instance#stop", status: "RUNNING" }],
          }),
        },
        { body: instance({ powerState: "SHUTOFF" }) },
      ],
      [`POST ${V2}/compute/instance/${SERVER}/action`]: {
        body: instance({ resourceStatus: "UPDATING" }),
      },
    });
    await api.powerOff(SERVER);
    expect(requests(calls)).toEqual([
      `GET ${V2}/compute/instance/${SERVER}`,
      `POST ${V2}/compute/instance/${SERVER}/action`,
      `GET ${V2}/compute/instance/${SERVER}`,
      `GET ${V2}/compute/instance/${SERVER}`,
    ]);
    expect(postBody(calls)).toEqual({ type: "STOP" });
    expect(time.waits).toEqual([5000]);
  });

  it("waits until the stop's task is done, even once the instance reads SHUTOFF", async () => {
    const { api, time } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: [
        { body: instance() },
        {
          body: instance({
            powerState: "SHUTOFF",
            resourceStatus: "UPDATING",
            tasks: [{ type: "instance#stop", status: "RUNNING" }],
          }),
        },
        { body: instance({ powerState: "SHUTOFF" }) },
      ],
      [`POST ${V2}/compute/instance/${SERVER}/action`]: { body: instance() },
    });
    await api.powerOff(SERVER);
    expect(time.waits).toEqual([5000]);
  });

  it("sends nothing to an instance already off", async () => {
    const { api, calls } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance({ powerState: "SHUTOFF" }) },
    });
    await api.powerOff(SERVER);
    expect(requests(calls)).toEqual([`GET ${V2}/compute/instance/${SERVER}`]);
  });

  it("gives up waiting for the shutdown after 5 minutes, plainly", async () => {
    const { api, calls, time } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
      [`POST ${V2}/compute/instance/${SERVER}/action`]: { body: instance() },
    });
    const error = await failure(api.powerOff(SERVER));
    expect(error.message).toBe(
      `The OVHcloud instance ${SERVER} was not shut down within 5 minutes: it is ACTIVE.`,
    );
    expect(error.hint).toContain("control panel");
    expect(time.waits.reduce((a, b) => a + b, 0)).toBe(5 * 60_000);
    expect(requests(calls).filter((r) => r.startsWith("POST"))).toHaveLength(1);
  });

  it("stops plainly when OVHcloud reports the instance in error while it waits", async () => {
    const { api } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: [
        { body: instance() },
        {
          body: instance({
            resourceStatus: "ERROR",
            tasks: [{ type: "instance#stop", status: "ERROR", errors: [{ message: "stuck" }] }],
          }),
        },
      ],
      [`POST ${V2}/compute/instance/${SERVER}/action`]: { body: instance() },
    });
    const error = await failure(api.powerOff(SERVER));
    expect(error.message).toBe(`OVHcloud reports the instance ${SERVER} in error: stuck`);
  });

  it("starts the instance and waits until it is ACTIVE", async () => {
    const { api, calls, time } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: [
        { body: instance({ powerState: "SHUTOFF" }) },
        { body: instance({ powerState: "SHUTOFF", resourceStatus: "UPDATING" }) },
        { body: instance() },
      ],
      [`POST ${V2}/compute/instance/${SERVER}/action`]: { body: instance() },
    });
    await api.powerOn(SERVER);
    expect(postBody(calls)).toEqual({ type: "START" });
    expect(time.waits).toEqual([5000]);
  });

  it("sends nothing to an instance already on", async () => {
    const { api, calls } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
    });
    await api.powerOn(SERVER);
    expect(requests(calls)).toEqual([`GET ${V2}/compute/instance/${SERVER}`]);
  });

  it("gives up waiting for the start after 15 minutes, plainly", async () => {
    const { api } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance({ powerState: "SHUTOFF" }) },
      [`POST ${V2}/compute/instance/${SERVER}/action`]: { body: instance() },
    });
    const error = await failure(api.powerOn(SERVER));
    expect(error.message).toBe(
      `The OVHcloud instance ${SERVER} was not started within 15 minutes: it is SHUTOFF.`,
    );
  });
});

describe("restart and reinstall", () => {
  it("restarts the instance with a soft reboot", async () => {
    const { api, calls } = setup({
      [`POST ${V2}/compute/instance/${SERVER}/action`]: { body: instance() },
    });
    await api.restart?.(SERVER);
    expect(requests(calls)).toEqual([`POST ${V2}/compute/instance/${SERVER}/action`]);
    expect(calls.at(-1)?.body).toEqual({ type: "REBOOT", parameters: { hard: false } });
  });

  it("installs the instance again from the region's active image of that name", async () => {
    const reinstall = `${V1}/region/SBG5/instance/${SERVER}/reinstall`;
    const { api, calls } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance({ region: "SBG5" }) },
      [`GET ${V2}/reference/instance/image`]: {
        body: [
          referenceImage({ id: OTHER, name: "Ubuntu 22.04" }),
          referenceImage({ id: WORKER, name: "Ubuntu 24.04", status: "DEACTIVATED" }),
          referenceImage({ id: IMAGE, name: "Ubuntu 24.04" }),
        ],
      },
      [`POST ${reinstall}`]: { body: operation() },
    });
    await api.reinstall?.(SERVER, { image: "Ubuntu 24.04", userData: "#cloud-config\n" });
    expect(requests(calls)).toEqual([
      `GET ${V2}/compute/instance/${SERVER}`,
      `GET ${V2}/reference/instance/image?region=SBG5`,
      `POST ${reinstall}`,
    ]);
    expect(calls.at(-1)?.body).toEqual({ imageId: IMAGE, imageRegionName: "SBG5" });
  });

  it.each([
    [0, []],
    [2, [IMAGE, OTHER]],
  ])("refuses to guess with %i active images of that name", async (count, ids) => {
    const { api, calls } = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: { body: instance() },
      [`GET ${V2}/reference/instance/image`]: {
        body: ids.map((id) => referenceImage({ id, name: "Ubuntu 24.04" })),
      },
    });
    const error = await failure(
      api.reinstall?.(SERVER, { image: "Ubuntu 24.04", userData: "" }) ?? Promise.resolve(),
    );
    expect(error.message).toBe(
      `OVHcloud has ${count} active images named Ubuntu 24.04 in GRA11, so OpsCrew did not install the instance ${SERVER} again.`,
    );
    expect(requests(calls).filter((r) => r.startsWith("POST"))).toEqual([]);
  });
});

describe("ids", () => {
  it.each<[string, (api: ReturnType<typeof setup>["api"]) => Promise<unknown>]>([
    ["powerOff", (api) => api.powerOff("../../me")],
    ["powerOn", (api) => api.powerOn("42")],
    ["listSnapshots", (api) => api.listSnapshots("shop")],
    ["deleteSnapshot", (api) => api.deleteSnapshot(`${SNAPSHOT}/../x`)],
    ["rebuild", (api) => api.rebuild(SERVER, "latest")],
  ])("%s refuses an id that isn't OVHcloud's before calling it", async (_, call) => {
    const { api, calls } = setup({});
    const error = await failure(call(api));
    expect(error.code).toBe("INVALID_INPUT");
    expect(requests(calls)).toEqual([]);
  });
});

describe("leaks", () => {
  it("puts no credential, project id or token in any result or error", async () => {
    const echo = `${CREDENTIALS.clientId} ${CREDENTIALS.clientSecret} ${accessToken("1")} ${PROJECT}`;
    const inError = {
      resourceStatus: "ERROR",
      tasks: [{ type: "x", status: "ERROR", errors: [{ message: echo }] }],
    };
    const results: unknown[] = [];
    const errors: OpsCrewError[] = [];

    const listed = setup({
      [`GET ${V2}/compute/instance`]: { body: [instance()] },
      [`GET ${V2}/compute/snapshot`]: { body: [snapshot()] },
    });
    results.push(await listed.api.findAppServers("shop"), await listed.api.listSnapshots(SERVER));

    const failing = setup({
      [`GET ${V2}/compute/instance/${SERVER}`]: [{ body: instance() }, { body: instance(inError) }],
      [`POST ${V2}/compute/instance/${SERVER}/action`]: { body: instance() },
      [`POST ${V2}/compute/snapshot`]: { body: snapshot() },
      [`GET ${V2}/compute/snapshot/${SNAPSHOT}`]: { body: snapshot(inError) },
      [`GET ${V2}/reference/instance/image`]: { body: [] },
      [`POST ${V1}/`]: { status: 403, body: { message: `denied on ${PROJECT}` } },
    });
    errors.push(
      await failure(failing.api.powerOff(SERVER)),
      await failure(
        failing.api.snapshotServer(SERVER, {
          name: "n",
          description: "d",
          labels: { app: "shop" },
        }),
      ),
      await failure(
        failing.api.reinstall?.(SERVER, { image: echo, userData: "" }) ?? Promise.resolve(),
      ),
      await failure(failing.api.rebuild(SERVER, SNAPSHOT)),
    );

    const text = JSON.stringify(results) + errors.map((e) => `${e.message} ${e.hint}`).join(" ");
    expect(errors).toHaveLength(4);
    for (const value of SECRETS) expect(text).not.toContain(value);
  });
});

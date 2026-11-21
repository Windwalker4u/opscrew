import type {
  AppServer,
  ProviderRedactor,
  ServerSnapshot,
  ServerSnapshotApi,
  SnapshotRequest,
} from "@opscrew/contracts";
import { durationText, type ErrorCode, OpsCrewError, pollAction } from "@opscrew/core";
import { z } from "zod";
import { type OvhcloudClient, OvhcloudStatusError } from "./client";

/** How long a snapshot may take when the request sets no limit. */
const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;
/** How long a snapshot's deletion, a rebuild or a start may take. */
const ACTION_TIMEOUT_MS = 15 * 60_000;
/** How long a shutdown may take before OpsCrew stops waiting. */
const SHUTDOWN_TIMEOUT_MS = 5 * 60_000;
/** How often a wait reads OVHcloud's state again. */
const POLL_INTERVAL_MS = 5_000;
/** How the names of the snapshots OpsCrew takes start: `opscrew-<app>-<server id>-<time>`. */
const SNAPSHOT_PREFIX = "opscrew-";
/** OVHcloud's instance and snapshot ids are UUIDs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSTANCE_HINT =
  "Check the instance in your Public Cloud project in the control panel, then try again.";
const SNAPSHOT_HINT =
  "It may still finish: check the instance's snapshots in your Public Cloud project in the control panel before taking another one, since each one is billed per GB a month.";
const REBUILD_HINT =
  "Check the instance in your Public Cloud project in the control panel: its disk may already have been replaced.";

// --- Answer schemas: the fields OpsCrew reads (v2: eu.api.ovh.com/v2/publicCloud.json, v1:
// eu.api.ovh.com/v1/cloud.json). Statuses stay strings, so a new value is shown, not refused.

/** `common.CurrentTask`: an operation still running on a resource, with its errors. */
const taskSchema = z.looseObject({
  errors: z.array(z.looseObject({ message: z.string() })).nullish(),
});

/** `publicCloud.instance.Instance` (v2). */
const instanceSchema = z.looseObject({
  id: z.string(),
  /** `CREATING`, `READY`, `UPDATING`, `DELETING`, `ERROR`, `OUT_OF_SYNC`, … */
  resourceStatus: z.string(),
  currentTasks: z.array(taskSchema).nullish(),
  /** What was asked for: its name is there from the create on. */
  targetSpec: z.looseObject({
    name: z.string(),
    location: z.looseObject({ region: z.string() }),
  }),
  /** What OpenStack reports; null while OVHcloud is still creating the instance. */
  currentState: z.looseObject({ powerState: z.string() }).nullish(),
});
type Instance = z.infer<typeof instanceSchema>;

/** `publicCloud.instance.Snapshot` (v2). */
const snapshotSchema = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  resourceStatus: z.string(),
  currentTasks: z.array(taskSchema).nullish(),
  targetSpec: z.looseObject({ name: z.string() }),
  /** `size` in bytes, null while OVHcloud doesn't know it. */
  currentState: z.looseObject({ size: z.number().nullish() }).nullish(),
});
type Snapshot = z.infer<typeof snapshotSchema>;

/** `publicCloud.reference.instance.Image` (v2). */
const imageSchema = z.looseObject({ id: z.string(), name: z.string(), status: z.string() });

/** `cloud.Operation` (v1): `created`, `in-progress`, `completed`, `in-error`, `canceled`, … */
const operationSchema = z.looseObject({ id: z.string(), status: z.string() });

/** `cloud.instance.Instance` (v1): OpenStack's status (`REBUILD`, `ACTIVE`, `ERROR`, …). */
const v1InstanceSchema = z.looseObject({ status: z.string() });

export interface OvhcloudServerApiOptions {
  /** Masks the credentials in what OVHcloud's tasks report. */
  redactor: ProviderRedactor;
  sleep: (ms: number) => Promise<void>;
  /** Epoch milliseconds. */
  now: () => number;
}

/**
 * Server lookup by name (OVHcloud's instances carry no tags), and snapshots, rebuilds and power
 * actions for the provider-neutral teardown and snapshot commands, in the Public Cloud project of
 * `client`. Every wait reads OVHcloud's state every 5 seconds with the injected clock and sleep,
 * and stops plainly at its limit.
 */
export function ovhcloudServerApi(
  client: OvhcloudClient,
  options: OvhcloudServerApiOptions,
): ServerSnapshotApi {
  const { redactor, sleep, now } = options;
  const v1 = client.projectPath("v1");
  const v2 = client.projectPath("v2");

  const fail = (message: string, hint: string, code: ErrorCode = "PROVIDER_ERROR") =>
    new OpsCrewError(code, redactor.redact(message), { hint: redactor.redact(hint) });

  const poll = <T>(wait: {
    read(): Promise<T>;
    finished(state: T): boolean;
    timedOut(state: T): Error;
    timeoutMs: number;
  }) => pollAction({ ...wait, intervalMs: POLL_INTERVAL_MS, sleep, now });

  /** Throws OVHcloud's words when it reports `resource` (named `what`) in error. */
  const throwIfError = (
    resource: Pick<Instance | Snapshot, "resourceStatus" | "currentTasks">,
    what: string,
    hint: string,
  ) => {
    if (resource.resourceStatus !== "ERROR") return;
    const words = (resource.currentTasks ?? []).flatMap((task) => task.errors ?? []);
    const detail = words.length > 0 ? `: ${words.map((e) => e.message).join("; ")}` : ".";
    throw fail(`OVHcloud reports ${what} in error${detail}`, hint);
  };

  const getInstance = (id: string) => client.get(`${v2}/compute/instance/${id}`, instanceSchema);

  const getSnapshot = (id: string) =>
    client.get(`${v2}/compute/snapshot/${encodeURIComponent(id)}`, snapshotSchema);

  /** An imperative action of the v2 API (`STOP`, `START`, `REBOOT`); its answer is not kept. */
  const runAction = (id: string, action: { type: string; parameters?: { hard: boolean } }) =>
    client.post(`${v2}/compute/instance/${id}/action`, z.unknown(), action);

  /**
   * Installs the instance again from the image `imageId` in its `region` (an OpenStack rebuild:
   * the instance keeps its id and addresses, and the user data it was created with, as OpenStack
   * keeps it when given none) and answers with OVHcloud's operation. The v1 API, because the v2
   * API rebuilds only when the image or the user data differ from what it already has.
   */
  const reinstallFrom = (id: string, region: string, imageId: string) =>
    client.post(
      `${v1}/region/${encodeURIComponent(region)}/instance/${id}/reinstall`,
      operationSchema,
      { imageId, imageRegionName: region },
    );

  /** Waits until the instance is `powerState` with no task running on it. */
  const waitForPower = (id: string, powerState: string, timeoutMs: number, done: string) =>
    poll({
      read: () => getInstance(id),
      finished: (instance) => {
        throwIfError(instance, `the instance ${id}`, INSTANCE_HINT);
        return isPower(instance, powerState);
      },
      timedOut: (instance) =>
        fail(
          `The OVHcloud instance ${id} was not ${done} within ${durationText(timeoutMs)}: it is ${statusOf(instance)}.`,
          INSTANCE_HINT,
        ),
      timeoutMs,
    });

  return {
    /**
     * The project's instances named `<app>` or `<app>-<name>`, every one `nameOnly`: OVHcloud's
     * instances have no tags, so the generic takeover adopts one only after OpsCrew's own apply
     * stopped while creating it. An instance OVHcloud is still creating is reported by the name
     * its create asked for; one it is deleting is left out.
     */
    async findAppServers(app: string): Promise<AppServer[]> {
      // OVHcloud's `name` filter matches any part of the name, in any case.
      const instances = await client.get(`${v2}/compute/instance`, z.array(instanceSchema), {
        name: app,
      });
      return instances
        .filter(
          ({ resourceStatus, targetSpec: { name } }) =>
            // One OVHcloud is deleting is no longer the app's (v2 has no `DELETED`).
            resourceStatus !== "DELETING" && (name === app || name.startsWith(`${app}-`)),
        )
        .map((instance) => ({
          id: instance.id,
          name: instance.targetSpec.name,
          status: statusOf(instance),
          nameOnly: true,
        }));
    },

    /**
     * Snapshots the instance in its region as `opscrew-<app>-<server id>-<time>` (the app from
     * `request.labels.app`, the time from the injected clock) and waits until OVHcloud reports it
     * ready.
     */
    async snapshotServer(
      serverId: string,
      request: SnapshotRequest,
    ): Promise<{ snapshotId: string }> {
      const id = instanceId(serverId);
      const app = request.labels.app;
      if (app === undefined) {
        throw fail(
          `OpsCrew names an OVHcloud snapshot after its app, and the snapshot of the instance ${id} names none.`,
          "Please report this to OpsCrew.",
          "INVALID_INPUT",
        );
      }
      const { region } = (await getInstance(id)).targetSpec.location;
      const name = `${SNAPSHOT_PREFIX}${app}-${id}-${timeStamp(now())}`;
      const created = await client.post(`${v2}/compute/snapshot`, snapshotSchema, {
        targetSpec: { name, instance: { id }, location: { region } },
      });
      const timeoutMs = request.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
      await poll({
        read: () => getSnapshot(created.id),
        finished: (snapshot) => {
          throwIfError(
            snapshot,
            `the snapshot ${created.id} of the instance ${id}`,
            "Check the snapshot in your Public Cloud project in the control panel, and delete it there if it stays in error: snapshots are billed per GB a month.",
          );
          return snapshot.resourceStatus === "READY";
        },
        timedOut: (snapshot) =>
          fail(
            `OVHcloud did not finish the snapshot ${name} of the instance ${id} within ${durationText(timeoutMs)}: it is ${snapshot.resourceStatus}.`,
            SNAPSHOT_HINT,
          ),
        timeoutMs,
      });
      return { snapshotId: created.id };
    },

    /**
     * The instance's snapshots named `opscrew-<app>-<its id>-<time>`, oldest first, but those
     * OVHcloud is deleting.
     */
    async listSnapshots(serverId: string): Promise<ServerSnapshot[]> {
      const id = instanceId(serverId);
      const snapshots = await client.get(`${v2}/compute/snapshot`, z.array(snapshotSchema), {
        instanceId: id,
      });
      return snapshots
        .filter(
          ({ resourceStatus, targetSpec: { name } }) =>
            resourceStatus !== "DELETING" &&
            name.startsWith(SNAPSHOT_PREFIX) &&
            name.includes(`-${id}-`),
        )
        .map((snapshot) => {
          const size = snapshot.currentState?.size;
          // OVHcloud gives bytes; the size is known once the snapshot is ready.
          return {
            id: snapshot.id,
            createdAt: snapshot.createdAt,
            ...(snapshot.resourceStatus === "READY" && typeof size === "number"
              ? { sizeGb: size / 1024 ** 3 }
              : {}),
          };
        })
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },

    /** Deletes the snapshot and waits until OVHcloud answers 404 for it. */
    async deleteSnapshot(snapshotId: string): Promise<void> {
      const id = snapshotRef(snapshotId);
      await client.delete(`${v2}/compute/snapshot/${id}`, z.unknown());
      await poll({
        read: () =>
          getSnapshot(id).catch((error: unknown) => {
            if (error instanceof OvhcloudStatusError && error.status === 404) return undefined;
            throw error;
          }),
        finished: (snapshot) => {
          if (snapshot === undefined) return true;
          throwIfError(
            snapshot,
            `the snapshot ${id}`,
            "Check the snapshot in your Public Cloud project in the control panel, and delete it there.",
          );
          return false;
        },
        timedOut: (snapshot) =>
          fail(
            `OVHcloud did not finish deleting the snapshot ${id} within ${durationText(ACTION_TIMEOUT_MS)}: it is ${snapshot?.resourceStatus ?? "gone"}.`,
            "Check the snapshot in your Public Cloud project in the control panel: it is billed until it is gone.",
          ),
        timeoutMs: ACTION_TIMEOUT_MS,
      });
    },

    /**
     * Installs the instance again from the snapshot, in place, and waits until OVHcloud's operation
     * is completed and the instance is `ACTIVE` again, 15 minutes in all.
     */
    async rebuild(serverId: string, snapshotId: string): Promise<void> {
      const id = instanceId(serverId);
      const image = snapshotRef(snapshotId);
      const { region } = (await getInstance(id)).targetSpec.location;
      const deadline = now() + ACTION_TIMEOUT_MS;
      const operation = await reinstallFrom(id, region, image);
      const what = `rebuilding the instance ${id} from the snapshot ${image}`;
      const within = durationText(ACTION_TIMEOUT_MS);
      await poll({
        read: () =>
          client.get(`${v1}/operation/${encodeURIComponent(operation.id)}`, operationSchema),
        finished: ({ status }) => {
          if (status === "in-error" || status === "canceled") {
            throw fail(
              `OVHcloud could not rebuild the instance ${id} from the snapshot ${image}: its operation ended ${status}.`,
              REBUILD_HINT,
            );
          }
          return status === "completed";
        },
        timedOut: ({ status }) =>
          fail(
            `OVHcloud did not finish ${what} within ${within}: its operation is ${status}.`,
            REBUILD_HINT,
          ),
        timeoutMs: deadline - now(),
      });
      await poll({
        read: () => client.get(`${v1}/instance/${id}`, v1InstanceSchema),
        finished: ({ status }) => {
          if (status === "ERROR") {
            throw fail(
              `OVHcloud reports the instance ${id} in error after rebuilding it from the snapshot ${image}.`,
              REBUILD_HINT,
            );
          }
          return status === "ACTIVE";
        },
        timedOut: ({ status }) =>
          fail(`OVHcloud did not finish ${what} within ${within}: it is ${status}.`, REBUILD_HINT),
        timeoutMs: deadline - now(),
      });
    },

    /**
     * Stops the instance and waits until it is `SHUTOFF`. OVHcloud's `STOP` is OpenStack's stop,
     * which asks the system to shut down; OpsCrew sends no forced power-off.
     */
    async powerOff(serverId: string): Promise<void> {
      const id = instanceId(serverId);
      // Already off (a destroy run again after a shutdown): OVHcloud would refuse the stop.
      if (isPower(await getInstance(id), "SHUTOFF")) return;
      await runAction(id, { type: "STOP" });
      await waitForPower(id, "SHUTOFF", SHUTDOWN_TIMEOUT_MS, "shut down");
    },

    /** Starts the instance and waits until it is `ACTIVE`. */
    async powerOn(serverId: string): Promise<void> {
      const id = instanceId(serverId);
      // Already on (its shutdown never happened): OVHcloud would refuse the start.
      if (isPower(await getInstance(id), "ACTIVE")) return;
      await runAction(id, { type: "START" });
      await waitForPower(id, "ACTIVE", ACTION_TIMEOUT_MS, "started");
    },

    /** A soft reboot; resolves once OVHcloud took it (the caller waits for the server). */
    async restart(serverId: string): Promise<void> {
      await runAction(instanceId(serverId), { type: "REBOOT", parameters: { hard: false } });
    },

    /**
     * Installs the instance again from the active image named `request.image` in its region;
     * resolves once OVHcloud took it (the caller waits for the server). OVHcloud keeps the
     * first-boot user data the instance was created with: its reinstall takes only an image.
     */
    async reinstall(serverId: string, request: { image: string }): Promise<void> {
      const id = instanceId(serverId);
      const { region } = (await getInstance(id)).targetSpec.location;
      const images = await client.get(`${v2}/reference/instance/image`, z.array(imageSchema), {
        region,
      });
      const named = images.filter((i) => i.name === request.image && i.status === "ACTIVE");
      const [image] = named;
      if (image === undefined || named.length > 1) {
        throw fail(
          `OVHcloud has ${named.length} active images named ${request.image} in ${region}, so OpsCrew did not install the instance ${id} again.`,
          `Check the images your Public Cloud project offers in ${region} in the control panel.`,
        );
      }
      await reinstallFrom(id, region, image.id);
    },
  };
}

/** True when the instance is `powerState` with no task running on it. */
function isPower(instance: Instance, powerState: string): boolean {
  return instance.currentState?.powerState === powerState && !instance.currentTasks?.length;
}

/** The instance's power state once OVHcloud has it ready, else where it is (`CREATING`, …). */
function statusOf(instance: Instance): string {
  return instance.resourceStatus === "READY"
    ? (instance.currentState?.powerState ?? instance.resourceStatus)
    : instance.resourceStatus;
}

/** `20261121T100000Z`: the time a snapshot's name ends with. */
function timeStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");
}

/** `value` as an OVHcloud instance id; anything else is refused before calling the API. */
function instanceId(value: string): string {
  if (!UUID.test(value)) {
    throw new OpsCrewError("INVALID_INPUT", `"${value}" is not an OVHcloud instance id.`, {
      hint: "Use the instance's id shown in your Public Cloud project in the control panel.",
    });
  }
  return value;
}

/** `value` as an OVHcloud snapshot id; anything else is refused before calling the API. */
function snapshotRef(value: string): string {
  if (!UUID.test(value)) {
    throw new OpsCrewError("INVALID_INPUT", `"${value}" is not an OVHcloud snapshot id.`, {
      hint: "`opscrew snapshot list` shows each snapshot's id.",
    });
  }
  return value;
}

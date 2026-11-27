import type {
  AppServer,
  ProviderRedactor,
  ServerSnapshot,
  ServerSnapshotApi,
  SnapshotRequest,
} from "@opscrew/contracts";
import { type ErrorCode, escapeRegExp, listText, OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { KamateraClient } from "./client";

/** How long a snapshot may take when the request sets no limit (the contract's default). */
const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;
/**
 * How long a snapshot's deletion or revert, a start or a restart may take. Kamatera runs each as a command in
 * the account's task queue, where it can wait behind others; its Terraform provider allows 40
 * minutes for any command, which its creates need. One of these still running after 15 minutes is
 * stuck, and the message says it may still finish.
 */
const ACTION_TIMEOUT_MS = 15 * 60_000;
/** How long a shutdown may take: OpsCrew never forces one, so a system that ignores it fails plainly. */
const SHUTDOWN_TIMEOUT_MS = 5 * 60_000;
/** How the names of the snapshots OpsCrew takes start: `opscrew-<app>-<server>-<time>`. */
const SNAPSHOT_PREFIX = "opscrew-";
/** The time a snapshot's name ends with: `20261126T100000Z`. */
const TAKEN_AT = "(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z";
/** The redactor's label for a server's id, which OpsCrew sends and never shows. */
const SERVER_ID_LABEL = "kamatera-server-id";

const CONSOLE = "your Kamatera account's console";

/**
 * One server of `GET /service/servers` (the CLI schema's `server list`; the example in Kamatera's
 * console API documentation): its id (a UUID), name, datacenter code and power (`on` or `off`).
 */
const serverSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  datacenter: z.string(),
  power: z.string(),
});

/** A server of the account. Its `id` is registered with the redactor: OpsCrew never shows it. */
export type KamateraServer = z.infer<typeof serverSchema>;

/**
 * One snapshot of `POST /server/snapshot` without `create` or `delete`: the console's
 * `GET /service/server/<id>/snapshots`, whose tree the CLI API flattens (its `child` fields). The
 * console API documentation gives `id` as a number; its `date` (`01/01/2025 15:29:35`) names no
 * order of day and month, so OpsCrew reads the time from the snapshot's name instead.
 */
const snapshotSchema = z.looseObject({ id: z.number().int(), name: z.string() });

/**
 * The account's servers (`GET /service/servers`), each id registered with `redactor` as it is read,
 * so no error shows one even when Kamatera repeats it.
 */
export async function kamateraServers(
  client: KamateraClient,
  redactor: ProviderRedactor,
): Promise<KamateraServer[]> {
  const servers = await client.get("/service/servers", z.array(serverSchema));
  for (const { id } of servers) redactor.addLiteral(id, SERVER_ID_LABEL);
  return servers;
}

export interface KamateraServerApiOptions {
  /** Masks the API key and the servers' ids in OpsCrew's own errors. */
  redactor: ProviderRedactor;
  /** Epoch milliseconds, for the time a snapshot's name ends with. */
  now: () => number;
}

/**
 * Server lookup by name (Kamatera's servers carry no tags, and the Terraform id is the name), and
 * snapshots and power actions for the provider-neutral teardown and snapshot commands. A server is
 * named by its name and reached by its id, since Kamatera's API reads a name as a pattern that may
 * match several servers; a name Kamatera has twice is refused. Every change is a queued command
 * the client waits for with the injected clock and sleep. A server is never installed again from
 * its image: a Kamatera server that fails its first boot is made again as a new one.
 */
export function kamateraServerApi(
  client: KamateraClient,
  options: KamateraServerApiOptions,
): ServerSnapshotApi {
  const { redactor, now } = options;

  const fail = (message: string, hint: string, code: ErrorCode = "PROVIDER_ERROR") =>
    new OpsCrewError(code, redactor.redact(message), { hint: redactor.redact(hint) });

  const servers = () => kamateraServers(client, redactor);

  /** The one server named `name`; refused when Kamatera has none or several. */
  const serverNamed = async (name: string): Promise<KamateraServer> => {
    const named = (await servers()).filter((server) => server.name === name);
    const [server] = named;
    if (server === undefined) {
      throw fail(
        `Kamatera has no server named ${name}.`,
        `It may have been terminated or renamed: check the servers in ${CONSOLE}.`,
      );
    }
    if (named.length > 1) {
      throw fail(
        `Kamatera has ${named.length} servers named ${name}, so OpsCrew can't tell which one is the app's.`,
        `Keep the app's server and rename or terminate the others in ${CONSOLE}, then try again.`,
      );
    }
    return server;
  };

  /** The server's snapshots, every one of them. */
  const snapshotsOf = (server: KamateraServer) =>
    client.post("/server/snapshot", z.array(snapshotSchema), { id: server.id });

  /** Sends a power command for the server and waits for it. */
  const powerCommand = (
    server: KamateraServer,
    action: "poweron" | "poweroff" | "reboot",
    what: string,
    timeoutMs: number,
  ) => client.command(`/service/server/${action}`, { id: server.id }, { what, timeoutMs });

  return {
    /**
     * The account's servers named `<app>` or `<app>-<name>`, every one `nameOnly` with its name as
     * its id (Kamatera's servers have no tags; the Terraform id is the name), so the generic
     * takeover adopts one only after OpsCrew's own apply stopped while creating it. Kamatera's list
     * shows no state but the power, so a server it is terminating is listed until it is gone.
     * @throws OpsCrewError `PHASE_PRECONDITION` when the account has `<app>(n)` or
     * `<app>-<name>(n)`: a duplicate Kamatera renamed so when a create was sent again for a name it
     * had, which its Terraform provider then loses while it bills. Each is named with its
     * datacenter, and the user deletes it before OpsCrew goes on.
     */
    async findAppServers(app: string): Promise<AppServer[]> {
      const all = await servers();
      // Kamatera's `(1)`; a later number too, as a third create of one name would leave.
      const renamed = new RegExp(`^${escapeRegExp(app)}(?:-.+)?\\(\\d+\\)$`);
      const duplicates = all.filter(({ name }) => renamed.test(name));
      if (duplicates.length > 0) {
        const one = duplicates.length === 1;
        const named = listText(duplicates.map((s) => `${s.name} in ${s.datacenter}`));
        throw fail(
          one
            ? `Kamatera has the server ${named}: a duplicate Kamatera made and renamed when a create of a name it already had was sent again. It still bills, and OpsCrew never takes it over.`
            : `Kamatera has the servers ${named}: duplicates Kamatera made and renamed when a create of a name it already had was sent again. They still bill, and OpsCrew never takes them over.`,
          `Delete ${one ? "it" : "them"} in ${CONSOLE} (its Terminate action), then run the command again.`,
          "PHASE_PRECONDITION",
        );
      }
      return all
        .filter(({ name }) => name === app || name.startsWith(`${app}-`))
        .map(({ name, power }) => ({ id: name, name, status: power, nameOnly: true }));
    },

    /**
     * Snapshots the server as `opscrew-<app>-<server>-<time>` (the app from `request.labels.app`,
     * the time from the injected clock), waits for the command, and answers the new snapshot's id
     * as `<server name>:<snapshot id>`: Kamatera reaches a snapshot only through its server.
     */
    async snapshotServer(
      serverId: string,
      request: SnapshotRequest,
    ): Promise<{ snapshotId: string }> {
      const app = request.labels.app;
      if (app === undefined) {
        throw fail(
          `OpsCrew names a Kamatera snapshot after its app, and the snapshot of the server ${serverId} names none.`,
          "Please report this to OpsCrew.",
          "INVALID_INPUT",
        );
      }
      const server = await serverNamed(serverId);
      const name = `${SNAPSHOT_PREFIX}${app}-${serverId}-${timeStamp(now())}`;
      await client.command(
        "/server/snapshot",
        { id: server.id, create: name },
        {
          what: `snapshot the server ${serverId}`,
          timeoutMs: request.timeoutMs ?? SNAPSHOT_TIMEOUT_MS,
        },
      );
      const taken = (await snapshotsOf(server)).find((snapshot) => snapshot.name === name);
      if (taken === undefined) {
        throw fail(
          `Kamatera finished the snapshot ${name} of the server ${serverId}, but doesn't list it.`,
          `Check the server's snapshots in ${CONSOLE} before taking another: each one is billed per GB a month.`,
        );
      }
      return { snapshotId: `${serverId}:${taken.id}` };
    },

    /**
     * The server's snapshots named `opscrew-<app>-<its name>-<time>`, oldest first by that time,
     * which OpsCrew's clock wrote when it asked for the snapshot.
     */
    async listSnapshots(serverId: string): Promise<ServerSnapshot[]> {
      const server = await serverNamed(serverId);
      const ours = new RegExp(`^${SNAPSHOT_PREFIX}.+-${escapeRegExp(serverId)}-${TAKEN_AT}$`);
      return (await snapshotsOf(server))
        .flatMap(({ id, name }): ServerSnapshot[] => {
          const match = ours.exec(name);
          if (match === null) return [];
          const [, year, month, day, hour, minute, second] = match;
          return [
            {
              id: `${serverId}:${id}`,
              createdAt: `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`,
            },
          ];
        })
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },

    /** Deletes the snapshot through its server and waits for the command. */
    async deleteSnapshot(snapshotId: string): Promise<void> {
      const { server: serverName, snapshot } = snapshotRef(snapshotId);
      const server = await serverNamed(serverName);
      await client.command(
        "/server/snapshot",
        { id: server.id, delete: snapshot },
        {
          what: `delete the snapshot ${snapshot} of the server ${serverName}`,
          timeoutMs: ACTION_TIMEOUT_MS,
        },
      );
    },

    /**
     * Reverts the server to its snapshot (`POST /server/snapshot` with `revert`, the console API's
     * `PUT /service/server/<id>/snapshot`) and waits for the command. The server stays the same
     * server, its disk as the snapshot had it. Unverified, since Kamatera's documentation doesn't
     * say: what the revert does to the server's newer snapshots (Contabo's deletes them), and
     * whether the server is running after it.
     */
    async rebuild(serverId: string, snapshotId: string): Promise<void> {
      const { server: serverName, snapshot } = snapshotRef(snapshotId);
      if (serverName !== serverId) {
        throw fail(
          `The snapshot ${snapshotId} is of the Kamatera server ${serverName}, not ${serverId}: Kamatera reverts a server only to its own snapshots.`,
          "`opscrew snapshot list` shows each snapshot with its server.",
          "INVALID_INPUT",
        );
      }
      const server = await serverNamed(serverId);
      await client.command(
        "/server/snapshot",
        { id: server.id, revert: snapshot },
        {
          what: `revert the server ${serverId} to the snapshot ${snapshot}`,
          timeoutMs: ACTION_TIMEOUT_MS,
        },
      );
    },

    /**
     * Powers the server off and waits for the command, 5 minutes at most. OpsCrew sends no
     * `force`, which only Kamatera's terminate takes.
     */
    async powerOff(serverId: string): Promise<void> {
      const server = await serverNamed(serverId);
      // Already off (a destroy run again after a shutdown): nothing to send.
      if (server.power === "off") return;
      await powerCommand(
        server,
        "poweroff",
        `power the server ${serverId} off`,
        SHUTDOWN_TIMEOUT_MS,
      );
    },

    /** Powers the server on and waits for the command. */
    async powerOn(serverId: string): Promise<void> {
      const server = await serverNamed(serverId);
      if (server.power === "on") return;
      await powerCommand(server, "poweron", `power the server ${serverId} on`, ACTION_TIMEOUT_MS);
    },

    /** Reboots the server and waits for the command (the caller waits for the server). */
    async restart(serverId: string): Promise<void> {
      const server = await serverNamed(serverId);
      await powerCommand(server, "reboot", `restart the server ${serverId}`, ACTION_TIMEOUT_MS);
    },
  };
}

/** `20261126T100000Z`: the time a snapshot's name ends with. */
function timeStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");
}

/**
 * A snapshot id OpsCrew gave out, `<server name>:<snapshot id>`, as its two parts (a Kamatera
 * server's name holds no colon); anything else is refused before calling the API.
 */
function snapshotRef(value: string): { server: string; snapshot: string } {
  const match = /^([^:]+):(\d+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${value}" is not a Kamatera snapshot id: OpsCrew writes them as <server name>:<snapshot id>.`,
      { hint: "`opscrew snapshot list` shows each snapshot's id." },
    );
  }
  return { server: match[1], snapshot: match[2] };
}

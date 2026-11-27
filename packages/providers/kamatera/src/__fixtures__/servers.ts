import type { FakeReply } from "@opscrew/core/testing";

/** Synthetic server ids (Kamatera's are UUIDs). OpsCrew sends them and never shows them. */
export const SHOP_ID = "fa4e0000-0000-4000-8000-000000000001";
export const WORKER_ID = "fa4e0000-0000-4000-8000-000000000002";
export const OTHER_ID = "fa4e0000-0000-4000-8000-000000000003";
export const SERVER_IDS = [SHOP_ID, WORKER_ID, OTHER_ID];

/**
 * One server as `GET /service/servers` lists it: `id`, `datacenter`, `name` and `power` (`on` or
 * `off`), the fields of the CLI schema's `server list` and of the console API documentation's
 * example.
 */
export function server(
  name: string,
  options: { id?: string; datacenter?: string; power?: string } = {},
) {
  return {
    id: options.id ?? SHOP_ID,
    datacenter: options.datacenter ?? "EU-FR",
    name,
    power: options.power ?? "on",
  };
}

/** `GET /service/servers`'s answer with these servers. */
export function serverList(...servers: ReturnType<typeof server>[]): FakeReply {
  return { body: servers };
}

/**
 * One snapshot as `POST /server/snapshot` lists it without `create` or `delete`: the console's
 * `GET /service/server/<id>/snapshots` (`id` a number, `name`, `date`, `active`, `depth`), its
 * tree flattened by the CLI API, which sets each `child` to null.
 */
export function snapshot(id: number, name: string, date = "11/26/2026 10:00:09") {
  return { id, name, date, active: false, depth: 0, child: null };
}

/** The answer to a snapshot's create or delete: the command's id, a bare number. */
export const COMMAND: FakeReply = { body: 4242 };

/** The answer to a power command: a list of one command id. */
export const POWER_COMMAND: FakeReply = { body: ["4243"] };

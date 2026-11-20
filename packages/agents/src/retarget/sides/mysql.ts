/**
 * MySQL and MariaDB in a move's copy before the window (031): a data folder copied while the
 * server writes is no consistent snapshot, and InnoDB may refuse to start on it. So the old side's
 * service is dumped consistently (`--single-transaction`) while the app serves, and the dump is
 * restored into the new side's service. The window copies the data folder itself, with both
 * services stopped. As for Postgres (`postgres.ts`), the tools run in one-off containers of the
 * service's pinned image on its network, through the Docker API of any {@link SideDocker}, the dump
 * in a move volume of its own; root's password reaches a one-off container only in a login file
 * written through the archive `PUT` before it starts, never in its environment or command. None of
 * the tools' output is shown: a failed restore can quote rows.
 */
import {
  ContainerLeftError,
  type DockerClient,
  type OneOffResult,
  runOneOff,
  sweepCarriers,
  tarStream,
} from "@opscrew/connector-docker";
import { errorMessage, OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { pollUntil } from "../../shared";
import type { Waits } from "./postgres";
import type { SideDocker } from "./types";

/** A MySQL or MariaDB service of the app on one side of a move. */
export interface MoveMysql {
  /** The app's name, which names the move volume ({@link mysqlDumpVolume}). */
  app: string;
  /** The Compose project the service runs in: the one-off containers join its `internal` network. */
  project: string;
  /** The service's Compose name (such as `mysql`): its host name on that network. */
  service: string;
  kind: "mysql" | "mariadb";
  /** Root's password (the service's generated `root-password`). */
  password: string;
}

/** The label on every one-off container of a dump, with its move volume as the value. */
const ONE_OFF_LABEL = "opscrew.move-dump";
/** Where a one-off container mounts the move volume, and the dump's path in it. */
const MOUNT = "/dump";
const DUMP = `${MOUNT}/all.sql`;
/** Where a one-off container that logs in finds root's login file (mode 0600). */
const LOGIN = "/tmp/opscrew.my.cnf";

/** The tools of each kind: the dump, the client, the ping. */
const TOOLS = {
  mysql: { dump: "mysqldump", client: "mysql", admin: "mysqladmin" },
  mariadb: { dump: "mariadb-dump", client: "mariadb", admin: "mariadb-admin" },
} as const;

/** The move volume that holds a service's dump on each side: `opscrew-move-dump-<app>-<service>`. */
export function mysqlDumpVolume(db: Pick<MoveMysql, "app" | "service">): string {
  return `opscrew-move-dump-${db.app}-${db.service}`;
}

/** An option file's value in double quotes, `\` and `"` escaped, as the clients read it. */
function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/** The plain error when a one-off container could not `what`: its exit code only. */
function failed(db: MoveMysql, what: string, result: OneOffResult, hint: string): OpsCrewError {
  return new OpsCrewError(
    "COMMAND_FAILED",
    `Could not ${what} of ${db.service} (exit code ${result.exitCode}).`,
    { hint },
  );
}

const DATABASE_HINT =
  "Check that the service runs and accepts root's login (`docker compose logs --tail 100 <service>` in the app's folder, or its container's logs in Portainer), then run the command again.";

/**
 * Runs `script` (`sh -c`, the service's name as `$1`) in a one-off container of the service's
 * image with the move volume mounted, on the service's network; root's login file is written into
 * it at {@link LOGIN} through the archive API before it starts.
 */
function mysqlOneOff(client: DockerClient, db: MoveMysql, script: string): Promise<OneOffResult> {
  const volume = mysqlDumpVolume(db);
  const login = `[client]\nuser=root\npassword=${quoted(db.password)}\n`;
  const file = { name: LOGIN.slice(1), type: "file", mode: 0o600, uid: 0, gid: 0 } as const;
  return runOneOff(
    client,
    {
      image: IMAGES[db.kind].ref,
      cmd: ["sh", "-c", script, "sh", db.service],
      labels: { [ONE_OFF_LABEL]: volume },
      mounts: [{ type: "volume", source: volume, target: MOUNT }],
      network: `${db.project}_internal`,
    },
    (id) => client.putArchive(id, "/", tarStream([{ ...file, data: Buffer.from(login) }])),
  ).catch((error: unknown) => {
    // A container left behind holds root's login file: never silently.
    if (!(error instanceof ContainerLeftError)) throw error;
    const short = error.id.slice(0, 12);
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `${errorMessage(error.cause).replace(/\.?$/, ".")} OpsCrew could not remove its one-off container ${short} either, which may hold ${db.service}'s root login file.`,
      {
        hint: `Remove it on the Docker host with \`docker rm -f ${short}\`, then run the command again.`,
      },
    );
  });
}

/** The dump is whole (its last line says so) and its SHA-256, computed on the side's own server. */
async function dumpDigest(client: DockerClient, db: MoveMysql): Promise<string> {
  const result = await mysqlOneOff(
    client,
    db,
    `tail -n 1 ${DUMP} | grep -q '^-- Dump completed' && sha256sum ${DUMP}`,
  );
  const hint =
    "The dump is incomplete or damaged; OpsCrew makes a new one when you run the command again. If it fails again, check the free disk space on both sides.";
  if (result.exitCode !== 0) throw failed(db, "read the dump", result, hint);
  const digest = /^([0-9a-f]{64})\s/.exec(result.stdout.trim())?.[1];
  if (digest === undefined) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `sha256sum did not report ${db.service}'s dump's checksum.`,
      {
        hint,
      },
    );
  }
  return digest;
}

/**
 * The old side: dumps every database of the service, its routines, triggers and events, in one
 * consistent read (`--single-transaction`) while it serves, into the move volume, created when
 * missing. Returns the dump's SHA-256 once its last line says it is whole.
 */
export async function dumpMysql(
  docker: Pick<SideDocker, "client">,
  db: MoveMysql,
): Promise<string> {
  const { client } = docker;
  const volume = mysqlDumpVolume(db);
  if (!(await client.volumeExists(volume))) await client.createVolume(volume);
  const result = await mysqlOneOff(
    client,
    db,
    `umask 077 && exec ${TOOLS[db.kind].dump} --defaults-extra-file=${LOGIN} -h "$1" --single-transaction --routines --triggers --events --all-databases --result-file=${DUMP}`,
  );
  if (result.exitCode !== 0) throw failed(db, "dump the databases", result, DATABASE_HINT);
  return dumpDigest(client, db);
}

/** The new side's copy of the dump: it must be whole and its SHA-256 `sha256`, the old side's. */
export async function checkCopiedMysqlDump(
  docker: Pick<SideDocker, "client">,
  db: MoveMysql,
  sha256: string,
): Promise<void> {
  if ((await dumpDigest(docker.client, db)) !== sha256) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The dump of ${db.service} copied to the new side differs from the dump on the old side.`,
      {
        hint: "Check the free disk space on both sides; running the command again makes and copies a new dump.",
      },
    );
  }
}

/** How long the new side's service has to take connections before a restore: about 2 minutes. */
const READY_MS = 2 * 60_000;

/**
 * The restore of a dump {@link checkCopiedMysqlDump} passed, once the new side's service answers
 * (polled for at most {@link READY_MS}): the dump replaces its databases, as root.
 */
export async function restoreMysqlDump(
  docker: Pick<SideDocker, "client">,
  db: MoveMysql,
  waits: Waits = {},
): Promise<void> {
  const { client } = docker;
  const tools = TOOLS[db.kind];
  let last: OneOffResult = { exitCode: 1, stdout: "", stderr: "" };
  const ready = await pollUntil(
    async () => {
      last = await mysqlOneOff(
        client,
        db,
        `exec ${tools.admin} --defaults-extra-file=${LOGIN} -h "$1" ping`,
      );
      return last.exitCode === 0 ? true : undefined;
    },
    { timeoutMs: READY_MS, intervalMs: 2000, ...waits },
  );
  if (!ready) throw failed(db, "reach the database within 2 minutes", last, DATABASE_HINT);
  const restored = await mysqlOneOff(
    client,
    db,
    `exec ${tools.client} --defaults-extra-file=${LOGIN} -h "$1" < ${DUMP}`,
  );
  if (restored.exitCode !== 0) {
    throw failed(db, "restore the dump", restored, DATABASE_HINT);
  }
}

/**
 * Removes the service's move volume from a side, with any one-off or carrier container a lost
 * connection left on it; a volume already gone is fine.
 */
export async function removeMysqlDumpVolume(
  client: DockerClient,
  db: Pick<MoveMysql, "app" | "service">,
): Promise<void> {
  const volume = mysqlDumpVolume(db);
  for (const container of await client.listContainers([`${ONE_OFF_LABEL}=${volume}`])) {
    await client.removeContainer(container.id);
  }
  await sweepCarriers(client, [{ kind: "volume", name: volume }]);
  if (await client.volumeExists(volume)) await client.removeVolume(volume);
}

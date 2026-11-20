/**
 * One side of a move (ADR 0027 D1): the old target or the new one. `opscrew retarget`'s steps ask
 * the sides; each target kind implements it once (`cloud` and `own` over SSH, `portainer` through
 * its API). Written by the lead (T2301); T2307 implements the SSH sides, T2308 Portainer's.
 */
import type { DockerClient, VolumeCarrier } from "@opscrew/connector-docker";
import type { DestroyPreview } from "../../destroy/types";
import type { DeployedState, MoveMarker } from "../server-ops";
import type { MoveBase, MoveSession } from "../session";
import type { RetargetResult } from "../types";

/**
 * How long a stateful service gets to stop cleanly before Docker kills it (T2306): long enough for
 * a database to flush, so its files are whole when they are copied.
 */
export const STOP_SECONDS = 120;

/** The kinds of side: a server OpsCrew created, the user's own server, the user's Portainer. */
export type MoveSideKind = "cloud" | "own" | "portainer";

/**
 * Where a side keeps one mount's data: a named Docker volume (Portainer, SQLite, a few catalog
 * kinds), or a folder on the server bound into the service (`/srv/data/<app>/<service>` on a server
 * OpsCrew deploys to over SSH). The carrier mounts either.
 */
export type SideSource = { kind: "volume"; name: string } | { kind: "bind"; path: string };

/**
 * One mount of the app's data on a side. Mounts are paired across the sides by `owner` and `key`,
 * never by a volume's name or a folder's path, which differ between sides.
 */
export interface SideVolume {
  /** The service whose data it is; `app` for the app's own, `monitoring` for its stack's. */
  owner: string;
  /**
   * The path the service mounts it at inside its container (`/var/lib/postgresql/data`): the
   * catalog renders the same on every side, whether the source is a volume or a folder.
   */
  key: string;
  /** Where the data is on this side. */
  source: SideSource;
  /** Its size in bytes (`system/df` for a volume, the carrier's `du` for a folder). */
  bytes: number;
}

/**
 * The Docker API on a side's server, with the carrier that reads, empties, writes, hashes and
 * lists its volumes (the pinned `busybox`). `close` ends the connection (an SSH session, say).
 */
export interface SideDocker {
  client: DockerClient;
  carrier: VolumeCarrier;
  close(): Promise<void>;
}

/**
 * A step that stopped before an apply a script must approve (`--approve <hash>`), or `undefined`
 * once the side's part of the step is done.
 */
export type SideStop = RetargetResult | undefined;

/**
 * A side of a move. Every method acts on the app of `session.plan` and changes only what the move
 * made or the app owns: never the user's server, Portainer or its environment (SC-2304). Each
 * change it makes goes through its approval (an IaC plan, a host plan or a stack plan by hash; the
 * window's container and volume changes under the window's one `remote-exec` approval).
 */
export interface MoveSide {
  readonly kind: MoveSideKind;
  /** Opens the Docker API on this side's server. The caller closes it. */
  docker(session: MoveBase): Promise<SideDocker>;
  /**
   * Step `created` (the new side): the server or environment made ready for the app, through its
   * approval: a cloud server's IaC plan, the own server's host plan, Portainer's stacks' setup.
   */
  prepare(session: MoveSession): Promise<SideStop>;
  /**
   * Step `deployed` (the new side): the app deployed with the image the old side runs, healthy,
   * and its edge stopped, so it takes no traffic before the switch. On a server whose deploy
   * a move's marker held ({@link markMove}), the image there and its services running.
   */
  deploy(session: MoveSession): Promise<SideStop>;
  /**
   * A server's new side, for a move that copies data (FR-3027): writes the marker in the app's
   * folder ({@link MoveMarker}): `waiting` keeps the deploys there to the app's image and services
   * until the data is there; `copied` lets the deploy before the window start the app on the data
   * copied while the old side serves, with the check left to the move; none (removed) once the
   * window started the app on the final data and it answers. Portainer's side has none.
   */
  markMove?(session: MoveBase, marker: MoveMarker): Promise<void>;
  /** A server's side: what its last deploy left in the app's folder. */
  deployed?(session: MoveBase): Promise<DeployedState>;
  /** Stops the app, its workers and its cron (not its stateful services, not the edge). */
  stopApp(session: MoveBase): Promise<void>;
  /** Starts what {@link stopApp} stopped, in place (the app's container and its route stay). */
  startApp(session: MoveBase): Promise<void>;
  /**
   * Stops the named stateful services cleanly (Compose service names), and the app's own
   * monitoring stack when it runs on this side's server.
   */
  stopServices(session: MoveBase, names: readonly string[]): Promise<void>;
  /** Starts the named stateful services, and the monitoring stack {@link stopServices} stopped. */
  startServices(session: MoveBase, names: readonly string[]): Promise<void>;
  /**
   * Stops the edge until traffic is switched to the side (Caddy or nginx, or the stack's Caddy on
   * Portainer); on a server whose edge other apps share, it keeps running.
   */
  stopEdge(session: MoveBase): Promise<void>;
  /** Starts the edge. */
  startEdge(session: MoveBase): Promise<void>;
  /** Whether the app answers its health route on this side. */
  healthy(session: MoveBase): Promise<boolean>;
  /** The app's data mounts on this side: its services', its own and its monitoring stack's. */
  volumes(session: MoveBase): Promise<SideVolume[]>;
  /**
   * The new side in the window, once the data is there and before the app starts again: runs the
   * release command of the version deployed there (`app.releaseCommand`, which migrates the
   * copied data forward) when it has one, with a timeout that grows with the `bytes` copied. Its
   * output never shows: it may quote rows.
   */
  release(session: MoveBase, bytes: number): Promise<void>;
  /**
   * `--finish` (the old side) and `--abort` (the new side): removes what the move made or left
   * there after `confirm` (the typed name): a cloud server through its IaC plan; on the user's
   * server, only the app (a teardown host plan); on Portainer, only the app's stacks and volumes.
   */
  remove(
    session: MoveSession,
    confirm: (preview: DestroyPreview) => Promise<boolean>,
  ): Promise<SideStop>;
}

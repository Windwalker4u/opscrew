/**
 * A restore drill's stack in the user's Portainer (029 plan.md 19., research R24): the drill's copy
 * as a second stack, `opscrew-<app>-drill`, rendered from the app's own stack for {@link drillPlan}
 * and cut down to the app and the snapshot's services: one network with no internet, no published
 * port, no Caddy, tunnel, stamp or snapshot service, and every container `restart: "no"`. The app's
 * snapshots volume is external, so the drill reads it and never makes or removes it.
 */
import type { DeployPlan } from "@opscrew/plan-schema";
import { parse, Scalar, stringify } from "yaml";
import {
  fillPortainerStack,
  portainerSnapshotsVolume,
  portainerStackName,
  renderPortainerStack,
} from "../portainer-target";
import { wrongTarget } from "../providers";
import { noStartMigrations } from "../railpack-laravel";
import type { RuntimeContext } from "../runtime";
import { appHealthcheck } from "../runtime/healthcheck";
import { planFilePath } from "../workflow/shared";
import { type DrillSnapshot, drillImageOk, drillPlan } from "./index";

/** Each restored database's table count, which a Portainer drill runs in a one-off of its image. */
export { databaseCount } from "../workflow/snapshots";

/** The key the drill's stack mounts the app's snapshots volume by (external). */
export const DRILL_SNAPSHOTS_KEY = "snapshots";

/** A restore drill's stack in the user's Portainer ({@link renderPortainerDrill}). */
export interface PortainerDrill {
  /** The stack's name, also its Compose project: `opscrew-<app>-drill`. */
  name: string;
  /** Its file with the snapshot's services only: the app is under the profile `app`, not started. */
  services: string;
  /** The same file with the app, deployed once the data is back. */
  withApp: string;
  /** The volumes the stack makes, `<name>_<key>`, which the drill removes again. */
  volumes: string[];
  /** The volumes it only reads: the app's snapshots volume. */
  external: string[];
}

/** A service of a rendered stack file. */
type StackService = Record<string, unknown> & {
  depends_on?: Record<string, unknown>;
  volumes?: string[];
  configs?: { source: string }[];
  network_mode?: string;
};

/** The parts of a render context the drill's stack never reads (it has no site or deploy key). */
const NO_CONTEXT: RuntimeContext = {
  opscrewVersion: "",
  github: { owner: "", repo: "" },
  deploySshPublicKey: "",
};

/**
 * The drill's stack of the snapshot in the user's Portainer, rendered like the app's stack
 * (`renderPortainerStack`) from {@link drillPlan} with the app at `o.image`: the app and the
 * snapshot's services with their one-time setup (MongoDB's replica set), their health checks (the
 * app the one a server's Compose file gives it, which the app's stack has none of),
 * memory limits, secrets as the stack's variables and settings inline; no release command,
 * workers, cron, Caddy, tunnel, stamp or snapshot service; one network `internal` with
 * `internal: true`, no published port, every container `restart: "no"`; the app's snapshots
 * volume declared external. `services` has the app under the profile `app`, so Portainer's deploy
 * starts only the services, which the drill restores into before it deploys `withApp`.
 * @throws OpsCrewError for a target that is not a Portainer, an image not pinned by its digest, or
 * a snapshot id or part the plan can't restore.
 */
export function renderPortainerDrill(
  plan: DeployPlan,
  snapshot: DrillSnapshot,
  o: { image: string },
): PortainerDrill {
  if (plan.target.provider !== "portainer") {
    throw wrongTarget("A restore drill's stack runs only in your Portainer.");
  }
  if (!drillImageOk(plan, o.image)) {
    throw wrongTarget(
      `The image ${JSON.stringify(o.image)} is not pinned by its digest (ghcr.io/…@sha256:<hex>).`,
    );
  }
  const drill = drillPlan(plan, snapshot);
  const name = portainerStackName(drill);
  const rendered = parse(
    fillPortainerStack(renderPortainerStack(drill, NO_CONTEXT).content, o.image),
  ) as {
    services: Record<string, StackService>;
    volumes?: Record<string, unknown>;
    configs?: Record<string, unknown>;
  };
  const backing = drill.services.map((service) => service.name);
  const kept = Object.keys(rendered.services).filter(
    (key) =>
      key === "app" ||
      backing.includes(key) ||
      backing.some((service) => key === `${service}-init`),
  );
  // The app's stack has no health check of the app (Caddy holds requests while it restarts); the
  // drill's app gets a server's, which the drill reads.
  const healthcheck = appHealthcheck(drill);
  const appCheck = healthcheck === undefined ? {} : { healthcheck };
  const volumes = new Set<string>();
  const configs = new Set<string>();
  const services = (withApp: boolean) =>
    Object.fromEntries(
      kept.map((key) => {
        const {
          ports: _ports,
          networks: _networks,
          depends_on,
          ...service
        } = rendered.services[key] as StackService;
        for (const mount of service.volumes ?? []) {
          const source = mount.split(":")[0] ?? "";
          if (/^[a-z0-9_]+$/.test(source)) volumes.add(source);
        }
        for (const config of service.configs ?? []) configs.add(config.source);
        const after = Object.entries(depends_on ?? {}).filter(([other]) => kept.includes(other));
        // Quoted: a YAML 1.1 reader takes a plain `no` for false.
        const restart = new Scalar("no");
        restart.type = Scalar.QUOTE_DOUBLE;
        return [
          key,
          {
            ...service,
            ...(key === "app" ? appCheck : {}),
            // The drill counts the restored tables: Railpack's start would migrate them first.
            ...(key === "app"
              ? { environment: { ...(service.environment as object), ...noStartMigrations(plan) } }
              : {}),
            ...(key === "app" && !withApp ? { profiles: ["app"] } : {}),
            restart,
            ...(service.network_mode === undefined ? { networks: ["internal"] } : {}),
            ...(after.length > 0 ? { depends_on: Object.fromEntries(after) } : {}),
          },
        ];
      }),
    );
  const file = (withApp: boolean) => {
    const document = {
      name,
      services: services(withApp),
      networks: { internal: { internal: true } },
      volumes: {
        ...Object.fromEntries([...volumes].sort().map((volume) => [volume, {}])),
        [DRILL_SNAPSHOTS_KEY]: { external: true, name: portainerSnapshotsVolume(plan) },
      },
      ...(configs.size === 0
        ? {}
        : {
            configs: Object.fromEntries(
              [...configs].sort().map((config) => [config, rendered.configs?.[config]]),
            ),
          }),
    };
    const header = [
      `# Generated by OpsCrew from ${planFilePath(plan)} for a restore drill of the snapshot ${snapshot.id}:`,
      "# a copy of the app and its data in your Portainer with no internet and no published port,",
      "# and none of the app's production values. opscrew restore --drill starts it and removes it.",
    ].join("\n");
    return `${header}\n${stringify(document, { lineWidth: 0, aliasDuplicateObjects: false })}`;
  };
  const withApp = file(true);
  return {
    name,
    services: file(false),
    withApp,
    volumes: [...volumes].sort().map((volume) => `${name}_${volume}`),
    external: [portainerSnapshotsVolume(plan)],
  };
}

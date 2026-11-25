/**
 * Answers of OVHcloud's API for the server API's and the connector's tests, in the shapes of the
 * published schemas (https://eu.api.ovh.com/v2/publicCloud.json and
 * https://eu.api.ovh.com/v1/cloud.json, read 2026-11-21), trimmed to the fields OpsCrew reads
 * plus a few it must ignore. Addresses are documentation addresses.
 */
import { PROJECT } from "./fixtures";

/** The project's paths under the v1 and the v2 base, as the client sends them. */
export const V1 = `/v1/cloud/project/${PROJECT}` as const;
export const V2 = `/v2/publicCloud/project/${PROJECT}` as const;

/** Instance, snapshot, image and operation ids (UUIDs, as OVHcloud's). */
export const SERVER = "6f1c2b9e-4d3a-4f5e-9a1b-2c3d4e5f6a7b";
export const WORKER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const OTHER = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
export const SNAPSHOT = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
export const IMAGE = "7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a";
export const OPERATION = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";

/** A v2 instance (`publicCloud.instance.Instance`). */
export function instance(
  options: {
    id?: string;
    name?: string;
    region?: string;
    resourceStatus?: string;
    /** Null while OVHcloud is still creating it (`currentState` is null then). */
    powerState?: string | null;
    tasks?: { type: string; status: string; errors?: { message: string }[] }[];
  } = {},
) {
  const {
    id = SERVER,
    name = "shop",
    region = "GRA11",
    resourceStatus = "READY",
    powerState = "ACTIVE",
    tasks = [],
  } = options;
  return {
    id,
    checksum: "c0ffee",
    createdAt: "2026-11-21T09:00:00Z",
    updatedAt: "2026-11-21T09:02:00Z",
    resourceStatus,
    currentTasks: tasks.map((task, index) => ({
      id: `a0000000-0000-4000-8000-00000000000${index}`,
      link: `/v2/publicCloud/project/${PROJECT}/compute/instance/${id}`,
      type: task.type,
      status: task.status,
      errors: task.errors ?? null,
    })),
    targetSpec: {
      name,
      flavor: { id: "b1a2c3d4-0000-4000-8000-000000000001" },
      image: { id: IMAGE },
      location: { region },
      networks: [{ autoAssignPublicIp: true }],
      securityGroups: [{ id: "e1a2c3d4-0000-4000-8000-000000000002" }],
      sshKeyName: "shop-deploy",
      powerState: "ACTIVE",
    },
    currentState:
      powerState === null
        ? null
        : {
            name,
            projectId: PROJECT,
            powerState,
            locked: false,
            location: { region, availabilityZone: null },
            flavor: { id: "b1a2c3d4-0000-4000-8000-000000000001", name: "d2-2", vcpus: 1 },
            image: { id: IMAGE, name: "Ubuntu 24.04", defaultUser: "ubuntu" },
            networks: [
              {
                id: null,
                addresses: [
                  { ip: "203.0.113.10", version: 4, type: "FIXED", mac: "fa:16:3e:00:00:01" },
                  { ip: "2001:db8::10", version: 6, type: "FIXED", mac: "fa:16:3e:00:00:01" },
                ],
              },
            ],
            sshKeyName: "shop-deploy",
          },
  };
}

/** A v2 instance snapshot (`publicCloud.instance.Snapshot`). */
export function snapshot(
  options: {
    id?: string;
    name?: string;
    instanceId?: string;
    resourceStatus?: string;
    /** Bytes; null while OVHcloud doesn't know it. */
    size?: number | null;
    createdAt?: string;
    tasks?: { type: string; status: string; errors?: { message: string }[] }[];
  } = {},
) {
  const {
    id = SNAPSHOT,
    name = `opscrew-shop-${SERVER}-20261121T100000Z`,
    instanceId = SERVER,
    resourceStatus = "READY",
    size = 3 * 1024 ** 3,
    createdAt = "2026-11-21T10:00:00Z",
    tasks = [],
  } = options;
  return {
    id,
    checksum: "c0ffee",
    createdAt,
    updatedAt: createdAt,
    resourceStatus,
    currentTasks: tasks.map((task) => ({ ...task, errors: task.errors ?? null })),
    targetSpec: { name, instance: { id: instanceId }, location: { region: "GRA11" } },
    currentState: {
      name,
      instance: { id: instanceId },
      location: { region: "GRA11" },
      size,
      status: resourceStatus === "READY" ? "ACTIVE" : "SAVING",
      visibility: "PRIVATE",
      osType: "LINUX",
      canBeDeleted: true,
    },
  };
}

/** A v1 instance (`cloud.instance.Instance`), as the instance GET answers. */
export function v1Instance(options: { id?: string; status?: string } = {}) {
  const { id = SERVER, status = "ACTIVE" } = options;
  return {
    id,
    name: "shop",
    status,
    region: "GRA11",
    created: "2026-11-21T09:00:00Z",
    flavorId: "b1a2c3d4-0000-4000-8000-000000000001",
    imageId: IMAGE,
    ipAddresses: [{ ip: "203.0.113.10", version: 4, type: "public", networkId: "net" }],
    operationIds: [],
    monthlyBilling: null,
    rescuePassword: null,
  };
}

/** A v1 operation (`cloud.Operation`). */
export function operation(options: { id?: string; status?: string; action?: string } = {}) {
  const { id = OPERATION, status = "created", action = "instance#reinstall" } = options;
  return {
    id,
    action,
    status,
    progress: status === "completed" ? 100 : 0,
    regions: ["GRA11"],
    resourceId: SERVER,
    createdAt: "2026-11-21T10:00:00Z",
    startedAt: null,
    completedAt: null,
    subOperations: null,
  };
}

/** A v2 reference image (`publicCloud.reference.instance.Image`). */
export function image(options: { id?: string; name?: string; status?: string } = {}) {
  const { id = IMAGE, name = "Ubuntu 24.04", status = "ACTIVE" } = options;
  return {
    id,
    name,
    status,
    defaultUser: "ubuntu",
    location: { region: "GRA11" },
    osType: "LINUX",
    visibility: "PUBLIC",
    minDisk: 0,
    minRam: 0,
    size: 600_000_000,
    createdAt: "2026-04-25T00:00:00Z",
    updatedAt: "2026-04-25T00:00:00Z",
  };
}

/** A v2 reference region (`publicCloud.reference.Region`). */
export function region(name: string, activated: boolean) {
  return {
    name,
    activated,
    status: "ENABLED",
    type: "REGION-1-AZ",
    continent: "EU",
    country: "fr",
    datacenterName: name,
    availabilityZones: null,
    services: ["instance"],
    objectStorage: null,
  };
}

/** A v2 project (`publicCloud.project.ProjectAsyncWithIAM`). */
export function project(name: string | null) {
  return {
    id: PROJECT,
    name,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    resourceStatus: "READY",
    currentTasks: [],
    currentState: { name: name ?? PROJECT, mode: "CLASSIC" },
    targetSpec: { name: name ?? PROJECT, mode: "CLASSIC" },
    iam: {
      id: "d0000000-0000-4000-8000-000000000001",
      urn: `urn:v1:eu:resource:publicCloudProject:${PROJECT}`,
      displayName: name,
    },
  };
}

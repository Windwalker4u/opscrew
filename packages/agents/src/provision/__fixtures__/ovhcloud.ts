/**
 * An OVHcloud app's infrastructure as the engine plans it (the rendered root with its
 * `ovhcloud-instance` module), and the four OVHcloud values, synthetic.
 */
import type { ResourceChange } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { CF_V4, CF_V6 } from "../../testing";

/** OVHcloud's four values, by environment variable (the zone is the only one not secret). */
export const OVH_ENV = {
  OVH_ENDPOINT: "ovh-eu",
  OVH_CLIENT_ID: fakeSecret("generic-password", "ovh-client-id"),
  OVH_CLIENT_SECRET: fakeSecret("generic-password", "ovh-client-secret"),
  OVH_CLOUD_PROJECT_SERVICE: fakeSecret("generic-password", "ovh-project-id"),
} as const;

/** The Public Cloud project's id, which every OVHcloud resource names as `service_name`. */
export const OVH_PROJECT = OVH_ENV.OVH_CLOUD_PROJECT_SERVICE;

/** The app's instance as the testing `FakeServers("ovhcloud")` reports it, and its snapshot. */
export const OVH_SERVER_ID = "11111111-2222-4333-8444-555555555555";
export const OVH_SNAPSHOT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** The state addresses of the app's server module. */
export const OVH_ADDRESSES = {
  key: "module.server.ovh_cloud_ssh_key.deploy[0]",
  group: "module.server.ovh_cloud_security_group.this",
  server: "module.server.ovh_cloud_instance.this",
} as const;

/** `address` as a change of `action` by the `ovh/ovh` provider. */
export function ovhChange(address: string, action: ResourceChange["action"]): ResourceChange {
  const [type = "", name = ""] = address.replace(/\[\d+\]$/, "").split(".").slice(-2);
  return { address, type, name, provider: "registry.opentofu.org/ovh/ovh", action };
}

/** What the first apply of an OVHcloud app creates. */
export const OVH_CREATE: ResourceChange[] = Object.values(OVH_ADDRESSES).map((address) =>
  ovhChange(address, "create"),
);

/** A security group rule as `ovh_cloud_security_group.this` plans it (one source each). */
function rule(protocol: string, port: number | null, cidr: string) {
  return {
    direction: "INGRESS",
    ethernet_type: cidr.includes(":") ? "IPV6" : "IPV4",
    protocol,
    port_range_min: port,
    port_range_max: port,
    remote_ip_prefix: cidr,
    description: null,
  };
}

/**
 * `show -json` of the rendered OVHcloud root: the deploy key, the security group (SSH from
 * anywhere, the web from Cloudflare's ranges with `proxied`, else from anywhere, ping) and the
 * instance with the key's name and the group attached, each naming the project as `service_name`
 * (ADR 0029, D11). `importing` plans the instance's import with that id instead of its create.
 */
export function ovhcloudPlanJson(options: { proxied?: boolean; importing?: string } = {}) {
  const world = ["0.0.0.0/0", "::/0"];
  const web = options.proxied ? [...CF_V4, ...CF_V6] : world;
  const rules = [
    ...world.map((cidr) => rule("TCP", 22, cidr)),
    ...web.flatMap((cidr) => [rule("TCP", 80, cidr), rule("TCP", 443, cidr), rule("UDP", 443, cidr)]),
    rule("ICMP", null, "0.0.0.0/0"),
    rule("ICMPV6", null, "::/0"),
  ];
  const common = { service_name: OVH_PROJECT };
  const resources = [
    {
      address: OVH_ADDRESSES.key,
      mode: "managed",
      type: "ovh_cloud_ssh_key",
      name: "deploy",
      index: 0,
      values: { ...common, name: "shop-deploy" },
    },
    {
      address: OVH_ADDRESSES.group,
      mode: "managed",
      type: "ovh_cloud_security_group",
      name: "this",
      values: { ...common, region: "GRA11", name: "opscrew-shop", rule: rules },
    },
    {
      address: OVH_ADDRESSES.server,
      mode: "managed",
      type: "ovh_cloud_instance",
      name: "this",
      values: { ...common, region: "GRA11", name: "shop", ssh_key_name: "shop-deploy" },
    },
  ];
  const server =
    options.importing === undefined
      ? {
          address: OVH_ADDRESSES.server,
          change: {
            actions: ["create"],
            after_unknown: { id: true, security_group_ids: true, current_state: true },
          },
        }
      : {
          address: OVH_ADDRESSES.server,
          change: { actions: ["no-op"], importing: { id: options.importing } },
        };
  return {
    format_version: "1.2",
    planned_values: {
      root_module: { child_modules: [{ address: "module.server", resources }] },
    },
    resource_changes: [server],
    configuration: {
      root_module: {
        module_calls: {
          server: {
            source: "../modules/ovhcloud-instance",
            module: {
              resources: [
                {
                  address: "ovh_cloud_security_group.this",
                  mode: "managed",
                  type: "ovh_cloud_security_group",
                  name: "this",
                  expressions: { name: { references: ["var.name"] } },
                },
                {
                  address: "ovh_cloud_instance.this",
                  mode: "managed",
                  type: "ovh_cloud_instance",
                  name: "this",
                  expressions: {
                    security_group_ids: {
                      references: ["ovh_cloud_security_group.this.id", "ovh_cloud_security_group.this"],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

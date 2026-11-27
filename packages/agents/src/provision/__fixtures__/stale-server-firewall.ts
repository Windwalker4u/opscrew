/**
 * A plan's JSON (masked, as policies see it) that keeps a Kamatera server the app already has,
 * whose first boot set its own firewall with SSH open to everyone, while the plan narrows SSH to
 * one network: the change OpsCrew can't make in place, which SecOps refuses before any approval.
 */

/** The networks the server's first boot set, and the one the plan narrows SSH to. */
const WORLD = ["0.0.0.0/0", "::/0"];
export const NARROWED_SSH = "203.0.113.7/32";

/**
 * The lines of the server firewall's step that SecOps reads (`server-firewall.sh.tftpl`): its
 * marker, the input chain's default drop and the networks, in the form the template keeps.
 */
const STORED_SCRIPT = [
  "#!/bin/sh",
  "# opscrew-server-firewall: the first step of the first boot, before anything else runs.",
  `ssh_sources='${WORLD.join(" ")}'`,
  `web_sources='${WORLD.join(" ")}'`,
  "wireguard_port=''",
  "printf '\\t\\ttype filter hook input priority filter; policy drop;\\n'",
  "",
].join("\n");

const ADDRESS = "module.server.kamatera_server.this";

/**
 * The plan JSON: the server kept (`no-op`, its script in `before` and in the planned values, as
 * the module ignores changes to it), the root's networks with SSH narrowed. `address` moves the
 * server, as a move's rename does (`module.server_previous.kamatera_server.this`).
 */
export function staleServerFirewallPlanJson(address = ADDRESS) {
  const call = /^module\.([^.]+)\./.exec(address)?.[1] ?? "server";
  const values = { name: "shop", ssh_pubkey: "ssh-ed25519 AAAA deploy", startup_script: STORED_SCRIPT };
  return {
    format_version: "1.2",
    variables: {
      ssh_allowed_cidrs: { value: [NARROWED_SSH] },
      http_allowed_cidrs: { value: WORLD },
    },
    configuration: {
      root_module: {
        module_calls: {
          [call]: {
            source: "../modules/kamatera-server",
            expressions: { ssh_allowed_cidrs: { references: ["var.ssh_allowed_cidrs"] } },
          },
        },
      },
    },
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: `module.${call}`,
            resources: [
              { address, mode: "managed", type: "kamatera_server", name: "this", values },
            ],
          },
        ],
      },
    },
    resource_changes: [
      {
        address,
        type: "kamatera_server",
        name: "this",
        change: { actions: ["no-op"], before: { ...values }, after: { ...values } },
      },
    ],
  };
}

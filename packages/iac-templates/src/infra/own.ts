// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import type { CloudProviderDefinition } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import { usesCloudflare } from "../predicates";
import { ownAccessMode, tunnelMode, webFilterMode } from "../tunnel";
import type { RenderContext } from "../types";
import {
  dnsModule,
  previewsCertificatePack,
  serverZoneUse,
  type ZoneUse,
  zoneTfvars,
  zoneVariables,
} from "./cloudflare";
import {
  APP_NAME_VARIABLE,
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  output,
  type RootFiles,
  rootHeader,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";
import {
  addressVariables,
  type ExtraServerCall,
  extraServerCalls,
  extraServerModules,
  extraServersOutput,
  keyTfvars,
  keyVariables,
  providerBlock,
  rootVariables,
  serverTfvars,
  serverVariables,
} from "./servers";
import { type TunnelPieces, tunnelPieces } from "./tunnel";

const OWN_NOTE = [
  "# A server you already own: OpsCrew neither creates nor deletes it, so this configuration has no",
  "# server resources, only what Cloudflare needs to send traffic to it.",
];

const OWN_NOTE_WITH_EXTRAS = [
  "# The app's server is one you already own: OpsCrew neither creates nor deletes it. The app's",
  "# extra servers below are ones OpsCrew creates.",
];

const ADDRESS_NOTE = [
  "# The server's addresses are never committed: OpsCrew passes them from its local state",
  "# (.opscrew/server.json) as TF_VAR_server_ipv4 and TF_VAR_server_ipv6 when it runs the engine.",
];

const HOME_NOTE = [
  "# The server is at your home, whose address can change: the address updater on the server keeps",
  "# the app's A and AAAA records, so neither they nor the address are in this configuration.",
];

/**
 * `module "dns"` of a server at home: `www.` and the CAA records only, without the A and AAAA
 * records the address updater keeps.
 */
const HOME_DNS_MODULE = dnsModule("records", undefined, undefined, "false", "false");

function variables(
  plan: DeployPlan,
  pieces: TunnelPieces | undefined,
  extras: readonly ExtraServerCall[],
  checkKey: boolean,
  zone: ZoneUse | undefined,
): VariableSpec[] {
  const specs: VariableSpec[] = [APP_NAME_VARIABLE];
  if (ownAccessMode(plan) === "public") specs.push(...addressVariables("", "your server"));
  if (extras.length > 0) {
    specs.push(
      ...extras.flatMap((extra) => serverVariables(extra, extra.name)),
      ...rootVariables(extras),
      ...keyVariables(checkKey),
    );
  }
  if (zone !== undefined) specs.push(...zoneVariables(zone));
  return [...specs, ...(pieces?.variables ?? [])];
}

/**
 * What the root needs from the Cloudflare zone: the domain in tunnel mode, otherwise the records
 * it points at the server ({@link serverZoneUse}); none without either.
 */
function zoneUse(plan: DeployPlan): ZoneUse | undefined {
  if (tunnelMode(plan)) return usesCloudflare(plan) ? "domain" : undefined;
  return serverZoneUse(plan);
}

function mainTf(
  plan: DeployPlan,
  pieces: TunnelPieces | undefined,
  extras: readonly ExtraServerCall[],
  providers: readonly CloudProviderDefinition[],
  checkKey: boolean,
  zone: ZoneUse | undefined,
): string {
  const lines = [rootHeader(plan), ""];
  for (const provider of providers) lines.push(...providerBlock(provider));
  if (zone !== undefined) lines.push(...CLOUDFLARE_PROVIDER_BLOCK);
  lines.push(...(extras.length > 0 ? OWN_NOTE_WITH_EXTRAS : OWN_NOTE));
  const mode = ownAccessMode(plan);
  if (mode === "home") {
    if (zone === "records") lines.push("#", ...HOME_NOTE);
  } else if (mode === "public") {
    lines.push("#", ...ADDRESS_NOTE);
  }
  lines.push("");
  lines.push(...extraServerModules(plan, extras, { bothSides: false, finishing: false }, checkKey));
  if (zone === "records" && mode === "home") {
    lines.push(...HOME_DNS_MODULE);
  } else if (zone === "records" || zone === "previews") {
    lines.push(
      ...dnsModule(
        zone,
        "var.server_ipv4",
        "var.server_ipv6",
        // Behind OpsCrew's web filter the site is published on IPv4 only: no AAAA record.
        webFilterMode(plan) ? "false" : "var.server_ipv6 != null",
      ),
    );
  }
  lines.push(...(previewsCertificatePack(plan)?.main ?? []));
  if (pieces) lines.push(...pieces.main);
  return lines.join("\n");
}

function outputsTf(
  plan: DeployPlan,
  pieces: TunnelPieces | undefined,
  extras: readonly ExtraServerCall[],
): string {
  const lines = [rootHeader(plan), ""];
  const mode = ownAccessMode(plan);
  if (mode === "tunnel") {
    lines.push(...output("url", '"https://${var.domain}"'));
  } else if (mode === "home") {
    if (usesCloudflare(plan)) {
      lines.push(
        ...output("url", "module.dns.url"),
        "# The address updater on the server keeps the app's A and AAAA records.",
        ...output("address_updater", "true"),
      );
    } else {
      // The DNS is elsewhere: the user's records point the domain at the home.
      lines.push(...output("url", JSON.stringify(`https://${plan.dns.domain}`)));
    }
  } else {
    lines.push(
      ...output("server_ipv4", "var.server_ipv4"),
      ...output("server_ipv6", "var.server_ipv6"),
      ...output("url", usesCloudflare(plan) ? "module.dns.url" : '"http://${var.server_ipv4}"'),
      "# Same shape as on OpsCrew-created servers, keyed by provider; an own server has no id.",
      'output "servers" {',
      "  value = {",
      "    own = {",
      "      ipv4 = var.server_ipv4",
      "      ipv6 = var.server_ipv6",
      "    }",
      "  }",
      "}",
      "",
    );
  }
  lines.push(...extraServersOutput(extras));
  lines.push(...(previewsCertificatePack(plan)?.outputs ?? []));
  if (pieces) lines.push(...pieces.outputs);
  return lines.join("\n");
}

/**
 * The root module of a server the user owns: no resources for that server. Public mode points the
 * DNS module at the `server_ipv4`/`server_ipv6` variables, which the CLI supplies as `TF_VAR_*`
 * and which never appear in `terraform.tfvars.json` (FR-902). Tunnel mode serves the app, SSH (and
 * Portainer when opted in) through a Cloudflare Tunnel behind Access instead of DNS records to an
 * address. A server at home (`homeMode`) has no address variables: with DNS on Cloudflare
 * the DNS module keeps only `www.` and the CAA records, since the address updater on the server
 * keeps the A and AAAA records, and the root outputs `address_updater = true`; with the DNS
 * elsewhere the root holds nothing. The plan's extra cloud servers are `module "server_<name>"`
 * each, with the `extra_servers` output.
 */
export function ownRoot(plan: DeployPlan, ctx: RenderContext): RootFiles {
  const pieces = tunnelPieces(plan, ctx);
  const zone = zoneUse(plan);
  const extras = extraServerCalls(plan);
  const providers = [...new Set(extras.map((extra) => extra.provider))];
  const checkKey = ctx.checkKeyLine !== undefined;
  return {
    versions: versionsTf(plan, [
      ...providers.map((provider) => provider.terraform.provider),
      ...(zone !== undefined ? [CLOUDFLARE_PROVIDER] : []),
    ]),
    main: mainTf(plan, pieces, extras, providers, checkKey, zone),
    variables: variablesTf(plan, variables(plan, pieces, extras, checkKey, zone)),
    outputs: outputsTf(plan, pieces, extras),
    tfvars: {
      app_name: plan.app.name,
      ...Object.assign({}, ...extras.map((extra) => serverTfvars(extra.prefix, extra.target))),
      ...(extras.length > 0 ? keyTfvars(plan, ctx) : {}),
      ...(zone !== undefined ? zoneTfvars(plan, ctx, zone) : {}),
      ...(pieces?.tfvars ?? {}),
    },
    modules: [
      ...providers.map((provider) => provider.terraform.module.name),
      ...(zone === "records" || zone === "previews" ? ["cloudflare-dns"] : []),
      ...(pieces?.modules ?? []),
    ],
  };
}

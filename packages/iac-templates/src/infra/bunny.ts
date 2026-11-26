// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { edgeProvider } from "@opscrew/edge-providers";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { RenderContext } from "../types";
import { moduleBlock, output, type VariableSpec } from "./hcl";

/** True when the root module needs the `bunny-edge` module (Bunny DNS, Bunny edge, or both). */
export function usesBunnyInfra(plan: DeployPlan): boolean {
  return (
    plan.dns.domain !== undefined && (plan.dns.provider === "bunny" || plan.dns.edge === "bunny")
  );
}

/** Deterministic Bunny.net Pull Zone slug for `plan` (lower-case alphanumeric + hyphens). */
export function bunnyPullzoneName(plan: Pick<DeployPlan, "app" | "environment">): string {
  const env = plan.environment?.name;
  const suffix = env === undefined || env === "prod" ? "" : `-${env}`;
  return `opscrew-${plan.app.name}${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * Relative record names inside a Bunny DNS zone for `domain` and `www.<domain>`.
 * Returns `""` / `"www"` for the zone apex and `<sublabel>` / `"www.<sublabel>"` for a subdomain.
 */
export function bunnyRecordNames(
  domain: string,
  zone: string | undefined,
): { recordName: string; wwwRecordName: string } {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const z = zone?.toLowerCase().replace(/\.$/, "");
  if (z === undefined || d === z || !d.endsWith(`.${z}`)) {
    return { recordName: "", wwwRecordName: "www" };
  }
  const sub = d.slice(0, -(z.length + 1));
  return { recordName: sub, wwwRecordName: `www.${sub}` };
}

/** Root variables added when `usesBunnyInfra(plan)` is true. */
export function bunnyVariables(plan: DeployPlan, hasDomainVar: boolean): VariableSpec[] {
  const manageDns = plan.dns.provider === "bunny";
  return [
    ...(hasDomainVar
      ? []
      : [
          { name: "domain", type: "string", description: "Hostname of the app." },
          { name: "www", type: "bool", description: "Also serve www.<domain>." },
        ]),
    {
      name: "bunny_pullzone_name",
      type: "string",
      description: "Unique Bunny.net Pull Zone slug for this app.",
    },
    {
      name: "bunny_proxied",
      type: "bool",
      description: "Proxy traffic through the Bunny.net Pull Zone.",
    },
    {
      name: "bunny_waf_custom_rules",
      type: "bool",
      description: "Add Bunny's free BlockRequest Edge Rule for common probes.",
    },
    ...(manageDns
      ? [
          {
            name: "bunny_dns_zone_id",
            type: "number",
            description: "Bunny.net DNS zone id.",
          },
          {
            name: "bunny_record_name",
            type: "string",
            description: "Relative record name inside the Bunny DNS zone (empty string for apex).",
          },
          {
            name: "bunny_www_record_name",
            type: "string",
            description: "Relative record name for www.<domain> inside the Bunny DNS zone.",
          },
        ]
      : []),
  ];
}

/** Non-secret tfvars for {@link bunnyVariables}. */
export function bunnyTfvars(
  plan: DeployPlan,
  ctx: RenderContext,
  hasDomainVar: boolean,
): Record<string, unknown> {
  const manageDns = plan.dns.provider === "bunny";
  const domain = plan.dns.domain ?? "";
  const { recordName, wwwRecordName } = bunnyRecordNames(domain, plan.dns.zone);
  return {
    ...(hasDomainVar ? {} : { domain, www: plan.dns.www }),
    bunny_pullzone_name: bunnyPullzoneName(plan),
    bunny_proxied: plan.dns.proxied,
    bunny_waf_custom_rules: plan.security.wafCustomRules,
    ...(manageDns
      ? {
          bunny_dns_zone_id: ctx.bunny?.dnsZoneId ?? 0,
          bunny_record_name: recordName,
          bunny_www_record_name: wwwRecordName,
        }
      : {}),
  };
}

/** `module "edge"` block pointing Bunny.net at the server's `ipv4` / `ipv6` (HCL expressions). */
export function bunnyEdgeModule(plan: DeployPlan, ipv4: string, ipv6: string): string[] {
  const manageDns = plan.dns.provider === "bunny";
  const bunny = edgeProvider("bunny");
  const moduleName = bunny.terraform.module?.name ?? "bunny-edge";
  return moduleBlock({
    comment: [
      "# Bunny.net Pull Zone (caching off, verified origin HTTPS, free probe blocking).",
      "# The shared origin-verification header is applied via the Bunny API after apply, never here.",
    ],
    name: "edge",
    source: moduleName,
    args: [
      ["pullzone_name", "var.bunny_pullzone_name"],
      ["domain", "var.domain"],
      ["www", "var.www"],
      ["origin_host", ipv4],
      ["proxied", "var.bunny_proxied"],
      ["waf_custom_rules", "var.bunny_waf_custom_rules"],
      ["manage_dns", manageDns ? "true" : "false"],
      ...(manageDns
        ? ([
            ["dns_zone_id", "var.bunny_dns_zone_id"],
            ["record_name", "var.bunny_record_name"],
            ["www_record_name", "var.bunny_www_record_name"],
            ["ipv4", ipv4],
            ["ipv6", ipv6],
          ] as const)
        : []),
    ],
  });
}

/** Root outputs for Bunny.net (`bunny_pullzone_id`, `bunny_pullzone_hostname`). */
export function bunnyOutputs(): string[] {
  return [
    ...output("bunny_pullzone_id", "module.edge.pullzone_id"),
    ...output("bunny_pullzone_hostname", "module.edge.pullzone_hostname"),
  ];
}

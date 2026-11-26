/**
 * The built-in DNS and edge proxy providers (ADR 0038): the one place OpsCrew reads edge provider
 * facts from. Every definition is validated when this module loads.
 */
import type { EdgeProviderDefinition } from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import { definition as bunny } from "@opscrew/edge-provider-bunny";
import { definition as cloudflare } from "@opscrew/edge-provider-cloudflare";
import { validateEdgeProvider } from "./validate";

export { validateEdgeProvider } from "./validate";

/** The built-in edge proxy providers, in order. */
export const EDGE_PROVIDERS: readonly EdgeProviderDefinition[] = [cloudflare, bunny].map(
  validateEdgeProvider,
);

/** The built-in providers that host authoritative DNS zones, in order. */
export const DNS_PROVIDERS: readonly EdgeProviderDefinition[] = EDGE_PROVIDERS.filter(
  (provider) => provider.capabilities.dns,
);

/** Each edge provider's credential variable and name, for help texts. */
export const EDGE_CREDENTIALS: string = EDGE_PROVIDERS.map(
  ({ credentials, displayName }) => `${credentials.envVars[0]} for ${displayName}`,
).join(", ");

/** The definition of the edge provider `id`; throws `INVALID_INPUT` for any other id. */
export function edgeProvider(id: string): EdgeProviderDefinition {
  const found = EDGE_PROVIDERS.find((provider) => provider.id === id);
  if (found !== undefined) return found;
  throw new OpsCrewError("INVALID_INPUT", `OpsCrew does not support edge provider "${id}".`, {
    hint: `Choose one of its edge providers: ${listText(EDGE_PROVIDERS.map((provider) => provider.id))}.`,
  });
}

/** The definition of the DNS hosting provider `id`; throws `INVALID_INPUT` if unsupported or edge-only. */
export function dnsProvider(id: string): EdgeProviderDefinition {
  const found = DNS_PROVIDERS.find((provider) => provider.id === id);
  if (found !== undefined) return found;
  throw new OpsCrewError("INVALID_INPUT", `OpsCrew does not manage DNS on "${id}".`, {
    hint: `Choose one of its DNS providers: ${listText(DNS_PROVIDERS.map((provider) => provider.id))}.`,
  });
}

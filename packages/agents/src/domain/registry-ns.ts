import { normalizeHostName } from "@opscrew/core";
import { z } from "zod";
import { nodeRegistryNetwork, type RegistryNetwork } from "./registry-ds";

/**
 * Asks a domain's registry which nameservers it names for the domain now (`registryNsLookup`):
 * lower case, without a trailing dot, sorted; `undefined` when its record can't be read. Never
 * throws. The public DNS can show an older delegation for as long as the TLD lets resolvers keep it
 * (a day for `.dev`); the registry's record changes as soon as the registrar's change is accepted.
 */
export type RegistryNsLookup = (domain: string) => Promise<string[] | undefined>;

const RdapNameserversSchema = z.object({
  nameservers: z.array(z.object({ ldhName: z.string() })),
});

/**
 * The nameservers an RDAP domain record names (RFC 9083: `nameservers[].ldhName`), normalised,
 * sorted and once each; `undefined` when it names none or is not such a record.
 */
export function rdapNameservers(record: unknown): string[] | undefined {
  const parsed = RdapNameserversSchema.safeParse(record);
  if (!parsed.success) return undefined;
  const names = parsed.data.nameservers
    .map((one) => normalizeHostName(one.ldhName))
    .filter((name) => name !== "");
  return names.length === 0 ? undefined : [...new Set(names)].sort();
}

/**
 * The registry's nameservers for a domain, from its RDAP record (`RegistryNetwork.rdapRecord`: the
 * TLD's RDAP server from IANA's bootstrap file); `undefined` when the network can't read it.
 */
export function registryNsLookup(
  network: Pick<RegistryNetwork, "rdapRecord"> = nodeRegistryNetwork(),
): RegistryNsLookup {
  return async (domain) => {
    try {
      return rdapNameservers(await network.rdapRecord?.(normalizeHostName(domain)));
    } catch {
      return undefined;
    }
  };
}

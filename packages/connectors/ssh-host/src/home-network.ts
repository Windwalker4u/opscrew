/**
 * Reading a home server's network from the server itself (feature 029, research R3): the LAN, the
 * public IPv4 as two outside sources see it, the stable global IPv6 address, and the first hops of
 * the path out. One fixed, read-only script runs as the login; each probe has its own time limit,
 * and a probe that fails gives its "unknown" value. The addresses go no further than the caller's
 * memory: nothing is written on the server, and nothing here persists them. The classification
 * (carrier-grade NAT, no NAT, the warnings) is agents'.
 */
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import { sectionsScript } from "./inspect";
import {
  ipv4Value,
  ipv6Value,
  isPublicAddress,
  isVirtualInterface,
  linesOf,
  networkHolds,
  SECTION_MARK,
  splitSections,
} from "./parse";
import { asLogin } from "./shell";

/** The tools the probes use when they are there (`tools`). */
export const HOME_NETWORK_TOOLS = ["curl", "tracepath", "traceroute"] as const;

/** Cloudflare's trace (its `ip=` line) and AWS's checkip: both are asked every time. */
const CLOUDFLARE_TRACE_URL = "https://one.one.one.one/cdn-cgi/trace";
const CHECKIP_URL = "https://checkip.amazonaws.com";
const CURL = "curl -4 -fsS --connect-timeout 5 --max-time 10";

/** The probes, one section each, each bounded in time. */
const HOME_NETWORK_SECTIONS: readonly (readonly [string, string])[] = [
  [
    "tools",
    `for t in ${HOME_NETWORK_TOOLS.join(" ")}; do if command -v "$t" >/dev/null; then echo "$t"; fi; done`,
  ],
  ["route4", "timeout 10 ip -j -4 route get 1.1.1.1"],
  ["route6", "timeout 10 ip -j -6 route show default"],
  ["addresses", "timeout 10 ip -j addr show"],
  ["cloudflare", `${CURL} ${CLOUDFLARE_TRACE_URL}`],
  ["aws", `${CURL} ${CHECKIP_URL}`],
  [
    "path",
    `if command -v tracepath >/dev/null; then
  echo tracepath
  timeout 20 tracepath -n -m 3 1.1.1.1
elif command -v traceroute >/dev/null; then
  echo traceroute
  timeout 20 traceroute -n -q 1 -m 3 1.1.1.1
else
  false
fi`,
  ],
];

/** The read-only script {@link detectHomeNetwork} runs as the login. */
export function homeNetworkScript(): string {
  return sectionsScript("home-network", HOME_NETWORK_SECTIONS);
}

const Ipv4Schema = z.string().refine((value) => ipv4Value(value) !== null);

/** What {@link detectHomeNetwork} returns (data model 3). */
export const HomeNetworkSchema = z.strictObject({
  /** The address, network prefix, interface and gateway of the IPv4 route out; none without it. */
  lan: z
    .strictObject({
      address: Ipv4Schema,
      prefix: z.number().int().min(0).max(32),
      interface: z.string().min(1),
      gateway: Ipv4Schema.optional(),
    })
    .optional(),
  ipv4: z.strictObject({
    /** The server has an IPv4 route to the internet. */
    route: z.boolean(),
    /** The public IPv4 each source saw; absent when it gave no public IPv4 address. */
    cloudflare: Ipv4Schema.optional(),
    aws: Ipv4Schema.optional(),
    /**
     * An IPv4 address on the server's own interfaces equal to the one the sources agree on, else
     * one in 100.64.0.0/10 (carrier-grade NAT).
     */
    interface: Ipv4Schema.optional(),
  }),
  ipv6: z.strictObject({
    /** `unknown` when `ip -6` could not be read. */
    state: z.enum(["present", "absent", "unknown"]),
    /** The stable global address of the IPv6 default route's interface. */
    stable: z
      .string()
      .refine((value) => ipv6Value(value) !== null)
      .optional(),
  }),
  /** The first hops' addresses (at most 3), empty without tracepath or traceroute. */
  hops: z.array(Ipv4Schema).max(3),
  tools: z.array(z.enum(HOME_NETWORK_TOOLS)),
});
export type HomeNetwork = z.infer<typeof HomeNetworkSchema>;

/**
 * The home's public IPv4 by the two-source rule (research R3): when both sources answered and
 * differ it is unknown (undefined); when one answered, that one.
 */
export function agreedIpv4(
  ipv4: Pick<HomeNetwork["ipv4"], "cloudflare" | "aws">,
): string | undefined {
  if (ipv4.cloudflare !== undefined && ipv4.aws !== undefined && ipv4.cloudflare !== ipv4.aws) {
    return undefined;
  }
  return ipv4.cloudflare ?? ipv4.aws;
}

const RouteSchema = z.object({
  dev: z.string().optional(),
  prefsrc: z.string().optional(),
  gateway: z.string().optional(),
  metric: z.number().optional(),
});

const LinkSchema = z.object({ ifname: z.string(), addr_info: z.array(z.unknown()).default([]) });

const AddressSchema = z.object({
  family: z.enum(["inet", "inet6"]),
  local: z.string(),
  prefixlen: z.number().int(),
  scope: z.string().optional(),
  temporary: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  tentative: z.boolean().optional(),
  dadfailed: z.boolean().optional(),
  preferred_life_time: z.number().optional(),
});
type Address = z.infer<typeof AddressSchema> & { ifname: string };

/** The valid items of an `ip -j` array (it may print `{}` placeholders), or undefined. */
function items<T>(text: string | undefined, schema: z.ZodType<T>): T[] | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** A source's answer when it is a public IPv4 address, else undefined (no answer). */
function publicIpv4(answer: string | undefined): string | undefined {
  const value = answer?.trim();
  return value !== undefined && ipv4Value(value) !== null && isPublicAddress(value)
    ? value
    : undefined;
}

/** The first hops' addresses from `tracepath -n` or `traceroute -n` (the tool on the first line). */
export function parsePath(text: string): string[] {
  const [tool, ...lines] = linesOf(text);
  if (tool !== "tracepath" && tool !== "traceroute") return [];
  const hops = new Map<number, string>();
  for (const line of lines) {
    const match = /^(\d+)\??:?\s+(\S+)/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const hop = Number(match[1]);
    if (hop < 1 || hop > 3 || hops.has(hop) || ipv4Value(match[2]) === null) continue;
    hops.set(hop, match[2]);
  }
  return [...hops].sort(([a], [b]) => a - b).map(([, address]) => address);
}

/**
 * The stable global IPv6 address of the interface the lowest-metric default route uses: not
 * temporary, deprecated, tentative or failed, and not unique-local; of several, the longest
 * preferred lifetime, then the lowest address.
 */
function stableIpv6(
  routes: z.infer<typeof RouteSchema>[],
  addresses: readonly Address[],
): string | undefined {
  const route = [...routes]
    .filter((entry) => entry.dev !== undefined)
    .sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))[0];
  if (route === undefined) return undefined;
  const value = (address: Address) => ipv6Value(address.local) ?? 0n;
  return addresses
    .filter(
      (address) =>
        address.family === "inet6" &&
        address.ifname === route.dev &&
        address.scope === "global" &&
        !address.temporary &&
        !address.deprecated &&
        !address.tentative &&
        !address.dadfailed &&
        ipv6Value(address.local) !== null &&
        isPublicAddress(address.local),
    )
    .sort(
      (a, b) =>
        (b.preferred_life_time ?? 0) - (a.preferred_life_time ?? 0) ||
        (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0),
    )[0]?.local;
}

/** Builds the {@link HomeNetwork} from the script's output. Exported for tests. */
export function parseHomeNetwork(output: string): HomeNetwork {
  const sections = splitSections(output);
  const ok = (name: string) => {
    const found = sections.get(name);
    return found?.exit === 0 ? found.text : undefined;
  };
  const links = items(ok("addresses"), LinkSchema);
  const addresses: Address[] = (links ?? []).flatMap((link) =>
    link.addr_info.flatMap((info) => {
      const parsed = AddressSchema.safeParse(info);
      return parsed.success ? [{ ...parsed.data, ifname: link.ifname }] : [];
    }),
  );

  const route4 = items(ok("route4"), RouteSchema)?.[0];
  const lanAddress = addresses.find(
    (address) =>
      address.family === "inet" &&
      address.ifname === route4?.dev &&
      address.local === route4.prefsrc,
  );
  const gateway = route4?.gateway;
  const lan =
    lanAddress === undefined || ipv4Value(lanAddress.local) === null
      ? undefined
      : {
          address: lanAddress.local,
          prefix: lanAddress.prefixlen,
          interface: lanAddress.ifname,
          ...(gateway !== undefined && ipv4Value(gateway) !== null ? { gateway } : {}),
        };

  const cloudflare = publicIpv4(/^ip=(.*)$/m.exec(ok("cloudflare") ?? "")?.[1]);
  const aws = publicIpv4(linesOf(ok("aws") ?? "")[0]);
  const seen = agreedIpv4({ cloudflare, aws });
  const own = addresses.filter(
    (address) =>
      address.family === "inet" &&
      !isVirtualInterface(address.ifname) &&
      ipv4Value(address.local) !== null,
  );
  const onInterface =
    own.find((address) => address.local === seen)?.local ??
    own.find((address) => networkHolds("100.64.0.0/10", address.local))?.local;

  const routes6 = items(ok("route6"), RouteSchema);
  const stable =
    routes6 === undefined || links === undefined ? undefined : stableIpv6(routes6, addresses);
  const ipv6State =
    routes6 === undefined || links === undefined ? "unknown" : stable ? "present" : "absent";

  const tools = linesOf(ok("tools") ?? "").filter((tool) =>
    (HOME_NETWORK_TOOLS as readonly string[]).includes(tool),
  );
  return HomeNetworkSchema.parse({
    ...(lan === undefined ? {} : { lan }),
    ipv4: {
      route: route4 !== undefined,
      ...(cloudflare === undefined ? {} : { cloudflare }),
      ...(aws === undefined ? {} : { aws }),
      ...(onInterface === undefined ? {} : { interface: onInterface }),
    },
    ipv6: { state: ipv6State, ...(stable === undefined ? {} : { stable }) },
    hops: parsePath(sections.get("path")?.text ?? ""),
    tools,
  });
}

/**
 * Reads the home's network from the server with one fixed, read-only script as the login (no
 * root): the LAN (`ip -j`), the public IPv4 from Cloudflare's trace and from checkip every time,
 * the stable global IPv6 address, and up to three hops (`tracepath`, else `traceroute`). A probe
 * that fails or times out gives its "unknown" value; only a server that cannot be reached throws
 * (COMMAND_FAILED). Nothing is written on the server.
 */
export async function detectHomeNetwork(remote: RemoteExec): Promise<HomeNetwork> {
  let stdout: string;
  try {
    ({ stdout } = await remote.run(asLogin(homeNetworkScript()), { timeoutMs: 120_000 }));
  } catch (error) {
    throw new OpsCrewError("COMMAND_FAILED", "OpsCrew could not read the home network's state.", {
      hint: "Check that the server is reachable over SSH with your key, then try again.",
      cause: error,
    });
  }
  if (!stdout.includes(SECTION_MARK)) {
    throw new OpsCrewError("COMMAND_FAILED", "OpsCrew could not read the home network's state.", {
      hint: "Check that the login has a POSIX shell (sh, bash or zsh) and try again.",
    });
  }
  return parseHomeNetwork(stdout);
}

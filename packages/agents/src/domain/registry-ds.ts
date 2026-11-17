import { randomInt } from "node:crypto";
import { createSocket } from "node:dgram";
import { resolve4, resolveNs } from "node:dns/promises";
import type { DsRecord } from "@opscrew/contracts";
import { normalizeHostName } from "@opscrew/core";
import { z } from "zod";

/**
 * A domain's DS records as the registry publishes them, read from the parent zone's own
 * nameservers (for `opscrew.dev`, the `dev` zone's). A caching resolver only shows its copy and
 * the time that copy has left; the registry's answer is what it publishes now, with the full TTL
 * every resolver caches the records with.
 */
export type RegistryDsTtl =
  /** The registry publishes these DS records for the domain, with this TTL (seconds). */
  | { kind: "published"; ttlSeconds: number; records: DsRecord[] }
  /**
   * The registry publishes none; `changedAt` when its public record (RDAP) says the domain is not
   * signed: the domain's last change there, at or after the DS record's removal.
   */
  | { kind: "none"; changedAt?: string }
  /** No nameserver gave a readable answer (UDP port 53 blocked, timeouts, a truncated answer …). */
  | { kind: "unreadable" };

/** Asks the registry for a domain's DS record (`registryDsLookup`); never throws. */
export type RegistryDsLookup = (domain: string) => Promise<RegistryDsTtl>;

/** What asking the registry needs from the network (`nodeRegistryNetwork`; a fake in tests). */
export interface RegistryNetwork {
  /** The IPv4 addresses of `zone`'s nameservers. */
  nameserverAddresses(zone: string): Promise<string[]>;
  /** Sends `query` to `address` on UDP port 53; the first reply from there, or a rejection. */
  exchange(address: string, query: Uint8Array): Promise<Uint8Array>;
  /** A random 16-bit query id. */
  randomId(): number;
  /** The registry's RDAP record of `domain` (parsed JSON); rejects when it cannot be read. */
  rdapRecord?(domain: string): Promise<unknown>;
}

const RdapDomainSchema = z.object({
  secureDNS: z.object({ delegationSigned: z.boolean() }).optional(),
  events: z.array(z.object({ eventAction: z.string(), eventDate: z.string() })).optional(),
});

const RdapBootstrapSchema = z.object({
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])),
});

/**
 * The domain's last change at the registry (RDAP's `last changed` event) when its RDAP record says
 * it is not signed; undefined when it is signed, says nothing, or cannot be read.
 */
export function rdapUnsignedSince(record: unknown): string | undefined {
  const parsed = RdapDomainSchema.safeParse(record);
  if (!parsed.success || parsed.data.secureDNS?.delegationSigned !== false) return undefined;
  const changed = parsed.data.events?.find((e) => e.eventAction === "last changed")?.eventDate;
  return changed !== undefined && !Number.isNaN(Date.parse(changed)) ? changed : undefined;
}

/** `none`, with the registry's change time when its RDAP record gives one (`rdapUnsignedSince`). */
async function noneSince(network: RegistryNetwork, name: string): Promise<RegistryDsTtl> {
  try {
    const changedAt = rdapUnsignedSince(await network.rdapRecord?.(name));
    return changedAt === undefined ? { kind: "none" } : { kind: "none", changedAt };
  } catch {
    return { kind: "none" };
  }
}

const DS_TYPE = 43;
const IN_CLASS = 1;
const UNREADABLE: RegistryDsTtl = { kind: "unreadable" };
/** How many of the parent zone's nameservers are asked at most, one after the other. */
const MAX_NAMESERVERS = 3;
/** How long one nameserver gets to answer (milliseconds). */
const TIMEOUT_MS = 2000;

/** The DNS query (wire format) for `name`'s DS record, without recursion (RFC 1035 4.1). */
export function dsQuery(name: string, id: number): Uint8Array {
  const labels = normalizeHostName(name).split(".");
  const bytes = [(id >> 8) & 0xff, id & 0xff, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const label of labels) bytes.push(label.length, ...Buffer.from(label, "ascii"));
  bytes.push(0, 0, DS_TYPE, 0, IN_CLASS);
  return Uint8Array.from(bytes);
}

/** A reader over a DNS message that throws on anything outside it or malformed. */
class Message {
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u16(at: number): number {
    return this.view.getUint16(at);
  }

  u32(at: number): number {
    return this.view.getUint32(at);
  }

  /** The (lower-case) name at `at` and the offset after it, following compression pointers. */
  name(at: number): { name: string; next: number } {
    const labels: string[] = [];
    let offset = at;
    let next: number | undefined;
    for (let jumps = 0; ; ) {
      const length = this.view.getUint8(offset);
      if ((length & 0xc0) === 0xc0) {
        if (++jumps > 16) throw new Error("compression loop");
        next ??= offset + 2;
        offset = this.u16(offset) & 0x3fff;
        continue;
      }
      if (length > 63) throw new Error("bad label");
      if (length === 0) break;
      if (offset + 1 + length > this.bytes.length) throw new Error("cut off");
      labels.push(
        Buffer.from(this.bytes.subarray(offset + 1, offset + 1 + length)).toString("ascii"),
      );
      offset += 1 + length;
    }
    return { name: labels.join(".").toLowerCase(), next: next ?? offset + 1 };
  }
}

/**
 * The DS records in a nameserver's answer to `dsQuery(name, id)`, with the longest TTL among them;
 * `none` when the authoritative answer has none (or the name does not exist), and `unreadable` for
 * anything else: another id, not an authoritative answer, a truncated answer, another question,
 * an error code or a malformed packet (a DS record without a digest among them).
 */
export function readDsAnswer(packet: Uint8Array, id: number, name: string): RegistryDsTtl {
  const want = normalizeHostName(name);
  try {
    const m = new Message(packet);
    const flags = m.u16(2);
    const answer = (flags & 0x8000) !== 0;
    const opcode = (flags >> 11) & 0x0f;
    const authoritative = (flags & 0x0400) !== 0;
    const truncated = (flags & 0x0200) !== 0;
    const rcode = flags & 0x0f;
    if (m.u16(0) !== id || !answer || opcode !== 0 || !authoritative || truncated) {
      return UNREADABLE;
    }
    if (rcode !== 0 && rcode !== 3) return UNREADABLE;
    if (m.u16(4) !== 1) return UNREADABLE;
    const question = m.name(12);
    const qtype = m.u16(question.next);
    const qclass = m.u16(question.next + 2);
    if (question.name !== want || qtype !== DS_TYPE || qclass !== IN_CLASS) return UNREADABLE;
    let offset = question.next + 4;
    let ttl: number | undefined;
    const records: DsRecord[] = [];
    for (let i = m.u16(6); i > 0; i--) {
      const owner = m.name(offset);
      const type = m.u16(owner.next);
      const rrClass = m.u16(owner.next + 2);
      const rrTtl = m.u32(owner.next + 4);
      const length = m.u16(owner.next + 8);
      offset = owner.next + 10 + length;
      if (offset > packet.length) return UNREADABLE;
      if (owner.name === want && type === DS_TYPE && rrClass === IN_CLASS) {
        // RFC 4034 5.1: key tag, algorithm, digest type, then the digest.
        const data = owner.next + 10;
        if (length <= 4) return UNREADABLE;
        records.push({
          keyTag: m.u16(data),
          algorithm: packet[data + 2] as number,
          digestType: packet[data + 3] as number,
          digest: Buffer.from(packet.subarray(data + 4, offset))
            .toString("hex")
            .toUpperCase(),
        });
        ttl = Math.max(ttl ?? 0, rrTtl);
      }
    }
    return ttl === undefined ? { kind: "none" } : { kind: "published", ttlSeconds: ttl, records };
  } catch {
    return UNREADABLE;
  }
}

/**
 * The registry's DS record of a domain, asked over `network`: the parent zone's nameservers (at
 * most three, one after the other) until one gives a readable answer (`readDsAnswer`);
 * `unreadable` when none does.
 */
export function registryDsLookup(
  network: RegistryNetwork = nodeRegistryNetwork(),
): RegistryDsLookup {
  return async (domain) => {
    const name = normalizeHostName(domain);
    const parent = name.split(".").slice(1).join(".");
    if (parent === "") return UNREADABLE;
    let addresses: string[];
    try {
      addresses = await network.nameserverAddresses(parent);
    } catch {
      return UNREADABLE;
    }
    for (const address of addresses.slice(0, MAX_NAMESERVERS)) {
      const id = network.randomId();
      let reply: Uint8Array;
      try {
        reply = await network.exchange(address, dsQuery(name, id));
      } catch {
        continue;
      }
      const read = readDsAnswer(reply, id, name);
      if (read.kind === "none") return noneSince(network, name);
      if (read.kind !== "unreadable") return read;
    }
    return UNREADABLE;
  };
}

/**
 * The real network: the parent zone's nameservers through the system's resolver (`node:dns`),
 * then one UDP datagram to each (`node:dgram`), waiting `TIMEOUT_MS` for its reply.
 */
export function nodeRegistryNetwork(): RegistryNetwork {
  return {
    async nameserverAddresses(zone) {
      const names = await resolveNs(zone);
      const found = await Promise.all(names.map((n) => resolve4(n).catch(() => [] as string[])));
      return [...new Set(found.flat())];
    },
    exchange: (address, query) =>
      new Promise((resolve, reject) => {
        const socket = createSocket("udp4");
        const end = (settle: () => void) => {
          clearTimeout(timer);
          socket.close();
          settle();
        };
        const timer = setTimeout(() => end(() => reject(new Error("timed out"))), TIMEOUT_MS);
        socket.on("message", (message, from) => {
          if (from.address === address && from.port === 53) end(() => resolve(message));
        });
        socket.once("error", (error) => end(() => reject(error)));
        socket.send(query, 53, address);
      }),
    randomId: () => randomInt(0x10000),
    // The TLD's RDAP server from IANA's bootstrap file (RFC 9224), then the domain's record there.
    async rdapRecord(domain) {
      const signal = () => AbortSignal.timeout(TIMEOUT_MS * 3);
      const tld = domain.split(".").at(-1) ?? "";
      const bootstrap = RdapBootstrapSchema.parse(
        await (await fetch("https://data.iana.org/rdap/dns.json", { signal: signal() })).json(),
      );
      const base = bootstrap.services
        .find(([tlds]) => tlds.includes(tld))?.[1]
        .find((url) => url.startsWith("https://"));
      if (base === undefined) throw new Error(`no RDAP server for .${tld}`);
      const url = new URL(`domain/${domain}`, base.endsWith("/") ? base : `${base}/`);
      const response = await fetch(url, {
        headers: { accept: "application/rdap+json" },
        signal: signal(),
      });
      if (!response.ok) throw new Error(`RDAP answered ${response.status}`);
      return response.json();
    },
  };
}

// T2941: the adoption check after the finish's imports lets the DNS records' one-time rename to
// their count's index (`a` → `a[0]`, `aaaa` → `aaaa[0]`, T2907) through, and no other rename.
import type { ResourceChange, ResourceMove } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { adoptionCheck } from "./shadow-plans";
import type { MoveSession, ShadowRoot } from "./types";

const session = {
  environments: [{ environment: "prod", plan: { app: { name: "example-app" } } }],
  accounts: { b: { accountId: "b-account" } },
  command: "opscrew cloudflare move --finish",
} as unknown as MoveSession;
const root = { name: "main", environment: "prod" } as unknown as ShadowRoot;

const move = (from: string, to: string): ResourceMove => ({
  from,
  to,
  type: "cloudflare_dns_record",
});
const renamed = [
  move("module.dns.cloudflare_dns_record.a", "module.dns.cloudflare_dns_record.a[0]"),
  move("module.dns.cloudflare_dns_record.aaaa", "module.dns.cloudflare_dns_record.aaaa[0]"),
];
const update: ResourceChange = {
  address: "module.dns.cloudflare_dns_record.a[0]",
  type: "cloudflare_dns_record",
  name: "a",
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  action: "update",
};

describe("adoptionCheck", () => {
  const check = adoptionCheck(session, root);

  it("passes a plan whose only renames are the DNS records' to a[0] and aaaa[0]", () => {
    expect(() => check({ changes: [], moves: renamed })).not.toThrow();
    expect(() => check({ changes: [update], moves: renamed })).not.toThrow();
  });

  it("still refuses any other rename beside them", () => {
    const other = move(
      "module.dns.cloudflare_dns_record.caa",
      "module.dns.cloudflare_dns_record.caa_previous",
    );
    expect(() => check({ changes: [], moves: [...renamed, other] })).toThrow(
      /would do more than update Cloudflare pieces in place[\s\S]*move .*caa → .*caa_previous/,
    );
  });
});

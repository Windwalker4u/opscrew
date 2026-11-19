/** Offline checks of the shared-server live pass's pure helpers (`shared-server-support.ts`). */
import { AppKeySchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { isExample } from "./harness";
import {
  addressLeaks,
  dnsFacts,
  FIRST_EXAMPLE,
  factDigests,
  keptRate,
  keyLineDigests,
  loadSummary,
  otherAppRefused,
  SECOND_EXAMPLE,
  SHARED_SERVER_GATE,
  SHARED_SERVER_VARIABLES,
  sharedHosts,
  sharedNames,
  sortedLines,
} from "./shared-server-support";
import { missingVariables, newRunId } from "./support";
import type { ZoneRecord } from "./tls-support";

describe("the gate", () => {
  it("needs its gate, the Hetzner and Cloudflare tokens, the domain and repository C", () => {
    expect(missingVariables({}, SHARED_SERVER_GATE, SHARED_SERVER_VARIABLES)).toEqual([
      "OPSCREW_E2E_SHARED_SERVER=1",
      "OPSCREW_E2E_HCLOUD_TOKEN",
      "OPSCREW_E2E_GITHUB_REPO_C",
      "OPSCREW_E2E_GITHUB_TOKEN",
      "OPSCREW_E2E_CLOUDFLARE_TOKEN",
      "OPSCREW_E2E_DOMAIN",
    ]);
  });

  it("deploys two examples", () => {
    expect(isExample(FIRST_EXAMPLE)).toBe(true);
    expect(isExample(SECOND_EXAMPLE)).toBe(true);
  });
});

describe("the run's names", () => {
  it("names both apps and hostnames after the run's tag, one level below the zone, never e2e-", () => {
    expect(sharedNames("mhabc123deadbeef")).toEqual({
      tag: "deadbeef",
      firstApp: "j030-deadbeef-a",
      secondApp: "j030-deadbeef-b",
    });
    expect(sharedHosts("e2e.example.com", "deadbeef")).toEqual({
      firstHost: "j030-deadbeef-first.example.com",
      secondHost: "j030-deadbeef-second.example.com",
    });
    expect(sharedHosts("Example.com.", "deadbeef").secondHost).toBe(
      "j030-deadbeef-second.example.com",
    );
  });

  it("gives a second app key OpsCrew accepts, and no name that starts with the other's", () => {
    const names = sharedNames(newRunId());
    const hosts = sharedHosts("example.com", names.tag);
    expect(AppKeySchema.safeParse(names.secondApp).success).toBe(true);
    for (const name of [...Object.values(names), ...Object.values(hosts)]) {
      expect(name.startsWith("e2e-")).toBe(false);
    }
    expect(names.secondApp.startsWith(names.firstApp)).toBe(false);
    expect(names.firstApp.startsWith(names.secondApp)).toBe(false);
  });

  it("refuses a run id too short for a tag, and a domain with no zone", () => {
    expect(() => sharedNames("abc")).toThrow(/too short/);
    expect(() => sharedHosts("", "deadbeef")).toThrow(/Cannot derive a hostname/);
  });
});

describe("keyLineDigests", () => {
  it("hashes each line in order, never keeps a line, and ignores only the final newline", () => {
    const text = "ssh-ed25519 AAAA one\nssh-ed25519 BBBB two\n";
    const digests = keyLineDigests(text);
    expect(digests).toHaveLength(2);
    expect(digests.join("")).not.toContain("AAAA");
    expect(keyLineDigests("ssh-ed25519 AAAA one\r\nssh-ed25519 BBBB two")).toEqual(digests);
    expect(keyLineDigests("ssh-ed25519 BBBB two\nssh-ed25519 AAAA one\n")).toEqual(
      [...digests].reverse(),
    );
    // A line that changed, or a blank line added, is a difference.
    expect(keyLineDigests("ssh-ed25519 AAAA one \nssh-ed25519 BBBB two\n")).not.toEqual(digests);
    expect(keyLineDigests("ssh-ed25519 AAAA one\n\nssh-ed25519 BBBB two\n")).toHaveLength(3);
  });
});

describe("otherAppRefused", () => {
  it("matches the second app's quoted name and the unchanged-state sentence only", () => {
    const refusal =
      'The server also runs "j030-deadbeef-b" (from github.com/you/c), and destroying the server would break it. Nothing was changed.';
    expect(otherAppRefused(refusal, "j030-deadbeef-b")).toBe(true);
    expect(otherAppRefused(refusal.replace(" Nothing was changed.", ""), "j030-deadbeef-b")).toBe(
      false,
    );
    expect(otherAppRefused(refusal, "j030-deadbeef-a")).toBe(false);
    expect(
      otherAppRefused(
        "Add --confirm j030-deadbeef-a: the deployment is deleted only with its own name. Nothing was changed.",
        "j030-deadbeef-b",
      ),
    ).toBe(false);
  });
});

describe("what a refused command must leave", () => {
  it("sorts lines and drops blank ones", () => {
    expect(sortedLines("b running\n\n a running \r\n")).toBe("a running\nb running");
  });

  it("keeps the DNS records of the hostnames and their www. only", () => {
    const records: ZoneRecord[] = [
      { id: "1", type: "A", name: "j030-x-first.example.com", content: "192.0.2.1", proxied: true },
      { id: "2", type: "AAAA", name: "www.j030-x-first.example.com", content: "2001:db8::1" },
      { id: "3", type: "A", name: "other.example.com", content: "192.0.2.9", proxied: true },
    ];
    const facts = dnsFacts(records, ["j030-x-first.example.com"]);
    expect(facts.split("\n")).toEqual([
      '["A","j030-x-first.example.com","192.0.2.1",true]',
      '["AAAA","www.j030-x-first.example.com","2001:db8::1",false]',
    ]);
    expect(dnsFacts([...records].reverse(), ["j030-x-first.example.com"])).toBe(facts);
  });

  it("digests each part by its name, never showing its text", () => {
    const digests = factDigests({ "the DNS records": "192.0.2.1", "the plan": "app: x" });
    expect(Object.keys(digests)).toEqual(["the DNS records", "the plan"]);
    expect(JSON.stringify(digests)).not.toContain("192.0.2.1");
    expect(digests["the plan"]).toMatch(/^[0-9a-f]{64}$/);
    expect(factDigests({ "the plan": "app: x" })["the plan"]).toBe(digests["the plan"]);
  });
});

describe("the load", () => {
  it("sums up the requests, the statuses and the failures without a host", () => {
    expect(
      loadSummary("the second app's provision", {
        sent: 600,
        seconds: 600.4,
        statuses: { "200": 599, "502": 1 },
        counted: [{ at: "2026-11-19T10:00:00.000Z", what: "HTTP 502" }],
        accepted: 0,
      }),
    ).toBe(
      "the second app's provision: 600 requests in 600 s to the first app's site, HTTP 200 ×599, HTTP 502 ×1; 1 failed",
    );
    expect(
      loadSummary("the destroy", {
        sent: 0,
        seconds: 0,
        statuses: {},
        counted: [],
        accepted: 2,
      }),
    ).toBe(
      "the destroy: 0 requests in 0 s to the first app's site, no answer; none failed, 2 accepted",
    );
  });

  it("asks for at least 90% of the rate", () => {
    expect(keptRate(90, 100)).toBe(true);
    expect(keptRate(89, 100)).toBe(false);
    expect(keptRate(0, 0.5)).toBe(true);
  });
});

describe("addressLeaks", () => {
  it("searches only the second app's outputs, and names labels only", () => {
    const addresses = [{ label: "server-ipv4", value: "203.0.113.7" }];
    const outputs = new Map([
      ["#1 opscrew provision --app . --env prod", "your server at 203.0.113.7"],
      ["#2 opscrew provision --app j030-x-b --env prod", "joined 203.0.113.7"],
      ["#3 opscrew design --app j030-x-b", "beside j030-x-a"],
      ["#4 opscrew verify --app j030-x-bc", "at 203.0.113.7"],
    ]);
    expect(addressLeaks(outputs, addresses, "j030-x-b")).toEqual([
      "the output of #2 opscrew provision --app j030-x-b --env prod contains: server-ipv4",
    ]);
  });
});

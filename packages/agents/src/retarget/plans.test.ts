import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanSummary, ResourceMove } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { SENSITIVE_VALUE } from "../provision";
import { savedPlanOf, writePlanSidecar } from "../provision/plan-apply";
import { isDnsRecordCountMove, planBounded } from "./plans";

describe("a move's saved plan sidecar", () => {
  it("never holds the prior state or a sensitive value in clear", async () => {
    const secret = fakeSecret("generic-password");
    const dir = await mkdtemp(join(tmpdir(), "opscrew-move-plan-"));
    const summary = {
      planHash: "a".repeat(64),
      planFile: join(dir, "x.tfplan"),
      dir,
      engine: "tofu",
      createdAt: "2026-10-14T00:00:00.000Z",
      changes: [],
      counts: { add: 0, change: 0, destroy: 1 },
      hasDestroy: true,
      planJson: {
        prior_state: { values: { outputs: { tunnel_token: { value: secret, sensitive: true } } } },
        resource_changes: [
          {
            address: "module.access.cloudflare_zero_trust_access_service_token.ssh",
            change: {
              actions: ["delete"],
              before: { client_secret: secret, name: "ssh" },
              after: null,
              before_sensitive: { client_secret: true },
              after_sensitive: false,
            },
          },
        ],
      },
    } as unknown as PlanSummary;
    await writePlanSidecar(new Redactor(), savedPlanOf(summary, []));
    const sidecar = await readFile(join(dir, "x.tfplan.json"), "utf8");
    expect(sidecar).not.toContain(secret);
    expect(sidecar).not.toContain("prior_state");
    expect(sidecar).toContain(SENSITIVE_VALUE);
  });
});

// T2941: the DNS module's A and AAAA records got a `count` (T2907), so every app with DNS on
// Cloudflare plans `a` → `a[0]` (and `aaaa` → `aaaa[0]`) once, as a state rename.
describe("the one-time rename of the DNS records to their count's index", () => {
  const move = (from: string, to: string): ResourceMove => ({
    from,
    to,
    type: "cloudflare_dns_record",
  });
  const A = move("module.dns.cloudflare_dns_record.a", "module.dns.cloudflare_dns_record.a[0]");
  const AAAA = move(
    "module.dns.cloudflare_dns_record.aaaa",
    "module.dns.cloudflare_dns_record.aaaa[0]",
  );
  const other = move(
    "module.server.hcloud_server.this",
    "module.server_previous.hcloud_server.this",
  );

  it("is exactly a → a[0] and aaaa → aaaa[0] under module.dns", () => {
    expect(isDnsRecordCountMove(A)).toBe(true);
    expect(isDnsRecordCountMove(AAAA)).toBe(true);
    for (const refused of [
      other,
      move("module.dns.cloudflare_dns_record.www", "module.dns.cloudflare_dns_record.www[0]"),
      move("module.dns.cloudflare_dns_record.a", "module.dns.cloudflare_dns_record.a[1]"),
      move("module.dns.cloudflare_dns_record.a[0]", "module.dns.cloudflare_dns_record.a"),
      move("module.dns.cloudflare_dns_record.a", "module.dns.cloudflare_dns_record.aaaa[0]"),
      move("module.pages.cloudflare_dns_record.a", "module.pages.cloudflare_dns_record.a[0]"),
      move("cloudflare_dns_record.a", "cloudflare_dns_record.a[0]"),
    ]) {
      expect(isDnsRecordCountMove(refused), `${refused.from} → ${refused.to}`).toBe(false);
    }
  });

  it("passes a check without moves alone and is still refused beside another move", () => {
    const check = planBounded({ lead: "The plan would do more.", hint: "" });
    expect(() => check({ changes: [], moves: [A, AAAA] })).not.toThrow();
    expect(() => check({ changes: [], moves: [A, other] })).toThrow(
      /would do more[\s\S]*move module\.server\.hcloud_server\.this/,
    );
    expect(() => check({ changes: [], moves: [A, other] })).not.toThrow(/cloudflare_dns_record/);
  });

  it("passes a check whose own moves refuse it", () => {
    const check = planBounded({ lead: "The plan would do more.", move: () => false, hint: "" });
    expect(() => check({ changes: [], moves: [A] })).not.toThrow();
    expect(() => check({ changes: [], moves: [AAAA, other] })).toThrow(/hcloud_server/);
  });
});

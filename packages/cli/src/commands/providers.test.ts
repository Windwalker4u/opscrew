import path from "node:path";
import { FAKE_SECRET_KINDS, type FakeSecretKind, fakeSecret } from "@opscrew/core/testing";
import { ProviderCatalogueSchema } from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { describe, expect, it } from "vitest";
import { main } from "../program";
import { createTestContext } from "../test-context";

const argv = (...args: string[]) => ["node", "opscrew", ...args];

/** Every provider's variables, set to secret-shaped values. */
function secretEnv(): Record<string, string> {
  const names = [
    ...CLOUD_PROVIDERS.flatMap(({ credentials }) => credentials.envVars),
    "CLOUDFLARE_API_TOKEN",
    "PORKBUN_API_KEY",
    "PORKBUN_SECRET_API_KEY",
    "NAMECHEAP_API_USER",
    "NAMECHEAP_API_KEY",
    "GODADDY_API_TOKEN",
    "GITHUB_TOKEN",
  ];
  return Object.fromEntries(
    names.map((name, i) => [
      name,
      fakeSecret(FAKE_SECRET_KINDS[i % FAKE_SECRET_KINDS.length] as FakeSecretKind),
    ]),
  );
}

/** A folder that holds no project: the command never reads one. */
const NO_PROJECT = path.join(process.cwd(), "no-such-project-folder");

describe("opscrew providers", () => {
  it("prints the catalogue with --json, with this version, reading no credential", async () => {
    const env = secretEnv();
    const ctx = createTestContext({ env, cwd: NO_PROJECT, version: "1.2.3" });
    expect(await main(argv("providers", "--json"), ctx)).toBe(0);
    const catalogue = ProviderCatalogueSchema.parse(JSON.parse(ctx.output));
    expect(catalogue.opscrewVersion).toBe("1.2.3");
    expect(catalogue.providers.map(({ kind, id }) => `${kind} ${id}`)).toEqual(
      expect.arrayContaining(CLOUD_PROVIDERS.map(({ id }) => `cloud-server ${id}`)),
    );
    for (const secret of Object.values(env)) expect(ctx.output).not.toContain(secret);

    const again = createTestContext({ cwd: NO_PROJECT, version: "1.2.3" });
    expect(await main(argv("providers", "--json"), again)).toBe(0);
    expect(again.output).toBe(ctx.output);
  });

  it("prints one line per provider, with no sign-up link", async () => {
    const env = secretEnv();
    const ctx = createTestContext({ env, cwd: NO_PROJECT });
    expect(await main(argv("providers"), ctx)).toBe(0);
    const lines = ctx.output.trimEnd().split("\n");
    expect(lines).toHaveLength(CLOUD_PROVIDERS.length + 5);
    expect(lines[0]).toMatch(/^hetzner\s+cloud-server\s+Hetzner Cloud: HCLOUD_TOKEN$/);
    expect(lines).toContain(
      "porkbun       registrar     Porkbun: PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY",
    );
    expect(ctx.output).not.toMatch(/sign-?up|register|https?:/i);
    for (const secret of Object.values(env)) expect(ctx.output).not.toContain(secret);
  });
});

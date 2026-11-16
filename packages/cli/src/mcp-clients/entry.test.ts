import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_VARIABLES } from "./entry";

describe("CREDENTIAL_VARIABLES", () => {
  it("starts with every cloud provider's credential variables and names each variable once", () => {
    const providers = CLOUD_PROVIDERS.flatMap((provider) => provider.credentials.envVars);
    expect(providers).toContain("HCLOUD_TOKEN");
    expect(CREDENTIAL_VARIABLES.slice(0, providers.length)).toEqual(providers);
    expect(new Set(CREDENTIAL_VARIABLES).size).toBe(CREDENTIAL_VARIABLES.length);
    for (const name of CREDENTIAL_VARIABLES) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("names the variables OpsCrew's tools read, and no AWS login (nothing reads one)", () => {
    expect(CREDENTIAL_VARIABLES).toEqual(
      expect.arrayContaining([
        "CLOUDFLARE_API_TOKEN",
        "GITHUB_TOKEN",
        "OPSCREW_HOSTING_URL",
        "OPSCREW_SFTP_HOST",
        "OPSCREW_CLOUDFLARE_DEPLOY_TOKEN",
        "OPSCREW_GHCR_READ_TOKEN",
        "OPSCREW_CHECK_WEBHOOK",
        "OPSCREW_NEW_CLOUDFLARE_API_TOKEN",
        "OPSCREW_HOME",
      ]),
    );
    expect(CREDENTIAL_VARIABLES.filter((name) => name.startsWith("AWS_"))).toEqual([]);
  });
});

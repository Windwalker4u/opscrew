import { GIT_PLATFORM_CONTRACT_VERSION } from "@opscrew/contracts";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  detectGitPlatform,
  GIT_PLATFORMS,
  gitPlatform,
  gitPlatformByCicdProvider,
  parseGitRemote,
  validateGitPlatform,
} from "./index";

describe("@opscrew/git-platforms registry conformance", () => {
  it("registers unique valid platform ids, cicd providers, and registry ids", () => {
    expect(GIT_PLATFORMS.length).toBeGreaterThanOrEqual(1);
    expect(new Set(GIT_PLATFORMS.map((p) => p.id)).size).toBe(GIT_PLATFORMS.length);
    expect(new Set(GIT_PLATFORMS.map((p) => p.cicdProvider)).size).toBe(GIT_PLATFORMS.length);
    expect(new Set(GIT_PLATFORMS.map((p) => p.registryId)).size).toBe(GIT_PLATFORMS.length);

    for (const platform of GIT_PLATFORMS) {
      expect(platform.contractVersion).toBe(GIT_PLATFORM_CONTRACT_VERSION);
      expect(validateGitPlatform(platform)).toBe(platform);
      expect(gitPlatform(platform.id)).toBe(platform);
      expect(gitPlatformByCicdProvider(platform.cicdProvider)).toBe(platform);

      // Every platform parses its own canonical HTTPS and SSH URLs on defaultHost.
      const httpsUrl = `https://${platform.defaultHost}/acme/shop.git`;
      const sshUrl = `git@${platform.defaultHost}:acme/shop.git`;
      for (const url of [httpsUrl, sshUrl]) {
        const detected = detectGitPlatform(url);
        expect(detected?.platform.id).toBe(platform.id);
        expect(detected?.remote.owner).toBe("acme");
        expect(detected?.remote.repo).toBe("shop");
        expect(detected?.remote.fullPath).toBe("acme/shop");
        expect(parseGitRemote(url)).toEqual(detected?.remote);
      }

      // Container image helper always produces lower-case names.
      const image = platform.containerImage({ host: platform.defaultHost, fullPath: "Acme/Shop" });
      expect(image).toBe(image.toLowerCase());
      expect(image).toContain("acme/shop");
    }
  });

  it("matches plan-schema's cicd.provider and cicd.registry enums", () => {
    for (const platform of GIT_PLATFORMS) {
      const parsed = DeployPlanSchema.safeParse({
        schemaVersion: 1,
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T00:00:00.000Z",
        app: { name: "shop", port: 3000, healthPath: "/health", env: [] },
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "nbg1",
          serverType: "cx23",
          backups: true,
        },
        services: [],
        externalServices: [],
        cost: {
          monthly: { amount: 5, currency: "EUR" },
          breakdown: [{ item: "server", monthly: { amount: 5, currency: "EUR" } }],
          pricesIncludeVat: false,
          source: "static",
          asOf: "2026-11-26T00:00:00.000Z",
        },
        codeChanges: [],
        infra: {},
        dns: { provider: "none", proxied: false },
        cicd: { provider: platform.cicdProvider, registry: platform.registryId, branch: "main" },
        security: {},
      });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it("throws INVALID_INPUT for unknown platform or CI/CD provider ids", () => {
    expect(() => gitPlatform("unknown")).toThrow(/does not support the git platform "unknown"/);
    expect(() => gitPlatformByCicdProvider("unknown-ci")).toThrow(
      /does not recognise the CI\/CD provider "unknown-ci"/,
    );
  });
});

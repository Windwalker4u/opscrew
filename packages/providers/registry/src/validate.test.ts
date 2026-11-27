import { OpsCrewError } from "@opscrew/core";
import { definition as hetzner } from "@opscrew/provider-hetzner";
import { describe, expect, it } from "vitest";
import { CLOUD_PROVIDERS } from "./index";
import { validateCloudProvider } from "./validate";

const { credentials, regions, terraform } = hetzner;
const { resizeOffline: _resizeOffline, ...withoutResize } = hetzner.texts;

/** The message `validateCloudProvider` throws for `candidate`. */
function failure(candidate: unknown): string {
  try {
    validateCloudProvider(candidate);
  } catch (error) {
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("INTERNAL");
    return (error as OpsCrewError).message;
  }
  throw new Error("the definition passed validation");
}

describe("validateCloudProvider", () => {
  it("returns a valid definition itself", () => {
    expect(validateCloudProvider(hetzner)).toBe(hetzner);
  });

  it("accepts the optional branches a provider such as Contabo uses", () => {
    const { livePricesVar: _livePricesVar, ...design } = hetzner.texts.design;
    const contabo = {
      ...hetzner,
      credentials: { ...credentials, mode: "all", tokenRules: [] },
      offering: {
        ...hetzner.offering,
        billing: { model: "monthly", setupFee: true },
        snapshots: { kind: "included" },
        removal: { kind: "cancel-at-term-end", minimumTermMonths: 1 },
        resize: false,
      },
      texts: { ...withoutResize, design },
    };
    expect(validateCloudProvider(contabo)).toBe(contabo);
  });

  it("accepts both first-boot kinds, and refuses any other", () => {
    const cloudInit = { ...hetzner, terraform: { ...terraform, firstBoot: "cloud-init" } };
    expect(validateCloudProvider(cloudInit)).toBe(cloudInit);
    const script = { ...hetzner, terraform: { ...terraform, firstBoot: "script" } };
    expect(validateCloudProvider(script)).toBe(script);
    expect(failure({ ...hetzner, terraform: { ...terraform, firstBoot: "startup" } })).toContain(
      "terraform.firstBoot",
    );
  });

  it("wants the resize downtime exactly when the provider resizes in place", () => {
    expect(failure({ ...hetzner, texts: withoutResize })).toContain(
      "texts.resizeOffline: is needed exactly when offering.resize is true",
    );
    expect(failure({ ...hetzner, offering: { ...hetzner.offering, resize: false } })).toContain(
      "texts.resizeOffline: is needed exactly when offering.resize is true",
    );
  });

  it("refuses another contract version", () => {
    const message = failure({ ...hetzner, contractVersion: 2 });
    expect(message).toContain('The cloud provider definition "hetzner" is not valid');
    expect(message).toContain("contractVersion");
  });

  it("names a missing part", () => {
    const { texts: _texts, ...rest } = hetzner;
    expect(failure(rest)).toContain("texts:");
  });

  it("names a missing field within a part", () => {
    const { apiPattern: _apiPattern, ...rest } = credentials;
    expect(failure({ ...hetzner, credentials: rest })).toContain("credentials.apiPattern:");
  });

  it("names a definition without an id", () => {
    const { id: _id, ...rest } = hetzner;
    const message = failure(rest);
    expect(message).toContain("A cloud provider definition without an id is not valid");
    expect(message).toContain("id:");
  });

  it("wants functions as functions", () => {
    expect(failure({ ...hetzner, connector: "hetzner" })).toContain(
      "connector: must be a function",
    );
  });

  it("wants the billing facts: the model, how an hourly one counts, the setup fee", () => {
    const { billing: _billing, ...withoutBilling } = hetzner.offering;
    expect(failure({ ...hetzner, offering: withoutBilling })).toContain("offering.billing:");
    const hourlyUncounted = { ...hetzner.offering, billing: { model: "hourly", setupFee: false } };
    expect(failure({ ...hetzner, offering: hourlyUncounted })).toContain(
      "offering.billing.counts:",
    );
    const noSetupFee = { ...hetzner.offering, billing: { model: "monthly" } };
    expect(failure({ ...hetzner, offering: noSetupFee })).toContain("offering.billing.setupFee:");
  });

  it("wants a per-GB snapshot price a month and an hour, the hour's not above the month's", () => {
    const priced = (snapshots: unknown) => ({
      ...hetzner,
      offering: { ...hetzner.offering, snapshots },
    });
    expect(failure(priced({ kind: "per-gb" }))).toContain("offering.snapshots.perGbMonth:");
    expect(failure(priced({ kind: "per-gb", perGbMonth: 0.06 }))).toContain(
      "offering.snapshots.perGbHour:",
    );
    expect(failure(priced({ kind: "per-gb", perGbMonth: 0.06, perGbHour: 0.07 }))).toContain(
      "offering.snapshots.perGbHour: must not be more than perGbMonth",
    );
    expect(failure(priced({ kind: "per-gb", perGbMonth: -1, perGbHour: 0 }))).toContain(
      "offering.snapshots.perGbMonth:",
    );
  });

  it("wants regular expressions as RegExps", () => {
    const offering = { ...hetzner.offering, unavailable: "out of stock" };
    expect(failure({ ...hetzner, offering })).toContain("offering.unavailable:");
  });

  it("refuses a region OpsCrew does not have", () => {
    const locations = { ...regions.locations, "mars-north": ["nbg1"] };
    const message = failure({ ...hetzner, regions: { ...regions, locations } });
    expect(message).toContain("regions.locations:");
    expect(message).toContain("mars-north");
  });

  it("wants every OpsCrew region mapped", () => {
    const { "us-west": _usWest, ...locations } = regions.locations;
    const message = failure({ ...hetzner, regions: { ...regions, locations } });
    expect(message).toContain("regions.locations.us-west: maps no location");
  });

  it("refuses a region mapped to no location", () => {
    const locations = { ...regions.locations, "us-west": [] };
    const message = failure({ ...hetzner, regions: { ...regions, locations } });
    expect(message).toContain("regions.locations.us-west: maps no location");
  });

  it("wants token patterns global", () => {
    const [rule] = credentials.tokenRules;
    const tokenRules = [{ ...rule, pattern: new RegExp(rule?.pattern.source ?? "") }];
    const message = failure({ ...hetzner, credentials: { ...credentials, tokenRules } });
    expect(message).toContain(
      "credentials.tokenRules.0.pattern: must be a global regular expression",
    );
  });

  it("wants a name and coordinates for every location it maps", () => {
    const locations = { ...regions.locations, "eu-central": ["nbg1", "xyz1"] };
    const message = failure({ ...hetzner, regions: { ...regions, locations } });
    expect(message).toContain("regions.locationNames.xyz1: names no location xyz1");
    expect(message).toContain("regions.coordinates.xyz1: has no coordinates for xyz1");
  });

  it("wants module files", () => {
    const module = { ...terraform.module, files: {} };
    const message = failure({ ...hetzner, terraform: { ...terraform, module } });
    expect(message).toContain("terraform.module.files: has no files");
  });

  it("refuses a module's own cloud-init", () => {
    const files = { ...terraform.module.files, "cloud-init.yaml.tftpl": "#cloud-config\n" };
    const module = { ...terraform.module, files };
    const message = failure({ ...hetzner, terraform: { ...terraform, module } });
    expect(message).toContain("terraform.module.files.cloud-init.yaml.tftpl:");
  });

  it.each(["signupUrl", "pricingUrl"] as const)(
    "wants a plain https %s, never one with a referral id, when it has one",
    (field) => {
      const { [field]: _url, ...without } = hetzner;
      expect(validateCloudProvider(without)).toBe(without);
      expect(failure({ ...hetzner, [field]: "http://example.com/page" })).toContain(
        `${field}: must be an https:// URL`,
      );
      for (const url of [
        "https://example.com/page?ref=abc",
        "https://example.com/page?aff=1",
        "https://example.com/page#ref=abc",
      ]) {
        expect(failure({ ...hetzner, [field]: url })).toContain(
          `${field}: must have no query string or fragment`,
        );
      }
    },
  );

  it("wants at least one credential variable", () => {
    const message = failure({ ...hetzner, credentials: { ...credentials, envVars: [] } });
    expect(message).toContain("credentials.envVars:");
  });

  it("wants a firewall the connector applies described as terraform_data.firewall", () => {
    const wanted = { ...terraform, connectorFirewall: true };
    expect(failure({ ...hetzner, terraform: wanted })).toContain(
      "terraform.firewallResourceType: must be terraform_data.firewall with connectorFirewall",
    );
    const described = { ...wanted, firewallResourceType: "terraform_data.firewall" };
    expect(validateCloudProvider({ ...hetzner, terraform: described })).toBeDefined();
  });

  it("wants login caches within the home folder", () => {
    for (const path of ["", "/etc/token", "C:/token", "..\\token", ".cache/../../token"]) {
      const homeCacheFiles = [path];
      expect(failure({ ...hetzner, terraform: { ...terraform, homeCacheFiles } })).toContain(
        "terraform.homeCacheFiles.0: must be a path within the home folder, without ..",
      );
    }
  });

  it("wants the shared resources readable and the deploy key among them", () => {
    const shared = (extraShared: Partial<typeof terraform.extraShared>) => ({
      ...hetzner,
      terraform: { ...terraform, extraShared: { ...terraform.extraShared, ...extraShared } },
    });
    expect(failure(shared({ resources: ['resource "hcloud_ssh_key" "deploy"  {'] }))).toContain(
      "terraform.extraShared.resources: has a resource line OpsCrew can't read",
    );
    expect(failure(shared({ resources: ["# nothing here"] }))).toContain(
      "terraform.extraShared.resources: declares no resource",
    );
    // No shared resource is fine only when each server takes the deploy key's text itself.
    expect(() =>
      validateCloudProvider(shared({ resources: [], sshKeyId: "var.deploy_ssh_public_key" })),
    ).not.toThrow();
    expect(failure(shared({ resources: [], sshKeyId: "var.other" }))).toContain(
      "terraform.extraShared.resources: declares no resource",
    );
    expect(failure(shared({ sshKeyId: "coalesce(hcloud_ssh_key.other.id)" }))).toContain(
      "terraform.extraShared.sshKeyId: names none of the resources declared",
    );
  });
  describe("root variables", () => {
    const [envVar] = credentials.envVars;
    const variable = { name: "hetzner_project", description: "The project.", fromEnv: envVar };
    const withRoot = (...rootVariables: unknown[]) => ({
      ...hetzner,
      terraform: { ...terraform, rootVariables },
    });

    it("accepts a definition without them, and well-formed ones", () => {
      expect(terraform).not.toHaveProperty("rootVariables");
      const valid = withRoot(variable);
      expect(validateCloudProvider(valid)).toBe(valid);
    });

    it("wants each name an HCL identifier", () => {
      for (const name of ["Project", "1project", "project-id", "_project", ""]) {
        expect(failure(withRoot({ ...variable, name }))).toContain(
          `terraform.rootVariables.0.name: "${name}" must be an HCL identifier (^[a-z][a-z0-9_]*$)`,
        );
      }
    });

    it("refuses a name that is or ends like a server variable", () => {
      for (const [name, server] of [
        ["location", "location"],
        ["server_type", "server_type"],
        ["image", "image"],
        ["backups", "backups"],
        ["delete_protection", "delete_protection"],
        ["db_location", "location"],
        ["previous_image", "image"],
        ["web_delete_protection", "delete_protection"],
        ["server_ipv4", "server_ipv4"],
        ["previous_server_ipv6", "server_ipv6"],
      ]) {
        expect(failure(withRoot({ ...variable, name }))).toContain(
          `terraform.rootVariables.0.name: "${name}" collides with the server variable ${server}`,
        );
      }
      const near = withRoot({ ...variable, name: "imageset" }, { ...variable, name: "locations" });
      expect(validateCloudProvider(near)).toBe(near);
    });

    it("refuses a name repeated within the definition", () => {
      expect(failure(withRoot(variable, { ...variable }))).toContain(
        'terraform.rootVariables.1.name: "hetzner_project" is declared twice',
      );
    });

    it("wants it fed from one of the provider's credential variables", () => {
      expect(failure(withRoot({ ...variable, fromEnv: "OTHER_VAR" }))).toContain(
        'terraform.rootVariables.0.fromEnv: "hetzner_project" reads OTHER_VAR, which is not one of credentials.envVars',
      );
    });

    it("wants a description", () => {
      for (const description of ["", "   "]) {
        const message = failure(withRoot({ ...variable, description }));
        expect(message).toContain('The cloud provider definition "hetzner" is not valid');
        expect(message).toContain(
          'terraform.rootVariables.0.description: "hetzner_project" has no description',
        );
      }
    });

    it("wants the import id a function, when there is one", () => {
      expect(failure({ ...hetzner, terraform: { ...terraform, importId: "x" } })).toContain(
        "terraform.importId: must be a function",
      );
      const importing = { ...hetzner, terraform: { ...terraform, importId: (id: string) => id } };
      expect(validateCloudProvider(importing)).toBe(importing);
    });

    it("are declared by no two built-in providers under the same name", () => {
      const owners = new Map<string, string>();
      for (const provider of CLOUD_PROVIDERS) {
        for (const { name } of provider.terraform.rootVariables ?? []) {
          expect(owners.get(name), `${name} of ${provider.id}`).toBeUndefined();
          owners.set(name, provider.id);
        }
      }
    });
  });
});

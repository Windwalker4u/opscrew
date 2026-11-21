import { describe, expect, it } from "vitest";
import { readsResource } from "./infra";

describe("the deploy key's shared resource, read from a provider's key expression", () => {
  it("matches a key read by its id or by its name", () => {
    expect(readsResource("coalesce(hcloud_ssh_key.deploy.id)", "hcloud_ssh_key.deploy")).toBe(true);
    expect(
      readsResource("coalesce(ovh_cloud_ssh_key.deploy.name)", "ovh_cloud_ssh_key.deploy"),
    ).toBe(true);
  });

  it("doesn't take a resource whose name only starts the same", () => {
    expect(
      readsResource("coalesce(ovh_cloud_ssh_key.deployer.name)", "ovh_cloud_ssh_key.deploy"),
    ).toBe(false);
    expect(readsResource("coalesce(hcloud_ssh_key.deploy.id)", "hcloud_ssh_key.deployer")).toBe(
      false,
    );
  });
});

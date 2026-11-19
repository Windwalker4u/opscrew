/**
 * `connectAndInspectOwnServer` of a second app on a server OpsCrew created (feature 030): its
 * deploy login reads the apps' records as root through Docker, in the edge's pinned image.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RemoteExec } from "@opscrew/contracts";
import { IMAGES } from "@opscrew/iac-templates";
import { describe, expect, it, vi } from "vitest";
import {
  createdServerFacts,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  OWN_IPV4,
  ownRunner,
} from "../testing";
import { connectAndInspectOwnServer } from "./own-server";
import { type OwnServerConnectionInput, recordOwnServer } from "./server-record";

const inspected = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock("@opscrew/connector-ssh-host", async (original) => {
  const actual = await original<typeof import("@opscrew/connector-ssh-host")>();
  return {
    ...actual,
    inspectHost: async (_remote: RemoteExec, options: unknown) => {
      inspected.options.push(options);
      return createdServerFacts();
    },
  };
});

/** A login whose shell answers every command. */
const remote = (connection: { host: string }): RemoteExec => ({
  host: connection.host,
  run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
});

async function inspectWith(own: (keyPath: string, root: string) => OwnServerConnectionInput) {
  const deps = await createTestPhaseDeps({ runner: ownRunner() });
  const keyPath = deps.paths.files.deployKey;
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, "placeholder for the deploy key file\n");
  await recordOwnServer(deps.paths, own(keyPath, deps.paths.root));
  inspected.options.length = 0;
  await connectAndInspectOwnServer(deps, { services: { remote } });
  return inspected.options;
}

describe("connectAndInspectOwnServer", () => {
  it("reads a second app's server as root through Docker, in the edge's pinned image", async () => {
    const options = await inspectWith((keyPath, root) => ({
      host: OWN_IPV4,
      user: "deploy",
      agent: false,
      keyPath,
      hostKey: ED25519_FINGERPRINT,
      shares: { root: join(root, "elsewhere", "shop") },
      joined: true,
    }));
    expect(options).toEqual([{ rootImage: IMAGES.caddy.ref }]);
  });

  it("reads a server the user owns as before, without Docker", async () => {
    const options = await inspectWith(() => ({
      host: OWN_IPV4,
      user: "root",
      agent: true,
      hostKey: ED25519_FINGERPRINT,
    }));
    expect(options).toEqual([{}]);
  });
});

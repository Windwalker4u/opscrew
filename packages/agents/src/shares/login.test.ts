import { readFile, rm } from "node:fs/promises";
import type { RemoteExec } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import {
  knownHostsName,
  type OwnServerConnection,
  readOwnServer,
  recordOwnServer,
  serverAddressesFile,
} from "../shared";
import {
  ED25519,
  ED25519_FINGERPRINT,
  hostKeyBlob,
  SERVER_IPV4,
  type SharedServerProject,
  sharedServerProject,
} from "../testing";
import { secondAppLogin } from "./login";

/** A shell that answers every command, keeping the logins it was opened with and the commands. */
function fakeLogins() {
  const logins: OwnServerConnection[] = [];
  const commands: string[] = [];
  return {
    logins,
    commands,
    remote: (connection: OwnServerConnection): RemoteExec => {
      logins.push(connection);
      return {
        host: connection.host,
        run: async (command) => {
          commands.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };
    },
  };
}

/** Everything the fakes saw, and what this app's state holds. */
async function seen(project: SharedServerProject, shell: ReturnType<typeof fakeLogins>) {
  const { deps } = project;
  return [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify((deps.runner as unknown as { calls: unknown[] }).calls),
    JSON.stringify(shell.logins),
    shell.commands.join("\n"),
    await readFile(serverAddressesFile(deps.paths), "utf8"),
    await readFile(deps.paths.files.knownHosts, "utf8").catch(() => ""),
  ].join("\n");
}

describe("secondAppLogin", () => {
  it("logs in as deploy with the first app's deploy key until joined, and copies the pinned host key", async () => {
    const project = await sharedServerProject();
    const shell = fakeLogins();
    const session = await secondAppLogin(project.deps, project.ref, project.own, {
      services: { remote: shell.remote },
    });
    expect(shell.logins).toHaveLength(1);
    expect(shell.logins[0]).toMatchObject({
      host: SERVER_IPV4,
      port: 22,
      user: "deploy",
      agent: false,
      keyPath: project.first.files.deployKey,
      hostKey: ED25519_FINGERPRINT,
    });
    expect(session.hostKey.fingerprint).toBe(ED25519_FINGERPRINT);
    expect(session.knownHostsFile).toBe(project.deps.paths.files.knownHosts);
    // The first app's pinned key, under the same address and port, in this app's known_hosts.
    expect(await readFile(project.deps.paths.files.knownHosts, "utf8")).toBe(
      `${knownHostsName(SERVER_IPV4)} ssh-ed25519 ${ED25519}\n`,
    );
    // Recorded with this app's own login, whose key stays its own.
    expect(await readOwnServer(project.deps.paths)).toEqual({
      ...project.own,
      hostKey: ED25519_FINGERPRINT,
    });
    const all = await seen(project, shell);
    expect(all).not.toContain(project.firstKey);
    expect(project.deps.reporter.text()).not.toContain(SERVER_IPV4);
    expect(JSON.stringify(project.deps.audit.entries)).not.toContain(SERVER_IPV4);
  });

  it("logs in with the app's own key once joined, without the first app's folder", async () => {
    const project = await sharedServerProject();
    await secondAppLogin(project.deps, project.ref, project.own, {
      services: { remote: fakeLogins().remote },
    });
    const recorded = await readOwnServer(project.deps.paths);
    if (recorded === undefined) throw new Error("no login recorded");
    await recordOwnServer(project.deps.paths, { ...recorded, joined: true });
    const joined = await readOwnServer(project.deps.paths);
    if (joined === undefined) throw new Error("no login recorded");
    await rm(project.ref.root, { recursive: true, force: true });
    await rm(project.first.projectHomeDir, { recursive: true, force: true });

    const shell = fakeLogins();
    await secondAppLogin(project.deps, project.ref, joined, {
      services: { remote: shell.remote },
    });
    expect(shell.logins[0]).toMatchObject({
      host: SERVER_IPV4,
      user: "deploy",
      keyPath: project.deps.paths.files.deployKey,
      hostKey: ED25519_FINGERPRINT,
    });
    expect(await seen(project, shell)).not.toContain(project.firstKey);
  });

  it("stops as a changed host key does when the server offers another key", async () => {
    const project = await sharedServerProject({
      keys: [{ type: "ssh-ed25519", key: hostKeyBlob("ssh-ed25519", "rebuilt") }],
    });
    const shell = fakeLogins();
    await expect(
      secondAppLogin(project.deps, project.ref, project.own, {
        services: { remote: shell.remote },
      }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("changed since you confirmed it"),
    });
    expect(shell.logins).toEqual([]);
    expect(await readOwnServer(project.deps.paths)).toEqual(project.own);
    expect(await seen(project, shell)).not.toContain(project.firstKey);
  });
});

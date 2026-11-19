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

/** Another address the second app's login named before (RFC 5737). */
const OTHER_IPV4 = "203.0.113.99";

/** The stop on a changed host key: the first app's pin, its repository, never --host-key. */
const CHANGED_KEY = {
  code: "PHASE_PRECONDITION",
  message: expect.stringMatching(
    /^The server's SSH host key differs from the one the app it belongs to pinned on this computer. OpsCrew stopped and changed nothing.$/,
  ),
  hint: expect.stringMatching(/^(?!.*--host-key).*in the repository of that app (.+)/s),
};

describe("secondAppLogin", () => {
  it("logs in as deploy with the first app's deploy key until joined, and copies the pinned host key", async () => {
    const project = await sharedServerProject();
    // The login recorded earlier names another address: the first app's is recorded now.
    const own = { ...project.own, host: OTHER_IPV4, port: 2222 };
    await recordOwnServer(project.deps.paths, own);
    const shell = fakeLogins();
    const { session, first } = await secondAppLogin(project.deps, project.ref, own, {
      services: { remote: shell.remote },
    });
    expect(first?.plan.app.name).toBe("shop");
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
    // This app's own login as recorded: the first app's key stays inside the shell.
    expect(session.connection).toEqual({ ...project.own, hostKey: ED25519_FINGERPRINT });
    expect(session.connection.keyPath).toBe(own.keyPath);
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
    const { session, first } = await secondAppLogin(project.deps, project.ref, joined, {
      services: { remote: shell.remote },
    });
    expect(first).toBeUndefined();
    expect(session.connection.keyPath).toBe(joined.keyPath);
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
    ).rejects.toMatchObject(CHANGED_KEY);
    expect(shell.logins).toEqual([]);
    expect(await readOwnServer(project.deps.paths)).toEqual(project.own);
    expect(await seen(project, shell)).not.toContain(project.firstKey);
  });

  it("stops the same way once joined", async () => {
    const project = await sharedServerProject({
      keys: [{ type: "ssh-ed25519", key: hostKeyBlob("ssh-ed25519", "rebuilt") }],
    });
    const joined = { ...project.own, hostKey: ED25519_FINGERPRINT, joined: true as const };
    const shell = fakeLogins();
    await expect(
      secondAppLogin(project.deps, project.ref, joined, { services: { remote: shell.remote } }),
    ).rejects.toMatchObject(CHANGED_KEY);
    expect(shell.logins).toEqual([]);
  });
});

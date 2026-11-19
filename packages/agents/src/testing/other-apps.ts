import type { AppRecord, HostFacts } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { exists, type ProjectPaths, Redactor } from "@opscrew/core";
import { readServerAddresses, recordServerAddress } from "../shared/server-record";
import { ensureDeployKey } from "../shared/ssh-keys";
import { SERVER_IPV4 } from "./deploy";
import { createdServerFacts } from "./own";

/** An inspection of a server OpsCrew created that holds no app from another repository. */
export async function noOtherApps(): Promise<HostFacts> {
  return createdServerFacts();
}

/** The first app's look at its server in tests ({@link firstAppLook}). */
export interface FirstAppLook {
  /** Inspects the server: the records given, or the error given. */
  inspect: (remote: RemoteExec, options: { rootImage?: string }) => Promise<HostFacts>;
  /** The options of each inspection, in order. */
  inspections: { rootImage?: string }[];
}

/**
 * The first app's look at its server OpsCrew created for apps from other repositories (030,
 * `requireNoOtherApps`) in a test: a deploy key as provision makes it (synthetic, made now) and
 * the server's address ({@link SERVER_IPV4}), each unless the project has one, so the look has a
 * login; and an inspection that finds `records` there (none by default) and the records of
 * `unreadable` it can't read, or fails with `fails`.
 */
export async function firstAppLook(
  paths: ProjectPaths,
  records: readonly AppRecord[] = [],
  o: { fails?: Error; unreadable?: readonly string[] } = {},
): Promise<FirstAppLook> {
  if (!(await exists(paths.files.deployKey))) await ensureDeployKey(paths, new Redactor());
  if ((await readServerAddresses(paths)).deployment === undefined) {
    await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
  }
  const inspections: { rootImage?: string }[] = [];
  return {
    inspections,
    inspect: async (_remote, options) => {
      inspections.push(options);
      if (o.fails !== undefined) throw o.fails;
      const facts = createdServerFacts(records);
      return {
        ...facts,
        apps: [...facts.apps, ...(o.unreadable ?? []).map((name) => ({ name, record: null }))],
      };
    },
  };
}

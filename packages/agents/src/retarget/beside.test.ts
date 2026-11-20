/**
 * The start of a move onto the server OpsCrew created for another app (feature 030, US6, plan
 * 16.): from every old side retarget moves from, the new side is an own target naming the first
 * app, set up as its second app; design's second-app checks refuse before any change.
 */
import { readFile, rm } from "node:fs/promises";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { edgeMemoryMb } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { sharedAccessWarning } from "../design/own";
import {
  appMemoryMb,
  readServerAddresses,
  SYSTEM_RESERVE_MB,
  serverAddressesFile,
  updateServerAddresses,
} from "../shared";
import { OLD_IPV4, OLD_IPV6, secondAppRecord } from "../testing";
import {
  type BesideStart,
  besideStart,
  everythingSeen,
  FIRST,
  FIRST_ADDRESS,
  type FirstAppOptions,
  firstAppServer,
  type OldSide,
  printed,
} from "./__fixtures__/beside";
import { runRetarget } from "./run";
import { startMove } from "./start";
import type { RetargetOptions, RetargetSummary } from "./types";

/** The move's state on this computer and in the repository: what a refusal leaves as it was. */
async function snapshot(h: BesideStart): Promise<string> {
  const local = await readFile(serverAddressesFile(h.paths), "utf8").catch(() => "");
  return `${await readFile(h.paths.files.plan, "utf8")}\n${local}`;
}

/** The options of a move beside `blog`. */
function beside(h: BesideStart, more: RetargetOptions = {}): RetargetOptions {
  return { services: h.services, to: "own", sharedServer: h.first.ref, ...more };
}

/** Runs `opscrew retarget` beside `blog`; the error it stops with. */
async function refused(h: BesideStart, more: RetargetOptions = {}): Promise<OpsCrewError> {
  const error = await runRetarget(h.deps, beside(h, more)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const OLD_SIDES: readonly OldSide[] = ["hetzner", "contabo", "own", "portainer", "shared"];

describe.skipIf(!findExecutable("git"))(
  "a move onto the server OpsCrew created for another app",
  () => {
    it.each(OLD_SIDES)(
      "from %s: starts with the first app's server as the new side, at no server cost",
      async (from) => {
        const h = await besideStart(from);
        let summary: RetargetSummary | undefined;
        const session = await startMove(
          h.deps,
          h.plan,
          beside(h, {
            confirmStart: async (s) => {
              summary = s;
              return true;
            },
          }),
        );
        expect(session.plan.target).toEqual({
          provider: "own",
          mode: "vps-compose",
          arch: "amd64",
          access: "public",
          edge: "caddy",
          shares: { app: FIRST, provider: "hetzner" },
        });
        expect(session.plan.retarget).toMatchObject({
          step: "started",
          from: { target: h.plan.target },
        });
        expect(summary?.extraMonthly.amount).toBe(0);
        expect(summary?.steps[1]).toContain(`Set up the app beside "${FIRST}" on its server`);
        const text = h.reporter.text();
        expect(text).toContain(`to the Hetzner Cloud server of "${FIRST}" (beside it)`);
        expect(text).toContain("Memory limits: the app");
        expect(text).toContain(`"${FIRST}"`);
        expect(text).toContain(`No server price: the server is "${FIRST}"'s, which pays for it.`);
        expect(text).toContain(sharedAccessWarning(FIRST));
        // Nothing changed on the first app's server: only its look, as its deploy login.
        expect(h.server.applies).toEqual([]);
        expect(h.server.inspections).toBe(1);
        // The new side's login is the second app's: the first app's address, its pinned key, the
        // reference to its folder; this app's own deploy key, never the first app's.
        const local = await readServerAddresses(h.paths);
        expect(local.own).toEqual({
          host: FIRST_ADDRESS.ipv4,
          port: 22,
          user: "deploy",
          agent: false,
          keyPath: h.paths.files.deployKey,
          shares: h.first.ref,
          hostKey: expect.stringMatching(/^SHA256:/),
        });
        expect(local.retarget?.next).toEqual(FIRST_ADDRESS);
        expect(local.retarget?.from?.ipv4).toBe(OLD_IPV4);
        if (from === "own" || from === "shared")
          expect(local.retarget?.fromOwn?.host).toBe(OLD_IPV4);
        const committed = await readFile(h.paths.files.plan, "utf8");
        for (const address of [FIRST_ADDRESS.ipv4, FIRST_ADDRESS.ipv6, OLD_IPV4, OLD_IPV6]) {
          expect(committed).not.toContain(address);
        }
        expect(await printed(h)).not.toContain(FIRST_ADDRESS.ipv4);
        const seen = await everythingSeen(h);
        expect(seen).not.toContain(h.first.key);
        expect(await readFile(serverAddressesFile(h.paths), "utf8")).not.toContain(
          h.first.paths.files.deployKey,
        );
      },
    );

    it("warns below 15% free and goes on, counting the first app's limits and the other apps' records", async () => {
      const other = secondAppRecord({ app: "wiki", memoryMb: 256 });
      const h = await besideStart("hetzner");
      const limits =
        appMemoryMb(h.plan) + appMemoryMb(h.first.plan) + other.memoryMb + edgeMemoryMb("caddy");
      // About 10% stays free after the system's reserve.
      h.server.facts = firstAppServer({
        memoryGb: (Math.ceil(limits / 0.9) + SYSTEM_RESERVE_MB) / 1024,
        apps: [other],
      });
      await startMove(h.deps, h.plan, beside(h));
      const warned = h.reporter.text();
      expect(warned).toContain("% of its memory free after the memory limits of this app");
      expect(warned).toContain(`"${FIRST}" ${appMemoryMb(h.first.plan)} MB`);
      expect(warned).toContain(`"wiki" 256 MB`);
      expect(h.server.applies).toEqual([]);
    });
  },
);

/** What changes a refusal's run: a move beside `blog` from a Hetzner server, then `change`. */
interface Refusal {
  what: string;
  first?: FirstAppOptions;
  change?: (h: BesideStart) => Promise<void>;
  says: string;
  hint?: string;
}

/** The moving app's plan, changed by `edit`. */
async function editPlan(h: BesideStart, edit: (plan: DeployPlan) => object): Promise<void> {
  const plan = DeployPlanSchema.parse(edit(h.plan));
  await writeArtifact("plan", h.paths.files.plan, plan);
  h.plan = plan;
}

const REFUSALS: readonly Refusal[] = [
  {
    what: "a first app on a server the user owns, with today's words",
    first: { own: true },
    says: `"${FIRST}" does not run on a server OpsCrew created, so this app can't share it this way.`,
    hint: "answer the interview's server question with your own server's login instead",
  },
  {
    what: "a first app that is not provisioned on this computer",
    change: async (h) => rm(h.first.paths.files.plan),
    says: "has no OpsCrew plan on this computer",
  },
  {
    what: "the server the app already runs on",
    change: async (h) => {
      await updateServerAddresses(h.paths, (current) => ({
        ...current,
        deployment: FIRST_ADDRESS,
      }));
    },
    says: "shop already runs on that server, so there is nothing to move.",
  },
  {
    what: "another proxy than the first app's server runs",
    first: { edge: "nginx" },
    says: `shop's proxy is Caddy (target.edge in opscrew/plan.yaml), and the server of "${FIRST}" runs nginx for every app on it.`,
    hint: "target.edge: nginx",
  },
  {
    what: "another way of serving",
    first: { proxied: false },
    change: async (h) => editPlan(h, (plan) => ({ ...plan, dns: { ...plan.dns, proxied: true } })),
    says: `"${FIRST}" is served with DNS only, so its server answers everyone on ports 80 and 443, and shop is served behind Cloudflare's proxy`,
  },
  {
    what: "Beszel, which watches the whole server",
    change: async (h) =>
      editPlan(h, (plan) => ({
        ...plan,
        observability: {
          ...plan.observability,
          beszel: {
            enabled: true,
            version: "0.21.1",
            mode: "hub",
            access: "local",
            memoryMb: { hub: 128, agent: 64, proxy: 32 },
          },
        },
      })),
    says: `shop runs Beszel, which changes the whole server, and the server of "${FIRST}" is that app's`,
    hint: "`opscrew addon disable beszel`",
  },
  {
    what: "a kernel setting its services need, which the first app's setup owns",
    change: async (h) =>
      editPlan(h, (plan) => ({
        ...plan,
        services: [
          ...plan.services,
          {
            kind: "opensearch",
            version: "3.9",
            memoryMb: 1024,
            reason: "The app uses OpenSearch.",
            licence: "Apache-2.0",
          },
        ],
      })),
    says: "vm.max_map_count",
  },
  {
    what: "the first app's name",
    change: async (h) => editPlan(h, (plan) => ({ ...plan, app: { ...plan.app, name: FIRST } })),
    says: `This app is named "${FIRST}", like the app whose server this is`,
  },
  {
    what: "a name read as one of the first app's previews",
    change: async (h) =>
      editPlan(h, (plan) => ({ ...plan, app: { ...plan.app, name: `${FIRST}-pr-3` } })),
    says: `is how OpsCrew names a preview of "${FIRST}"`,
  },
  {
    what: "a hostname another app on the server serves",
    change: async (h) => {
      h.server.facts = firstAppServer({
        apps: [{ ...secondAppRecord({ app: "wiki" }), hostnames: ["shop.example.com"] }],
      });
    },
    says: 'The OpsCrew app "wiki" on this server already serves shop.example.com',
  },
  {
    what: "a record on the server OpsCrew can't read",
    change: async (h) => {
      h.server.facts = { ...firstAppServer(), apps: [{ name: "wiki", record: null }] };
    },
    says: `The server of "${FIRST}" also runs "wiki", whose record there OpsCrew can't read`,
  },
  {
    what: "too little memory beside the first app",
    change: async (h) => {
      h.server.facts = firstAppServer({ memoryGb: 1 });
    },
    says: `shop doesn't fit beside the apps on the server of "${FIRST}": Your server has 1024 MB of memory.`,
    hint: "Lower the memory limits in opscrew/plan.yaml",
  },
];

describe.skipIf(!findExecutable("git"))(
  "a move onto another app's server refuses before any change, as design refuses a second app",
  () => {
    it.each(REFUSALS)("refuses $what", async ({ first, change, says, hint }) => {
      const h = await besideStart("hetzner", first === undefined ? {} : { first });
      await change?.(h);
      const before = await snapshot(h);
      const error = await refused(h);
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(says);
      expect(error.message).toMatch(/Nothing was changed\.$/);
      // Each says what to do next.
      expect(error.hint).toContain(hint ?? "");
      expect(error.hint?.length ?? 0).toBeGreaterThan(20);
      // Nothing changed here, in the cloud or on either server.
      expect(await snapshot(h)).toBe(before);
      expect(h.server.applies).toEqual([]);
      expect(h.events.filter((e) => e.type === "apply" || e.type === "approval")).toEqual([]);
      expect((await readArtifact("plan", h.paths.files.plan)).retarget).toBeUndefined();
      const text = `${await printed(h)}\n${error.message}\n${error.hint ?? ""}`;
      for (const address of [FIRST_ADDRESS.ipv4, OLD_IPV4]) expect(text).not.toContain(address);
      expect(await everythingSeen(h)).not.toContain(h.first.key);
    });
  },
);

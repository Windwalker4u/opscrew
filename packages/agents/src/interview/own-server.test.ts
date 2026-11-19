import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFixture } from "@opscrew/core/testing";
import { QuestionSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  damagedServerAddressesFile,
  readOwnServer,
  recordOwnServer,
  serverAddressesFile,
} from "../shared";
import { createTestPhaseDeps } from "../testing";
import { answersToRequirements } from "./answers";
import { splitFollowUps } from "./follow-ups";
import {
  answersToOwnServer,
  buildServerQuestions,
  SERVER_FIELDS,
  type ServerQuestion,
  suggestReachable,
} from "./own-server";
import type { InterviewAnswers } from "./questions";
import { runInterview } from "./run";

const splitServerAnswers = (answers: InterviewAnswers) =>
  splitFollowUps(answers, "server", SERVER_FIELDS);

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const now = new Date("2026-10-14T12:00:00.000Z");
const IPV4 = "203.0.113.10";
const HOST_KEY = `SHA256:${createHash("sha256").update("own server host key").digest("base64").replace(/=+$/, "")}`;

const BASE: InterviewAnswers = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: { amount: 10, currency: "EUR" },
  uptime: "standard",
};

async function deps() {
  const root = await mkdtemp(join(tmpdir(), "opscrew-own-interview-"));
  await materializeFixture(join(examples, "static-vite"), root);
  return createTestPhaseDeps({ root });
}
type PhaseDepsOf = Awaited<ReturnType<typeof deps>>;

const split = (server: Record<string, unknown>) => splitServerAnswers({ server });

describe("questions for a server the user already has", () => {
  it("asks for the address, SSH port, user, key and reachability, never a password", () => {
    const questions = buildServerQuestions();
    expect(questions.map((q) => q.id)).toEqual([
      "server.host",
      "server.home",
      "server.port",
      "server.user",
      "server.key",
      "server.reachable",
      "server.serve",
    ]);
    for (const question of questions) {
      // Same shape as every other interview question.
      expect(QuestionSchema.safeParse({ ...question, id: "notes" }).success).toBe(true);
    }
    expect(questions.find((q) => q.id === "server.port")?.default).toBe("22");
    // The login port: the forwarded one when a router forwards it, not necessarily sshd's.
    expect(questions.find((q) => q.id === "server.port")?.prompt).toBe(
      "Which port do you connect to for SSH?",
    );
    expect(questions.find((q) => q.id === "server.port")?.help).toBe(
      "The port this computer and GitHub Actions connect to, usually 22. When a router forwards another port to your server (for example 2222 to the server's 22), give the forwarded port (2222).",
    );
    expect(questions.find((q) => q.id === "server.key")?.default).toBe("agent");
    expect(questions.find((q) => q.id === "server.reachable")).toMatchObject({
      kind: "confirm",
      default: true,
    });
    expect(JSON.stringify(questions)).not.toMatch(/enter (your|the) password/i);
  });

  it("pre-fills the previous answers and takes the reachability suggestion", () => {
    const previous = {
      host: IPV4,
      port: 2222,
      user: "admin",
      keyPath: "~/.ssh/id_ed25519",
      agent: false,
      reachable: false,
    };
    const questions = buildServerQuestions({ previous });
    const defaults = Object.fromEntries(questions.map((q) => [q.id, q.default]));
    expect(defaults).toEqual({
      "server.host": IPV4,
      "server.home": false,
      "server.port": "2222",
      "server.user": "admin",
      "server.key": "~/.ssh/id_ed25519",
      "server.reachable": false,
      "server.serve": "tunnel",
    });
    const suggested = buildServerQuestions({ previous, suggestedReachable: true });
    expect(suggested.find((q) => q.id === "server.reachable")?.default).toBe(true);
  });

  it("asks how to serve the site: the tunnel recommended, the filter and DNS only explained", () => {
    const serve = buildServerQuestions().find((q) => q.id === "server.serve");
    expect(serve).toMatchObject({ kind: "single-select", default: "tunnel" });
    expect(serve?.options?.map((o) => o.value)).toEqual(["tunnel", "proxy", "dns-only"]);
    expect(serve?.options?.[0]?.label).toMatch(/recommended/);
    expect(serve?.options?.[1]?.hint).toMatch(/needs no Cloudflare Zero Trust.*fails closed/i);
    expect(serve?.options?.[2]?.hint).toMatch(/neither hides nor protects/);
    // The earlier answer is the default next time.
    const previous = { host: IPV4, port: 22, user: "root", agent: true, serve: "proxy" as const };
    expect(buildServerQuestions({ previous }).find((q) => q.id === "server.serve")?.default).toBe(
      "proxy",
    );
    // Without a domain on Cloudflare only DNS only is offered, and the help says why.
    const only = buildServerQuestions({ cloudflareDomain: false }).find(
      (q) => q.id === "server.serve",
    );
    expect(only?.options?.map((o) => o.value)).toEqual(["dns-only"]);
    expect(only?.help).toMatch(/not on Cloudflare/);
  });

  it("guesses reachability from the address", () => {
    expect(suggestReachable(IPV4)).toBe(true);
    expect(suggestReachable("192.168.1.20")).toBe(false);
    expect(suggestReachable("10.0.0.5")).toBe(false);
    expect(suggestReachable("172.20.0.5")).toBe(false);
    expect(suggestReachable("100.100.1.1")).toBe(false);
    expect(suggestReachable("2001:db8::10")).toBe(true);
    expect(suggestReachable("fd00::1")).toBe(false);
    expect(suggestReachable("pi.local")).toBe(false);
    expect(suggestReachable("nas")).toBe(false);
    expect(suggestReachable("server.example.com")).toBeUndefined();
  });
});

describe("answersToOwnServer", () => {
  it("accepts flat server.* keys and a nested server mapping, defaulting the port to 22", () => {
    const flat = splitServerAnswers({
      ...BASE,
      "server.host": ` ${IPV4} `,
      "server.user": "root",
      "server.key": "agent",
    });
    expect(flat.rest).toEqual(BASE);
    expect(answersToOwnServer(flat)).toEqual({
      host: IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
      serve: "tunnel",
    });
    const nested = split({
      host: "[2001:db8::10]",
      port: "2222",
      user: "ubuntu",
      key: "~/.ssh/id_ed25519",
      reachable: "no",
    });
    expect(answersToOwnServer(nested)).toEqual({
      host: "2001:db8::10",
      port: 2222,
      user: "ubuntu",
      keyPath: "~/.ssh/id_ed25519",
      agent: false,
      reachable: false,
      serve: "tunnel",
    });
  });

  it("takes how the site is served, and refuses anything else", () => {
    const base = { host: IPV4, user: "root", key: "agent" };
    for (const serve of ["tunnel", "proxy", "dns-only"] as const) {
      expect(answersToOwnServer(split({ ...base, serve })).serve).toBe(serve);
    }
    expect(answersToOwnServer(split({ ...base, serve: "Proxy" })).serve).toBe("proxy");
    expect(() => answersToOwnServer(split({ ...base, serve: "open" }))).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/server\.serve: answer tunnel/) }),
    );
    // Without a domain on Cloudflare only DNS only is possible.
    expect(answersToOwnServer(split(base), { cloudflareDomain: false }).serve).toBe("dns-only");
    expect(() =>
      answersToOwnServer(split({ ...base, serve: "proxy" }), { cloudflareDomain: false }),
    ).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/only be served with DNS only/) }),
    );
  });

  it("refuses the web filter for a server known only by an IPv6 address", () => {
    const v6 = { host: "2001:db8::10", user: "root", key: "agent", reachable: "yes" };
    expect(() => answersToOwnServer(split({ ...v6, serve: "proxy" }))).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.stringMatching(/proxy needs your server's public IPv4 address/),
      }),
    );
    expect(answersToOwnServer(split({ ...v6, serve: "tunnel" })).serve).toBe("tunnel");
    expect(answersToOwnServer(split({ ...v6, host: IPV4, serve: "proxy" })).serve).toBe("proxy");
  });

  it("suggests reachability from inspection, then the address", () => {
    const answers = split({ host: "192.168.1.20", home: "no", user: "pi", key: "agent" });
    expect(answersToOwnServer(answers).reachable).toBe(false);
    expect(answersToOwnServer(answers, { suggestedReachable: true }).reachable).toBe(true);
  });

  it("lists missing and invalid answers in plain English", () => {
    expect(() => answersToOwnServer(split({}))).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.stringMatching(/server\.host .*missing.*server\.user .*missing/),
      }),
    );
    try {
      answersToOwnServer(
        split({
          host: "root@203.0.113.10",
          port: 70000,
          user: "-l root",
          key: "id_ed25519",
          reachable: "maybe",
          address: "x",
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      const message = (error as Error).message;
      expect(message).toMatch(/server\.address: not a known answer/);
      expect(message).toMatch(/server\.host: give only the address/);
      expect(message).toMatch(/server\.port: write a port number/);
      expect(message).toMatch(/server\.user: write a login name/);
      expect(message).toMatch(/server\.key: write the full path/);
      expect(message).toMatch(/server\.reachable: answer yes or no/);
    }
    expect(() => answersToOwnServer(split({ host: "-oProxyCommand=x", user: "root" }))).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/server\.host: write an IP/) }),
    );
  });

  it("refuses passwords, passphrases and key material without echoing them", () => {
    const secret = "correct-horse-battery";
    for (const key of ["password", "passphrase"]) {
      const error = (() => {
        try {
          answersToOwnServer(split({ host: IPV4, user: "root", [key]: secret }));
        } catch (e) {
          return e as Error;
        }
      })();
      expect(error?.message).toMatch(/never asks for or stores a password or passphrase/);
      expect(error?.message).not.toContain(secret);
    }
    const pem = `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----`;
    const error = (() => {
      try {
        answersToOwnServer(split({ host: IPV4, user: "root", key: pem }));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toMatch(/never the key itself/);
    expect(error?.message).not.toContain("BEGIN");
  });
});

describe("a domain Cloudflare serves for a server the user already has", () => {
  const base = { host: IPV4, user: "root", key: "agent" };
  const deep = { cloudflareDomain: true, domain: "api.shop.example.com" };
  const reason =
    "domain: Cloudflare's free certificate covers only example.com and *.example.com, so api.shop.example.com would fail HTTPS at Cloudflare's edge; use a name one level below example.com, such as api-shop.example.com, or ";

  it("refuses it two levels below the zone through the tunnel or behind the proxy", () => {
    expect(() => answersToOwnServer(split({ ...base, serve: "tunnel" }), deep)).toThrow(
      `${reason}if the internet can reach your server, serve it with DNS only (server.reachable yes, server.serve dns-only).`,
    );
    expect(() =>
      answersToOwnServer(split({ ...base, reachable: "no", serve: "proxy" }), deep),
    ).toThrow(`${reason}if the internet can reach your server`);
    expect(() =>
      answersToOwnServer(split({ ...base, reachable: "yes", serve: "proxy" }), deep),
    ).toThrow(`${reason}serve it with DNS only (server.serve dns-only).`);
  });

  it("allows it with DNS only, one level below the zone, or off Cloudflare", () => {
    expect(
      answersToOwnServer(split({ ...base, reachable: "yes", serve: "dns-only" }), deep).serve,
    ).toBe("dns-only");
    for (const domain of ["shop.example.com", "example.com"]) {
      expect(
        answersToOwnServer(split({ ...base, serve: "tunnel" }), { cloudflareDomain: true, domain })
          .serve,
      ).toBe("tunnel");
    }
    expect(
      answersToOwnServer(split(base), { cloudflareDomain: false, domain: deep.domain }).serve,
    ).toBe("dns-only");
  });

  it("is not refused in the requirements, where the serving answer is not known", () => {
    expect(
      answersToRequirements(
        { ...BASE, provider: "own", dataCriticality: "none", domain: deep.domain },
        { now },
      ).domain,
    ).toBe(deep.domain);
  });
});

describe("requirements for a server the user already has", () => {
  it("records only provider: own, with no region needed", () => {
    const requirements = answersToRequirements(
      { ...BASE, provider: "own", dataCriticality: "none" },
      { now },
    );
    expect(requirements.provider).toBe("own");
    expect(requirements.region).toBeUndefined();
    const ignored = answersToRequirements(
      { ...BASE, provider: "OWN", region: "eu-central", dataCriticality: "none" },
      { now },
    );
    expect(ignored.region).toBeUndefined();
    // Hetzner still needs a region.
    expect(() =>
      answersToRequirements({ ...BASE, provider: "hetzner", dataCriticality: "none" }, { now }),
    ).toThrow(expect.objectContaining({ message: expect.stringMatching(/region/) }));
  });
});

describe("runInterview with a server the user already has", () => {
  it("saves the connection answers locally and only provider: own in requirements.yaml", async () => {
    const d = await deps();
    const result = await runInterview(d, {
      answers: {
        ...BASE,
        provider: "own",
        region: "eu-central",
        "server.host": IPV4,
        "server.port": 2222,
        "server.user": "admin",
        "server.key": "~/.ssh/id_ed25519",
        "server.reachable": false,
      },
    });
    expect(result.ownServer).toEqual({
      host: IPV4,
      port: 2222,
      user: "admin",
      keyPath: "~/.ssh/id_ed25519",
      agent: false,
      reachable: false,
      serve: "dns-only",
    });
    const text = await readFile(d.paths.files.requirements, "utf8");
    expect(text).toMatch(/provider: own/);
    expect(text).not.toContain(IPV4);
    expect(text).not.toMatch(/admin|id_ed25519|2222|region|server/);
    expect((await readArtifact("requirements", d.paths.files.requirements)).region).toBeUndefined();
    // Recorded in the local server state, without a host key until provision pins one.
    expect(await readOwnServer(d.paths)).toEqual(result.ownServer);
    expect(serverAddressesFile(d.paths)).toBe(join(d.paths.stateDir, "server.json"));
    expect((await d.state.read()).phases.interview?.summary).toMatch(/your own server/);
    expect((await d.state.read()).phases.interview?.summary).not.toContain(IPV4);
  });

  it("refuses a domain too deep for the tunnel before anything is written", async () => {
    const d = await deps();
    await expect(
      runInterview(d, {
        answers: {
          ...BASE,
          provider: "own",
          domain: "api.shop.example.com",
          dnsProvider: "cloudflare",
          server: { host: IPV4, user: "root", key: "agent", serve: "tunnel" },
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining(
        "so api.shop.example.com would fail HTTPS at Cloudflare's edge; use a name one level below example.com, such as api-shop.example.com",
      ),
    });
    await expect(readFile(d.paths.files.requirements, "utf8")).rejects.toThrow();
    expect(await readOwnServer(d.paths)).toBeUndefined();
    // DNS only is served with Caddy's own certificate.
    const direct = await runInterview(d, {
      answers: {
        ...BASE,
        provider: "own",
        domain: "api.shop.example.com",
        dnsProvider: "cloudflare",
        server: { host: IPV4, user: "root", key: "agent", reachable: true, serve: "dns-only" },
      },
    });
    expect(direct.requirements.domain).toBe("api.shop.example.com");
  });

  it("asks the server questions after the others, pre-filled from the last answers", async () => {
    const d = await deps();
    await runInterview(d, {
      answers: { ...BASE, provider: "own", server: { host: IPV4, user: "root", key: "agent" } },
    });
    const rounds: string[][] = [];
    let defaults: Record<string, unknown> = {};
    const result = await runInterview(d, {
      ask: async () => ({ ...BASE, provider: "own" }),
      askServer: async (questions) => {
        rounds.push(questions.map((q) => q.id));
        defaults = { ...defaults, ...Object.fromEntries(questions.map((q) => [q.id, q.default])) };
        return { "server.host": IPV4, "server.user": "ubuntu", "server.key": "agent" };
      },
      suggestedReachable: false,
    });
    // Which kind of server, the address, then whether it is at home, then the rest for that
    // address and that answer.
    expect(rounds).toEqual([
      ["server.kind"],
      ["server.host"],
      ["server.home"],
      ["server.port", "server.user", "server.key", "server.reachable", "server.serve"],
    ]);
    expect(defaults).toMatchObject({ "server.host": IPV4, "server.user": "root" });
    expect(result.ownServer).toMatchObject({ user: "ubuntu", reachable: false });
  });

  it("offers every way to serve the site only with a domain on Cloudflare", async () => {
    const serveQuestion = async (answers: InterviewAnswers) => {
      const d = await deps();
      let options: string[] = [];
      let help = "";
      await runInterview(d, {
        ask: async () => ({ ...BASE, provider: "own", ...answers }),
        askServer: async (questions) => {
          const serve = questions.find((q) => q.id === "server.serve");
          options = serve?.options?.map((o) => o.value) ?? [];
          help = serve?.help ?? "";
          return { "server.host": IPV4, "server.user": "root", "server.key": "agent" };
        },
      });
      return { options, help, saved: await readOwnServer(d.paths) };
    };
    const cloudflare = await serveQuestion({
      domain: "app.example.com",
      dnsProvider: "cloudflare",
    });
    expect(cloudflare.options).toEqual(["tunnel", "proxy", "dns-only"]);
    expect(cloudflare.saved?.serve).toBe("tunnel");
    // A reachable server without a Cloudflare domain: DNS only, and the help says why.
    const other = await serveQuestion({ domain: "app.example.com", dnsProvider: "other" });
    expect(other.options).toEqual(["dns-only"]);
    expect(other.help).toMatch(/not on Cloudflare/);
    expect(other.saved?.serve).toBe("dns-only");

    // An answers file that asks for the filter without a Cloudflare domain is refused plainly.
    const d = await deps();
    const error = await runInterview(d, {
      answers: {
        ...BASE,
        provider: "own",
        "server.host": IPV4,
        "server.user": "root",
        "server.serve": "proxy",
      },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(/only be served with DNS only/),
    });
  });

  it("reuses the saved answers when none are given and fails plainly without any", async () => {
    const d = await deps();
    const error = await runInterview(d, { answers: { ...BASE, provider: "own" } }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(/server\.host/),
    });
    await expect(readFile(d.paths.files.requirements, "utf8")).rejects.toThrow();
    await runInterview(d, {
      answers: { ...BASE, provider: "own", "server.host": IPV4, "server.user": "root" },
    });
    const again = await runInterview(d, { answers: { ...BASE, provider: "own" } });
    expect(again.ownServer).toMatchObject({ host: IPV4, user: "root", agent: true });
  });

  it("keeps the pinned host key for the same server and drops it when the server changes", async () => {
    const d = await deps();
    const pinned = {
      host: IPV4,
      user: "root",
      keyPath: "/home/me/.ssh/id_ed25519",
      agent: false,
      hostKey: HOST_KEY,
      publicIpv4: IPV4,
    };
    await recordOwnServer(d.paths, pinned);
    await runInterview(d, {
      answers: { ...BASE, provider: "own", server: { host: IPV4, user: "admin", key: "agent" } },
    });
    expect(await readOwnServer(d.paths)).toEqual({
      host: IPV4,
      port: 22,
      user: "admin",
      agent: true,
      reachable: true,
      serve: "dns-only",
      hostKey: HOST_KEY,
      publicIpv4: IPV4,
    });

    // Another port on the same address may be another machine (port forwarding): ask again.
    await runInterview(d, {
      answers: { ...BASE, provider: "own", server: { port: 2222 } },
    });
    expect(await readOwnServer(d.paths)).toEqual({
      host: IPV4,
      port: 2222,
      user: "admin",
      agent: true,
      reachable: true,
      serve: "dns-only",
    });

    await recordOwnServer(d.paths, pinned);
    await runInterview(d, {
      answers: { ...BASE, provider: "own", server: { host: "198.51.100.7", user: "root" } },
    });
    const moved = await readOwnServer(d.paths);
    expect(moved).toMatchObject({ host: "198.51.100.7", user: "root" });
    expect(moved?.hostKey).toBeUndefined();
    expect(moved?.publicIpv4).toBeUndefined();
    // The pinned key path is reused as the default key.
    expect(moved).toMatchObject({ agent: false, keyPath: "/home/me/.ssh/id_ed25519" });
  });

  it("ignores server answers for a cloud provider, with a warning", async () => {
    const d = await deps();
    const result = await runInterview(d, {
      answers: { ...BASE, region: "eu-central", "server.host": IPV4 },
    });
    expect(result.ownServer).toBeUndefined();
    expect(result.requirements.provider).toBe("hetzner");
    expect(d.reporter.text()).toMatch(/server\.\*\) were ignored/);
    expect(await readOwnServer(d.paths)).toBeUndefined();
  });

  it("keeps a damaged server record aside, never deleting it, once new answers are valid", async () => {
    const d = await deps();
    await mkdir(d.paths.stateDir, { recursive: true });
    await writeFile(serverAddressesFile(d.paths), "{ not json");
    // Invalid answers change nothing.
    const error = await runInterview(d, {
      answers: { ...BASE, provider: "own", "server.user": "root" },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(await readFile(serverAddressesFile(d.paths), "utf8")).toBe("{ not json");

    const result = await runInterview(d, {
      answers: { ...BASE, provider: "own", "server.host": IPV4, "server.user": "root" },
    });
    expect(result.ownServer?.host).toBe(IPV4);
    expect(await readFile(damagedServerAddressesFile(d.paths), "utf8")).toBe("{ not json");
    expect(await readOwnServer(d.paths)).toMatchObject({ host: IPV4, user: "root" });
    expect(d.reporter.text()).toMatch(/is damaged, so your earlier answers are not pre-filled/);
    expect(d.reporter.text()).toMatch(
      /Kept the damaged record as \.opscrew\/server\.json\.damaged .*confirm your server's host key again/,
    );
  });

  it("leaves a damaged server record alone for a cloud provider", async () => {
    const d = await deps();
    await mkdir(d.paths.stateDir, { recursive: true });
    await writeFile(serverAddressesFile(d.paths), "{ not json");
    await runInterview(d, { answers: { ...BASE, region: "eu-central" } });
    expect(await readFile(serverAddressesFile(d.paths), "utf8")).toBe("{ not json");
  });
});

describe("a server at home", () => {
  const LAN = "192.168.1.30";
  const base = { host: LAN, user: "ana", key: "agent" };
  const cloudflare = { cloudflareDomain: true, domain: "shop.example.com" };

  it("asks whether the server is at home right after its address, with the ISP's terms", () => {
    const questions = buildServerQuestions();
    expect(questions.map((q) => q.id).slice(0, 2)).toEqual(["server.host", "server.home"]);
    const home = questions.find((q) => q.id === "server.home");
    expect(home).toMatchObject({ kind: "confirm", default: false, required: true });
    expect(home?.help).toMatch(/internet provider's terms.*residential plans often restrict/);
    expect(home?.help).toMatch(/large media.*Cloudflare's proxy/);
    // server.sshFrom is for answers files only.
    expect(questions.map((q) => q.id)).not.toContain("server.sshFrom");
    expect(SERVER_FIELDS).toContain("sshFrom");
  });

  it("defaults to home for a private or local address, else the earlier answer, else no", () => {
    expect(answersToOwnServer(split(base)).home).toEqual({});
    expect(answersToOwnServer(split({ ...base, host: "pi.local" })).home).toEqual({});
    expect(answersToOwnServer(split({ ...base, host: IPV4 })).home).toBeUndefined();
    const previous = { host: IPV4, port: 22, user: "ana", agent: true, serve: "proxy" as const };
    const atHome = { ...previous, home: {} };
    expect(answersToOwnServer(split({}), { previous: atHome }).home).toEqual({});
    expect(
      buildServerQuestions({ previous: atHome }).find((q) => q.id === "server.home"),
    ).toMatchObject({ default: true });
    // The earlier "no" for the same address stays, even when it is private.
    const notHome = { ...previous, host: LAN, reachable: false, serve: "tunnel" as const };
    expect(answersToOwnServer(split({}), { previous: notHome })).toMatchObject({
      reachable: false,
      serve: "tunnel",
    });
    expect(answersToOwnServer(split({}), { previous: notHome }).home).toBeUndefined();
    // A new private address is at home again.
    expect(answersToOwnServer(split({ host: "10.0.0.5" }), { previous: notHome }).home).toEqual({});
    expect(answersToOwnServer(split({ ...base, home: "no" })).home).toBeUndefined();
    expect(() => answersToOwnServer(split({ ...base, home: "maybe" }))).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/server\.home: answer yes or no/) }),
    );
  });

  it("doesn't take server.reachable at home, and refuses it in plain words", () => {
    const answers = answersToOwnServer(split({ ...base, home: "yes" }), cloudflare);
    expect(answers).toEqual({
      host: LAN,
      port: 22,
      user: "ana",
      agent: true,
      home: {},
      serve: "proxy",
    });
    expect(answers.reachable).toBeUndefined();
    for (const reachable of ["yes", "no"]) {
      expect(() => answersToOwnServer(split({ ...base, home: "yes", reachable }))).toThrow(
        expect.objectContaining({
          code: "INVALID_INPUT",
          message: expect.stringContaining(
            "server.reachable: a server at home is reached through your router's forwards; remove `server.reachable`",
          ),
        }),
      );
    }
    // Away from home it is taken as before.
    expect(answersToOwnServer(split({ ...base, home: "no", reachable: "yes" })).reachable).toBe(
      true,
    );
  });

  it("offers the proxy first at home, DNS only without a Cloudflare domain, and the tunnel", () => {
    const previous = { host: LAN, port: 22, user: "ana", agent: true, home: {} };
    const serve = buildServerQuestions({ previous, ...cloudflare }).find(
      (q) => q.id === "server.serve",
    );
    expect(serve).toMatchObject({ kind: "single-select", default: "proxy" });
    expect(serve?.options?.map((o) => o.value)).toEqual(["proxy", "dns-only", "tunnel"]);
    expect(serve?.options?.[0]?.label).toMatch(/home's address, behind Cloudflare's proxy/);
    expect(serve?.options?.[1]?.label).toMatch(/home's address, DNS only/);
    expect(serve?.options?.[2]?.hint).toMatch(/any connection, with no forwards/);
    const only = buildServerQuestions({ previous, cloudflareDomain: false }).find(
      (q) => q.id === "server.serve",
    );
    expect(only?.options?.map((o) => o.value)).toEqual(["dns-only"]);

    expect(answersToOwnServer(split(base), cloudflare).serve).toBe("proxy");
    expect(answersToOwnServer(split(base), { cloudflareDomain: false }).serve).toBe("dns-only");
    for (const value of ["tunnel", "dns-only"]) {
      expect(answersToOwnServer(split({ ...base, serve: value }), cloudflare).serve).toBe(value);
    }
    expect(() =>
      answersToOwnServer(split({ ...base, serve: "tunnel" }), { cloudflareDomain: false }),
    ).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/only be served with DNS only/) }),
    );
    // The earlier home answer is kept; an earlier answer away from home is not.
    const tunnelAtHome = { ...previous, serve: "tunnel" as const };
    expect(answersToOwnServer(split({}), { previous: tunnelAtHome, ...cloudflare }).serve).toBe(
      "tunnel",
    );
    const away = { host: IPV4, port: 22, user: "ana", agent: true, reachable: true };
    expect(
      answersToOwnServer(split({ home: "yes" }), {
        previous: { ...away, serve: "dns-only" },
        ...cloudflare,
      }).serve,
    ).toBe("proxy");
  });

  it("serves an IPv6-only home address behind the proxy, and keeps the domain check", () => {
    expect(
      answersToOwnServer(split({ ...base, host: "fd00::30", serve: "proxy" }), cloudflare).serve,
    ).toBe("proxy");
    const deep = { cloudflareDomain: true, domain: "api.shop.example.com" };
    for (const serve of ["proxy", "tunnel"]) {
      expect(() => answersToOwnServer(split({ ...base, serve }), deep)).toThrow(
        expect.objectContaining({
          message: expect.stringMatching(
            /would fail HTTPS at Cloudflare's edge.*serve it with DNS only \(server\.serve dns-only\)/,
          ),
        }),
      );
    }
    expect(answersToOwnServer(split({ ...base, serve: "dns-only" }), deep).serve).toBe("dns-only");
  });

  it("takes server.sshFrom at home: up to 32 sources, in the form nft prints them", () => {
    const answers = answersToOwnServer(
      split({ ...base, sshFrom: "192.168.1.7/24  10.8.0.0/24 2001:DB8::/32 192.168.1.0/24" }),
    );
    expect(answers.home).toEqual({ sshFrom: ["192.168.1.0/24", "10.8.0.0/24", "2001:db8::/32"] });
    expect(answersToOwnServer(split({ ...base, sshFrom: ["203.0.113.7/32"] })).home).toEqual({
      sshFrom: ["203.0.113.7"],
    });
    // The earlier sources stay for the same server.
    const previous = {
      host: LAN,
      port: 22,
      user: "ana",
      agent: true,
      home: { sshFrom: ["10.8.0.0/24"] },
    };
    expect(answersToOwnServer(split({}), { previous }).home).toEqual({ sshFrom: ["10.8.0.0/24"] });
    expect(answersToOwnServer(split({ host: "192.168.2.30" }), { previous }).home).toEqual({});

    const many = Array.from({ length: 33 }, (_, i) => `10.${i}.0.0/16`).join(" ");
    expect(() => answersToOwnServer(split({ ...base, sshFrom: many }))).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/at most 32 sources \(there are 33\)/),
      }),
    );
    expect(() => answersToOwnServer(split({ ...base, home: "no", sshFrom: "10.0.0.0/8" }))).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/server\.sshFrom: only a server at home/),
      }),
    );
  });

  it("refuses sources that aren't addresses or networks without echoing them", () => {
    const near = "203.0.113.77/33";
    const error = (() => {
      try {
        answersToOwnServer(split({ ...base, sshFrom: `10.0.0.0/8 ${near} 0.0.0.0/0 ::1` }));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(error?.message).toMatch(
      /server\.sshFrom: sources 2, 3 and 4 are not addresses or networks/,
    );
    expect(error?.message).not.toContain("203.0.113.77");
  });

  it("saves the answers on this computer only, with no public address", async () => {
    const d = await deps();
    // A public address an earlier run kept for the same server is dropped.
    const detected = "198.51.100.73";
    await recordOwnServer(d.paths, {
      host: LAN,
      user: "ana",
      agent: true,
      reachable: true,
      serve: "proxy",
      hostKey: HOST_KEY,
      publicIpv4: detected,
    });
    const result = await runInterview(d, {
      answers: {
        ...BASE,
        provider: "own",
        domain: "shop.example.com",
        dnsProvider: "cloudflare",
        server: { ...base, home: "yes", serve: "proxy", sshFrom: "192.168.1.0/24 10.8.0.0/24" },
      },
    });
    const home = { sshFrom: ["192.168.1.0/24", "10.8.0.0/24"] };
    expect(result.ownServer).toEqual({
      host: LAN,
      port: 22,
      user: "ana",
      agent: true,
      home,
      serve: "proxy",
    });
    expect(await readOwnServer(d.paths)).toEqual({
      host: LAN,
      port: 22,
      user: "ana",
      agent: true,
      home,
      serve: "proxy",
      hostKey: HOST_KEY,
    });
    // Leak check: the home's addresses reach no output and no committed file.
    const everything = [
      await readFile(d.paths.files.requirements, "utf8"),
      JSON.stringify(await d.state.read()),
      d.reporter.text(),
    ].join("\n");
    for (const hidden of [LAN, detected, "192.168.1.0/24", "10.8.0.0/24"]) {
      expect(everything).not.toContain(hidden);
    }
    expect(await readFile(serverAddressesFile(d.paths), "utf8")).not.toContain(detected);
  });

  /**
   * A terminal's three rounds: `host` typed first, then `home` (the offered default when not
   * given), then each other question's default with the user and key given. Answers the rounds'
   * questions and the interview's result.
   */
  async function terminal(typed: { host: string; home?: boolean }, d?: PhaseDepsOf) {
    const rounds: ServerQuestion[][] = [];
    const result = await runInterview(d ?? (await deps()), {
      ask: async () => ({
        ...BASE,
        provider: "own",
        domain: "shop.example.com",
        dnsProvider: "cloudflare",
      }),
      askServer: async (questions) => {
        rounds.push(questions);
        const answers: InterviewAnswers = {};
        for (const q of questions) answers[q.id] = q.default;
        if (questions.some((q) => q.id === "server.host")) answers["server.host"] = typed.host;
        if (typed.home !== undefined && "server.home" in answers) {
          answers["server.home"] = typed.home;
        }
        if ("server.user" in answers) Object.assign(answers, { "server.user": "ana" });
        return answers;
      },
    });
    const question = (id: string) => rounds.flat().find((q) => q.id === id);
    return { rounds, question, result };
  }

  it("asks the address, then server.home with the default for that address, then the rest", async () => {
    const { rounds, question, result } = await terminal({ host: LAN });
    expect(rounds.map((round) => round.map((q) => q.id))).toEqual([
      ["server.kind"],
      ["server.host"],
      ["server.home"],
      // At home, server.reachable isn't asked: the router's forwards reach the server.
      ["server.port", "server.user", "server.key", "server.serve"],
    ]);
    expect(question("server.home")).toMatchObject({ default: true });
    // Answered yes: the home labels, with Cloudflare's proxy recommended and preselected.
    const serve = question("server.serve");
    expect(serve?.prompt).toBe("How should your server at home serve the site?");
    expect(serve?.default).toBe("proxy");
    expect(serve?.options?.[0]).toMatchObject({
      value: "proxy",
      label: "From your home's address, behind Cloudflare's proxy (recommended)",
    });
    expect(result.ownServer).toMatchObject({ host: LAN, home: {}, serve: "proxy" });
    expect(result.ownServer?.reachable).toBeUndefined();
  });

  it("defaults to no for a public address, and a local name is at home", async () => {
    expect((await terminal({ host: IPV4 })).question("server.home")).toMatchObject({
      default: false,
    });
    expect((await terminal({ host: "pi.local" })).question("server.home")).toMatchObject({
      default: true,
    });
  });

  it("answered no on a private address: the other labels, and server.reachable asked", async () => {
    const { rounds, question, result } = await terminal({ host: LAN, home: false });
    expect(question("server.home")).toMatchObject({ default: true });
    expect(rounds[3]?.map((q) => q.id)).toEqual([
      "server.port",
      "server.user",
      "server.key",
      "server.reachable",
      "server.serve",
    ]);
    const serve = question("server.serve");
    expect(serve?.prompt).toBe(
      "If the internet can reach your server, how should it serve the site?",
    );
    expect(serve?.default).toBe("tunnel");
    expect(serve?.options?.[0]).toMatchObject({
      value: "tunnel",
      label: "Through a Cloudflare Tunnel (recommended)",
    });
    expect(question("server.reachable")).toMatchObject({ default: false });
    expect(result.ownServer?.home).toBeUndefined();
  });

  it("keeps the earlier answer for the same address as the default", async () => {
    const d = await deps();
    await recordOwnServer(d.paths, {
      host: LAN,
      port: 22,
      user: "ana",
      agent: true,
      reachable: false,
      serve: "tunnel",
    });
    expect((await terminal({ host: LAN }, d)).question("server.home")).toMatchObject({
      default: false,
    });
    // Another private address is at home by default again.
    expect((await terminal({ host: "10.0.0.5" }, d)).question("server.home")).toMatchObject({
      default: true,
    });
  });

  it("an answers file is taken as it is: no question is asked", async () => {
    const d = await deps();
    const result = await runInterview(d, {
      answers: {
        ...BASE,
        provider: "own",
        domain: "shop.example.com",
        dnsProvider: "cloudflare",
        "server.host": LAN,
        "server.user": "ana",
        "server.sshFrom": "192.168.1.0/24",
      },
      askServer: async () => {
        throw new Error("asked a question with an answers file");
      },
    });
    expect(result.ownServer).toMatchObject({
      host: LAN,
      home: { sshFrom: ["192.168.1.0/24"] },
      serve: "proxy",
    });
  });
});

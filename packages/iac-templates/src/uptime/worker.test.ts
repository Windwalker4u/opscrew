import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readUptimeScript } from "../../scripts/gen-modules";
import worker, {
  runUptime,
  type UptimeEntry,
  type UptimeEnv,
  type UptimeKv,
  type UptimeState,
} from "../../uptime/worker.mjs";

const START = Date.parse("2026-11-25T10:00:00Z");
const FIVE_MINUTES = 5 * 60_000;
const ID = "acme/shop/shop/prod";
const SECRET = "HOOK_3f2a9c0d11e4b7a8";

/** Made at run time, so no secret-shaped literal is committed. */
const WEBHOOK = `https://hooks.example.com/opscrew/${fakeSecret("generic-password", "webhook")}`;
const NTFY_TOKEN = fakeSecret("generic-password", "ntfy");
const IN_BODY = fakeSecret("stripe-live-key", "body");

/** Workers KV as a `Map`, counting writes and deletes. */
class FakeKv implements UptimeKv {
  readonly data = new Map<string, string>();
  writes = 0;
  deletes = 0;
  async list({ prefix }: { prefix: string }) {
    const names = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
    return { keys: names.map((name) => ({ name })), list_complete: true };
  }
  async get(key: string, type: "json") {
    expect(type).toBe("json");
    const value = this.data.get(key);
    return value === undefined ? null : JSON.parse(value);
  }
  async put(key: string, value: string) {
    this.writes++;
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.deletes++;
    this.data.delete(key);
  }
}

/** What a hostname answers: a status, or a thrown error. */
type Answer = number | Error;

interface Post {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: string;
}

/** An entry with `hostnames` (or one, `shop.example.com`), posting to ntfy unless told otherwise. */
function entry(o: Partial<UptimeEntry> & { hostnames?: string[] } = {}): UptimeEntry {
  const { hostnames = ["shop.example.com"], ...rest } = o;
  return {
    version: 1,
    repository: "acme/shop",
    app: "shop",
    environment: "prod",
    hosts: hostnames.map((hostname) => ({ hostname, healthPath: "/health" })),
    webhook: "ntfy",
    secret: SECRET,
    ...rest,
  };
}

/** The account: its KV, what each hostname answers, the webhook's answer, and the clock. */
class World {
  readonly kv = new FakeKv();
  readonly answers = new Map<string, Answer>();
  /** Every hostname fetch, by hostname. */
  readonly fetched: { hostname: string; init: RequestInit }[] = [];
  readonly posts: Post[] = [];
  webhookStatus = 200;
  now = START;
  secrets: Record<string, string> = { [SECRET]: JSON.stringify({ url: WEBHOOK }) };
  /** How long a hostname takes to answer, in microtask turns (for the pool). */
  delay = 0;
  inFlight = 0;
  maxInFlight = 0;

  constructor(...entries: [string, UptimeEntry][]) {
    for (const [id, value] of entries.length === 0 ? [[ID, entry()] as const] : entries) {
      this.kv.data.set(`entry:${id}`, JSON.stringify(value));
    }
  }

  answer(status: Answer, ...hostnames: string[]) {
    for (const hostname of hostnames.length === 0 ? ["shop.example.com"] : hostnames) {
      this.answers.set(hostname, status);
    }
  }

  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url === WEBHOOK) {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      this.posts.push({ url, init, headers, body: String(init.body) });
      return new Response("accepted", { status: this.webhookStatus });
    }
    const { hostname, pathname } = new URL(url);
    expect(pathname).toBe("/health");
    this.fetched.push({ hostname, init });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    for (let i = 0; i < this.delay; i++) await Promise.resolve();
    this.inFlight--;
    const answer = this.answers.get(hostname) ?? 200;
    if (answer instanceof Error) throw answer;
    const body = [204, 205, 304].includes(answer) ? null : `the app's answer ${IN_BODY}`;
    return new Response(body, { status: answer });
  }) as typeof fetch;

  /** One scheduled run, then five minutes pass. */
  async run() {
    const env: UptimeEnv = { UPTIME: this.kv, ...this.secrets };
    await runUptime(env, { fetch: this.fetch, now: () => this.now });
    this.now += FIVE_MINUTES;
  }

  state(id = ID): UptimeState | undefined {
    const value = this.kv.data.get(`state:${id}`);
    return value === undefined ? undefined : JSON.parse(value);
  }

  fetchesOf(hostname: string) {
    return this.fetched.filter((f) => f.hostname === hostname).length;
  }
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runUptime's transitions", () => {
  it("an up hostname: one fetch per run, no post and no KV write", async () => {
    const world = new World();
    await world.run();
    await world.run();
    expect(world.fetchesOf("shop.example.com")).toBe(2);
    expect(world.posts).toEqual([]);
    expect(world.kv.writes + world.kv.deletes).toBe(0);
  });

  it("up, then a failure: writes suspect once, with this run's time, and posts nothing", async () => {
    const world = new World();
    world.answer(502);
    await world.run();
    expect(world.state()).toEqual({
      hosts: {
        "shop.example.com": {
          status: "suspect",
          since: "2026-11-25T10:00:00Z",
          reason: "answered with status 502",
        },
      },
    });
    expect(world.kv.writes).toBe(1);
    expect(world.posts).toEqual([]);
  });

  it("a blip: a success from suspect clears it with one delete and posts nothing", async () => {
    const world = new World();
    world.answer(502);
    await world.run();
    world.answer(200);
    await world.run();
    expect(world.state()).toBeUndefined();
    expect([world.kv.writes, world.kv.deletes]).toEqual([1, 1]);
    expect(world.posts).toEqual([]);
  });

  it("down: the second failure writes down once, keeps since, and posts once; a third posts and writes nothing", async () => {
    const world = new World();
    world.answer(new TypeError("fetch failed"));
    await world.run();
    await world.run();
    expect(world.state()?.hosts["shop.example.com"]).toEqual({
      status: "down",
      since: "2026-11-25T10:00:00Z",
      reason: "not reachable",
    });
    expect(world.kv.writes).toBe(2);
    expect(world.posts.map((p) => p.body)).toEqual([
      "OpsCrew uptime check: shop (prod) is down on shop.example.com: not reachable, since 2026-11-25 10:00 UTC. Run npx opscrew status to see more.",
    ]);
    await world.run();
    expect(world.posts).toHaveLength(1);
    expect([world.kv.writes, world.kv.deletes]).toEqual([2, 0]);
  });

  it("recovered: a 2xx after down posts up again with the time since since, and deletes the key", async () => {
    const world = new World();
    world.answer(503);
    await world.run();
    await world.run();
    await world.run();
    world.answer(204);
    await world.run();
    expect(world.posts.map((p) => p.body).at(-1)).toBe(
      "OpsCrew uptime check: shop (prod) is up again on shop.example.com, after 15 minutes.",
    );
    expect(world.posts).toHaveLength(2);
    expect(world.state()).toBeUndefined();
    expect(world.kv.data.has(`state:${ID}`)).toBe(false);
    expect(world.kv.deletes).toBe(1);
  });

  it("recovered: a 3xx counts too, and a long outage reads in hours", async () => {
    const world = new World();
    world.answer(500);
    await world.run();
    await world.run();
    world.now = START + 65 * 60_000;
    world.answer(302);
    await world.run();
    expect(world.posts.at(-1)?.body).toBe(
      "OpsCrew uptime check: shop (prod) is up again on shop.example.com, after 1 hour 5 minutes.",
    );
  });

  it("no retry inside a run: a failing hostname is fetched once per run", async () => {
    const world = new World();
    world.answer(new TypeError("fetch failed"));
    await world.run();
    expect(world.fetchesOf("shop.example.com")).toBe(1);
    await world.run();
    expect(world.fetchesOf("shop.example.com")).toBe(2);
  });

  it("a failed post leaves the hostname suspect, writes nothing, and the next failing run posts again", async () => {
    const world = new World();
    world.answer(502);
    await world.run();
    world.webhookStatus = 500;
    await world.run();
    expect(world.posts).toHaveLength(1);
    expect(world.state()?.hosts["shop.example.com"]?.status).toBe("suspect");
    expect(world.kv.writes).toBe(1);
    expect(logs).toContain(`${ID}: the ntfy webhook failed (HTTP 500).`);
    world.webhookStatus = 200;
    await world.run();
    expect(world.posts).toHaveLength(2);
    expect(world.state()?.hosts["shop.example.com"]).toEqual({
      status: "down",
      since: "2026-11-25T10:00:00Z",
      reason: "answered with status 502",
    });
    expect(world.kv.writes).toBe(2);
  });

  it("a failed recovered post leaves the hostname down, and the next run posts it", async () => {
    const world = new World();
    world.answer(502);
    await world.run();
    await world.run();
    world.answer(200);
    world.webhookStatus = 502;
    await world.run();
    expect(world.state()?.hosts["shop.example.com"]?.status).toBe("down");
    world.webhookStatus = 200;
    await world.run();
    expect(world.posts.map((p) => p.headers.priority)).toEqual(["4", "3", "3"]);
    expect(world.state()).toBeUndefined();
  });
});

describe("runUptime's budget of 50 subrequests", () => {
  /** 8 entries of 5 hostnames each: 40 in all. */
  function forty(): World {
    const entries: [string, UptimeEntry][] = Array.from({ length: 8 }, (_, e) => [
      `acme/app${e}/app${e}/prod`,
      entry({
        app: `app${e}`,
        hostnames: Array.from({ length: 5 }, (_, h) => `h${h}.app${e}.example.com`),
      }),
    ]);
    return new World(...entries);
  }

  it("with 40 hostnames, a run sends at most 10 posts, and the rest wait unwritten for the next run", async () => {
    const world = forty();
    for (let e = 0; e < 8; e++) {
      for (let h = 0; h < 5; h++) world.answer(500, `h${h}.app${e}.example.com`);
    }
    await world.run();
    expect(world.fetched).toHaveLength(40);
    expect(world.posts).toHaveLength(0);
    const writes = world.kv.writes;

    await world.run();
    expect(world.fetched).toHaveLength(80);
    expect(world.posts).toHaveLength(10);
    const states = () =>
      [...world.kv.data.entries()]
        .filter(([key]) => key.startsWith("state:"))
        .flatMap(([, value]) => Object.values((JSON.parse(value) as UptimeState).hosts));
    expect(states().filter((s) => s.status === "down")).toHaveLength(10);
    expect(states().filter((s) => s.status === "suspect")).toHaveLength(30);
    // Only the entries whose posts went out were written.
    expect(world.kv.writes - writes).toBe(2);

    await world.run();
    expect(world.posts).toHaveLength(20);
    expect(states().filter((s) => s.status === "down")).toHaveLength(20);
    await world.run();
    await world.run();
    expect(world.posts).toHaveLength(40);
    expect(states().every((s) => s.status === "down")).toBe(true);
  });

  it("past 40 hostnames, the run tries only the first 40 and says so", async () => {
    const world = new World([
      ID,
      entry({ hostnames: Array.from({ length: 45 }, (_, h) => `h${h}.example.com`) }),
    ]);
    await world.run();
    expect(world.fetched).toHaveLength(40);
    expect(logs).toContain(
      "45 hostnames are listed, more than the 40 one run can check, so the last 5 are not checked.",
    );
  });
});

describe("runUptime's requests", () => {
  it("fetches https://<hostname><health path> once, with redirect manual, its user agent and a 10-second timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const world = new World();
    await world.run();
    const [only] = world.fetched;
    expect(only?.init.redirect).toBe("manual");
    expect(new Headers(only?.init.headers).get("user-agent")).toBe("OpsCrew uptime check");
    expect(only?.init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("a 301 is up", async () => {
    const world = new World();
    world.answer(301);
    await world.run();
    await world.run();
    expect(world.kv.writes).toBe(0);
    expect(world.posts).toEqual([]);
  });

  it("never fetches more than 5 hostnames at once", async () => {
    const world = new World([
      ID,
      entry({ hostnames: Array.from({ length: 12 }, (_, h) => `h${h}.example.com`) }),
    ]);
    world.delay = 5;
    await world.run();
    expect(world.fetched).toHaveLength(12);
    expect(world.maxInFlight).toBe(5);
  });

  const reasons: [string, Answer, string][] = [
    ["a timeout", new DOMException("The operation timed out.", "TimeoutError"), "not reachable"],
    ["a thrown error", new TypeError("fetch failed"), "not reachable"],
    ...[520, 521, 522, 523, 524, 530].map((status): [string, Answer, string] => [
      `${status}`,
      status,
      "not reachable",
    ]),
    ["525", 525, "an invalid certificate"],
    ["526", 526, "an invalid certificate"],
    ["404", 404, "answered with status 404"],
  ];
  it.each(reasons)("%s gives %s", async (_, answer, reason) => {
    const world = new World();
    world.answer(answer);
    await world.run();
    expect(world.state()?.hosts["shop.example.com"]?.reason).toBe(reason);
    await world.run();
    expect(world.posts[0]?.body).toContain(`is down on shop.example.com: ${reason}, since`);
  });
});

describe("runUptime's messages", () => {
  /** Down, then recovered, through `webhook`. */
  async function downAndUp(world: World) {
    world.answer(502);
    await world.run();
    await world.run();
    world.answer(200);
    await world.run();
    return world.posts;
  }

  it("Slack: { text }, as JSON", async () => {
    const posts = await downAndUp(new World([ID, entry({ webhook: "slack" })]));
    expect(posts).toHaveLength(2);
    expect(posts[0]?.init.method).toBe("POST");
    expect(posts[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(posts[0]?.body ?? "")).toEqual({
      text: "OpsCrew uptime check: shop (prod) is down on shop.example.com: answered with status 502, since 2026-11-25 10:00 UTC. Run npx opscrew status to see more.",
    });
    expect(JSON.parse(posts[1]?.body ?? "").text).toContain("is up again");
  });

  it("Slack's text is cut at 4,000 characters", async () => {
    const posts = await downAndUp(
      new World([ID, entry({ webhook: "slack", app: "a".repeat(5000) })]),
    );
    const text: string = JSON.parse(posts[0]?.body ?? "").text;
    expect(text).toHaveLength(4000);
    expect(text.endsWith("…")).toBe(true);
  });

  it("Discord: { content, allowed_mentions: { parse: [] } }, cut at 2,000", async () => {
    const posts = await downAndUp(
      new World([ID, entry({ webhook: "discord", app: "a".repeat(3000) })]),
    );
    const body = JSON.parse(posts[0]?.body ?? "");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toHaveLength(2000);
    expect(body.content.startsWith("OpsCrew uptime check: aaa")).toBe(true);
  });

  it("ntfy: a plain-text body, its Title, Priority 4 down and 3 up, and no Authorization without a token", async () => {
    const posts = await downAndUp(new World());
    expect(posts.map((p) => p.headers.priority)).toEqual(["4", "3"]);
    expect(posts.map((p) => p.headers.title)).toEqual([
      "OpsCrew uptime check: shop (prod) is down",
      "OpsCrew uptime check: shop (prod) is up again",
    ]);
    expect(posts[0]?.body).toMatch(/^OpsCrew uptime check: shop \(prod\) is down on /);
    expect(posts.every((p) => p.headers.authorization === undefined)).toBe(true);
  });

  it("ntfy: Authorization: Bearer <token> when the secret has a token", async () => {
    const world = new World();
    world.secrets = { [SECRET]: JSON.stringify({ url: WEBHOOK, token: NTFY_TOKEN }) };
    const posts = await downAndUp(world);
    expect(posts.map((p) => p.headers.authorization)).toEqual([
      `Bearer ${NTFY_TOKEN}`,
      `Bearer ${NTFY_TOKEN}`,
    ]);
  });

  it("no message or log line holds the app's answer, the webhook's address or the token", async () => {
    const world = new World();
    world.secrets = { [SECRET]: JSON.stringify({ url: WEBHOOK, token: NTFY_TOKEN }) };
    world.webhookStatus = 500;
    world.answer(500);
    await world.run();
    await world.run();
    world.webhookStatus = 200;
    await world.run();
    expect(world.posts.length).toBeGreaterThan(0);
    const said = [...logs, ...world.posts.map((p) => `${p.body} ${p.headers.title}`)].join("\n");
    for (const secret of [IN_BODY, WEBHOOK, "hooks.example.com", NTFY_TOKEN]) {
      expect(said).not.toContain(secret);
    }
    for (const [, value] of world.kv.data) expect(value).not.toContain("hooks.example.com");
  });

  it("logs one line per entry with its counts of up, suspect and down", async () => {
    const world = new World([
      ID,
      entry({ hostnames: ["a.example.com", "b.example.com", "c.example.com"] }),
    ]);
    world.answer(500, "a.example.com", "b.example.com");
    await world.run();
    world.answer(200, "b.example.com");
    world.answer(500, "c.example.com");
    logs = [];
    await world.run();
    expect(logs).toEqual([`${ID}: 1 up, 1 suspect, 1 down.`]);
  });
});

describe("runUptime's odd entries", () => {
  it("an entry whose secret is missing is skipped with one log line", async () => {
    const other = "acme/blog/blog/prod";
    const world = new World(
      [ID, entry()],
      [
        other,
        entry({ app: "blog", secret: "HOOK_0000000000000000", hostnames: ["blog.example.com"] }),
      ],
    );
    world.answer(500, "shop.example.com", "blog.example.com");
    await world.run();
    await world.run();
    expect(world.fetchesOf("blog.example.com")).toBe(0);
    expect(world.state(other)).toBeUndefined();
    expect(logs.filter((line) => line.startsWith(`${other}:`))).toEqual([
      `${other}: its webhook secret HOOK_0000000000000000 is not set, so this run skips it.`,
      `${other}: its webhook secret HOOK_0000000000000000 is not set, so this run skips it.`,
    ]);
    // The other entry goes on as usual.
    expect(world.posts).toHaveLength(1);
  });

  it("a hostname dropped from its entry leaves the state at the next write, with no message", async () => {
    const world = new World([ID, entry({ hostnames: ["a.example.com", "b.example.com"] })]);
    world.answer(500, "a.example.com", "b.example.com");
    await world.run();
    await world.run();
    expect(world.posts).toHaveLength(2);
    world.kv.data.set(`entry:${ID}`, JSON.stringify(entry({ hostnames: ["b.example.com"] })));
    const writes = world.kv.writes;
    await world.run();
    // Nothing changed for b, so nothing is written, and a stays until the next write.
    expect(world.kv.writes).toBe(writes);
    expect(Object.keys(world.state()?.hosts ?? {})).toEqual(["a.example.com", "b.example.com"]);
    world.answer(200, "b.example.com");
    await world.run();
    expect(world.posts).toHaveLength(3);
    expect(world.posts[2]?.body).toContain("is up again on b.example.com");
    expect(world.state()).toBeUndefined();
  });
});

describe("the Worker's script", () => {
  it("has no imports", () => {
    expect(readUptimeScript()).not.toMatch(/^\s*import\b/m);
    expect(readUptimeScript()).not.toMatch(/\bimport\s*\(/);
  });

  it("its default scheduled handler runs runUptime inside ctx.waitUntil, with the runtime's fetch", async () => {
    const world = new World();
    vi.stubGlobal("fetch", world.fetch);
    const waited: Promise<unknown>[] = [];
    await worker.scheduled(
      {},
      { UPTIME: world.kv, ...world.secrets },
      { waitUntil: (promise) => waited.push(promise) },
    );
    expect(waited).toHaveLength(1);
    await waited[0];
    expect(world.fetchesOf("shop.example.com")).toBe(1);
  });
});

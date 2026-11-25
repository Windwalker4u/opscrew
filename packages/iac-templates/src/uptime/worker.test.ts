import { createHash, type webcrypto } from "node:crypto";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readUptimeScript } from "../../scripts/gen-modules";
import worker, {
  handleReport,
  runUptime,
  type UptimeEntry,
  type UptimeEnv,
  type UptimeKv,
  type UptimeReport,
  type UptimeServerReport,
  type UptimeState,
} from "../../uptime/worker.mjs";

const START = Date.parse("2026-11-25T10:00:00Z");
const FIVE_MINUTES = 5 * 60_000;
const HOUR = 3_600_000;
const ID = "acme/shop/shop/prod";
/** The entry's secret's name, as OpsCrew and the Worker compute it from the id. */
const SECRET = `HOOK_${createHash("sha256").update(ID).digest("hex").slice(0, 16)}`;
const SERVER = "hetzner-shop";
const REPORT_KEY = `report:${ID}/${SERVER}`;

/** Made at run time, so no secret-shaped literal is committed. */
const WEBHOOK = `https://hooks.example.com/opscrew/${fakeSecret("generic-password", "webhook")}`;
const NTFY_TOKEN = fakeSecret("generic-password", "ntfy");
const IN_BODY = fakeSecret("stripe-live-key", "body");

/** The environment's report key, made in the test, and another one. */
let reportKey: webcrypto.CryptoKey;
let reportHex: string;
let otherKey: webcrypto.CryptoKey;
beforeAll(async () => {
  const make = () =>
    crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, true, ["sign"]);
  reportKey = await make();
  otherKey = await make();
  reportHex = Buffer.from(await crypto.subtle.exportKey("raw", reportKey)).toString("hex");
});

/** The hex HMAC-SHA256 of `data` with `key`, as the server's script signs. */
async function sign(key: webcrypto.CryptoKey, data: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Buffer.from(mac).toString("hex");
}

/** Workers KV as a `Map`, with each key's metadata, recording every operation. */
class FakeKv implements UptimeKv {
  readonly data = new Map<string, string>();
  readonly metadata = new Map<string, unknown>();
  /** Every operation, in order: `list`, `get <key>`, `put <key>` and `delete <key>`. */
  readonly ops: string[] = [];
  get writes() {
    return this.ops.filter((op) => op.startsWith("put ")).length;
  }
  get deletes() {
    return this.ops.filter((op) => op.startsWith("delete ")).length;
  }
  async list(options: { prefix?: string } = {}) {
    this.ops.push("list");
    const prefix = options.prefix ?? "";
    const names = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
    return {
      keys: names.map((name) =>
        this.metadata.has(name) ? { name, metadata: this.metadata.get(name) } : { name },
      ),
      list_complete: true,
    };
  }
  async get(key: string, type: "json") {
    this.ops.push(`get ${key}`);
    expect(type).toBe("json");
    const value = this.data.get(key);
    return value === undefined ? null : JSON.parse(value);
  }
  async put(key: string, value: string, options: { metadata?: unknown } = {}) {
    this.ops.push(`put ${key}`);
    this.data.set(key, value);
    if (options.metadata === undefined) this.metadata.delete(key);
    else this.metadata.set(key, options.metadata);
  }
  async delete(key: string) {
    this.ops.push(`delete ${key}`);
    this.data.delete(key);
    this.metadata.delete(key);
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

interface SendOptions {
  /** Unix seconds (or any text, as the header); this clock's by default. */
  time?: number | string;
  key?: webcrypto.CryptoKey;
  id?: string;
  /** The header's value, or `null` for none; a signature with `key` by default. */
  signature?: string | null;
  method?: string;
  path?: string;
}

/** A healthy server's report, with `o`'s checks. */
function report(o: Partial<UptimeReport> = {}): UptimeReport {
  return {
    version: 1,
    server: SERVER,
    kind: "change",
    disk: { status: "ok", percent: 40, free: 25_000_000_000, total: 42_949_672_960 },
    snapshot: { status: "ok", id: "20261125T030000Z" },
    drill: { status: "ok", result: "healthy", at: "2026-11-24T03:41:00Z" },
    certificates: [{ hostname: "shop.example.com", status: "ok", days: 60 }],
    ...o,
  };
}

/** The entry's server, listed an hour before {@link START}, with weekly drills. */
const LISTED = { id: SERVER, since: "2026-11-25T09:00:00Z", drill: "weekly" as const };

/** An account whose entry lists {@link SERVER}, with `o`'s fields. */
function reporting(o: Parameters<typeof entry>[0] = {}): World {
  return new World([ID, entry({ servers: [LISTED], ...o })]);
}

/** The account: its KV, what each hostname answers, the webhook's answer, and the clock. */
class World {
  readonly kv = new FakeKv();
  readonly answers = new Map<string, Answer>();
  /** Every hostname fetch, by hostname. */
  readonly fetched: { hostname: string; init: RequestInit }[] = [];
  readonly posts: Post[] = [];
  /** The webhook's answer, or the error its fetch throws. */
  webhookStatus: Answer = 200;
  now = START;
  secrets: Record<string, string> = {
    [SECRET]: JSON.stringify({ url: WEBHOOK, report: reportHex }),
  };
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
      if (this.webhookStatus instanceof Error) throw this.webhookStatus;
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

  /** The server's last accepted report, as the Worker keeps it. */
  stored(key = REPORT_KEY): UptimeServerReport | undefined {
    const value = this.kv.data.get(key);
    return value === undefined ? undefined : JSON.parse(value);
  }

  /** One request to the Worker's address, signed at this clock's time unless told otherwise. */
  async send(body: UptimeReport | string, o: SendOptions = {}): Promise<number> {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const time = String(o.time ?? Math.floor(this.now / 1000));
    const headers: Record<string, string> = {
      "user-agent": "OpsCrew uptime report",
      "x-opscrew-entry": o.id ?? ID,
      "x-opscrew-time": time,
    };
    const signature =
      o.signature === undefined ? await sign(o.key ?? reportKey, `${time}\n${text}`) : o.signature;
    if (signature !== null) headers["x-opscrew-signature"] = signature;
    const method = o.method ?? "POST";
    const request = new Request(`https://opscrew-uptime.acme.workers.dev${o.path ?? "/report"}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: text }),
    });
    const env: UptimeEnv = { UPTIME: this.kv, ...this.secrets };
    const response = await handleReport(request, env, { fetch: this.fetch, now: () => this.now });
    expect(await response.text()).toBe("");
    return response.status;
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

  it("past the cap, each entry's line counts only the hostnames tried, and names the rest not checked", async () => {
    const later = "acme/zzz/zzz/prod";
    const world = new World(
      [ID, entry({ hostnames: Array.from({ length: 38 }, (_, h) => `h${h}.example.com`) })],
      [
        later,
        entry({
          app: "zzz",
          hostnames: ["a.zzz.example.com", "b.zzz.example.com", "c.zzz.example.com"],
        }),
      ],
    );
    world.answer(500, "h0.example.com");
    await world.run();
    expect(world.fetched).toHaveLength(40);
    expect(logs).toContain(`${ID}: 37 up, 1 suspect, 0 down.`);
    expect(logs).toContain(`${later}: 2 up, 0 suspect, 0 down, 1 not checked.`);
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
  it.each([
    ["not JSON", "not json"],
    ["JSON without a string url", JSON.stringify({ token: "x" })],
  ])(
    "an entry whose secret is %s is skipped with one log line, and the others go on",
    async (_, value) => {
      const other = "acme/blog/blog/prod";
      const bad = "HOOK_1111111111111111";
      const world = new World(
        [ID, entry()],
        [other, entry({ app: "blog", secret: bad, hostnames: ["blog.example.com"] })],
      );
      world.secrets = { ...world.secrets, [bad]: value };
      world.answer(500, "shop.example.com", "blog.example.com");
      await world.run();
      await world.run();
      expect(world.fetchesOf("blog.example.com")).toBe(0);
      expect(world.state(other)).toBeUndefined();
      expect(logs.filter((line) => line.startsWith(`${other}:`))).toEqual([
        `${other}: its webhook secret ${bad} is not valid, so this run skips it.`,
        `${other}: its webhook secret ${bad} is not valid, so this run skips it.`,
      ]);
      expect(logs.join("\n")).not.toContain(value);
      expect(world.posts).toHaveLength(1);
    },
  );

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

  it("drops a hostname no longer in its entry from the state at once, with no message", async () => {
    const world = new World([ID, entry({ hostnames: ["a.example.com", "b.example.com"] })]);
    world.answer(500, "a.example.com", "b.example.com");
    await world.run();
    await world.run();
    expect(world.posts).toHaveLength(2);
    world.kv.data.set(`entry:${ID}`, JSON.stringify(entry({ hostnames: ["b.example.com"] })));
    const writes = world.kv.writes;
    await world.run();
    // a, down, left the entry: the state is written without it, and nothing is posted.
    expect(world.kv.writes).toBe(writes + 1);
    expect(Object.keys(world.state()?.hosts ?? {})).toEqual(["b.example.com"]);
    expect(world.posts).toHaveLength(2);
    // Nothing else changed, so the next run writes nothing.
    await world.run();
    expect(world.kv.writes).toBe(writes + 1);
    world.answer(200, "b.example.com");
    await world.run();
    expect(world.posts).toHaveLength(3);
    expect(world.posts[2]?.body).toContain("is up again on b.example.com");
    expect(world.state()).toBeUndefined();
  });

  it("drops a suspect hostname no longer in its entry too, deleting a state left empty", async () => {
    const world = new World([ID, entry({ hostnames: ["a.example.com", "b.example.com"] })]);
    world.answer(500, "a.example.com");
    await world.run();
    expect(world.state()?.hosts["a.example.com"]?.status).toBe("suspect");
    world.kv.data.set(`entry:${ID}`, JSON.stringify(entry({ hostnames: ["b.example.com"] })));
    await world.run();
    expect(world.state()).toBeUndefined();
    expect(world.posts).toEqual([]);
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

  it("its default fetch handler answers 404 to anything but POST /report, with no KV operation", async () => {
    const world = reporting();
    const response = await worker.fetch(new Request("https://opscrew-uptime.acme.workers.dev/"), {
      UPTIME: world.kv,
      ...world.secrets,
    });
    expect(response.status).toBe(404);
    expect(world.kv.ops).toEqual([]);
  });

  it("its default fetch handler takes a report signed at the runtime's clock", async () => {
    const world = reporting();
    vi.stubGlobal("fetch", world.fetch);
    const body = JSON.stringify(report({ disk: WARN }));
    const time = String(Math.floor(Date.now() / 1000));
    const response = await worker.fetch(
      new Request("https://opscrew-uptime.acme.workers.dev/report", {
        method: "POST",
        headers: {
          "x-opscrew-entry": ID,
          "x-opscrew-time": time,
          "x-opscrew-signature": await sign(reportKey, `${time}\n${body}`),
        },
        body,
      }),
      { UPTIME: world.kv, ...world.secrets },
    );
    expect(response.status).toBe(204);
    expect(world.posts).toHaveLength(1);
  });
});

/** A disk at 87%: `warn`. */
const WARN = { status: "warn", percent: 87, free: 5_368_709_120, total: 42_949_672_960 } as const;

/** A credential within its age. */
const OK_CREDENTIAL = { name: "deploy-key", status: "ok", days: 10, source: "rotated" } as const;

const DISK_HINT =
  "Old container images and logs usually fill it. To see more, run `npx opscrew status` in this repository; on the server, `docker system df` shows what Docker keeps.";

/** What the webhook got: ntfy's title, priority and body. */
function said(world: World) {
  return world.posts.map((p) => [p.headers.title, p.headers.priority, p.body]);
}

describe("handleReport's refusals before any KV operation", () => {
  it("a body over 4 KB: 413; 4,096 bytes is read", async () => {
    const world = reporting();
    const body = JSON.stringify(report());
    expect(await world.send(body + " ".repeat(4097 - body.length))).toBe(413);
    expect(await world.send(body + " ".repeat(100_000))).toBe(413);
    expect(world.kv.ops).toEqual([]);
    expect(await world.send(body + " ".repeat(4096 - body.length))).toBe(204);
  });

  it("a missing or wrong signature: 401", async () => {
    const world = reporting();
    const body = report({ disk: WARN });
    const time = Math.floor(world.now / 1000);
    expect(await world.send(body, { signature: null })).toBe(401);
    expect(await world.send(body, { key: otherKey })).toBe(401);
    expect(await world.send(body, { signature: "0".repeat(64) })).toBe(401);
    expect(await world.send(body, { signature: "not hex" })).toBe(401);
    // Signed over another body, or another time.
    const other = await sign(reportKey, `${time}\n${JSON.stringify(report())}`);
    expect(await world.send(body, { signature: other })).toBe(401);
    const earlier = await sign(reportKey, `${time - 1}\n${JSON.stringify(body)}`);
    expect(await world.send(body, { signature: earlier })).toBe(401);
    expect(world.kv.ops).toEqual([]);
    expect(world.posts).toEqual([]);
  });

  it("a time more than 5 minutes off the Worker's clock: 401; 5 minutes off is taken", async () => {
    const world = reporting();
    const now = Math.floor(world.now / 1000);
    expect(await world.send(report(), { time: now - 360 })).toBe(401);
    expect(await world.send(report(), { time: now + 360 })).toBe(401);
    expect(await world.send(report(), { time: now + 301 })).toBe(401);
    expect(world.kv.ops).toEqual([]);
    expect(await world.send(report(), { time: now - 300 })).toBe(204);
  });

  it("an entry whose secret is missing, or holds no report key: 401", async () => {
    const world = reporting();
    world.secrets = {};
    expect(await world.send(report())).toBe(401);
    world.secrets = { [SECRET]: JSON.stringify({ url: WEBHOOK }) };
    expect(await world.send(report())).toBe(401);
    world.secrets = { [SECRET]: "not json" };
    expect(await world.send(report())).toBe(401);
    // Another environment's secret, even with this key, never signs for this one.
    world.secrets = {
      HOOK_0000000000000000: JSON.stringify({ url: WEBHOOK, report: reportHex }),
    };
    expect(await world.send(report())).toBe(401);
    expect(world.kv.ops).toEqual([]);
  });

  it("no entry header, or a time that isn't Unix seconds: 401", async () => {
    const world = reporting();
    expect(await world.send(report(), { id: "" })).toBe(401);
    expect(await world.send(report(), { id: "shop" })).toBe(401);
    expect(await world.send(report(), { time: "soon" })).toBe(401);
    expect(await world.send(report(), { time: "" })).toBe(401);
    expect(world.kv.ops).toEqual([]);
  });

  it.each([
    ["GET", "/report"],
    ["PUT", "/report"],
    ["DELETE", "/report"],
    ["POST", "/"],
    ["POST", "/report/"],
    ["POST", "/reports"],
    ["GET", "/"],
  ])("%s %s: 404", async (method, path) => {
    const world = reporting();
    expect(await world.send(report(), { method, path })).toBe(404);
    expect(world.kv.ops).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["a field outside the shape", JSON.stringify({ ...report(), note: IN_BODY })],
    [
      "a field outside a check's shape",
      JSON.stringify(report({ disk: { status: "ok", log: IN_BODY } as never })),
    ],
    ["an unknown status", JSON.stringify(report({ disk: { status: "full" } as never }))],
    ["another version", JSON.stringify({ ...report(), version: 2 })],
    ["no drill", JSON.stringify({ ...report(), drill: undefined })],
    ["a disk warn without its figures", JSON.stringify(report({ disk: { status: "warn" } }))],
    ["a server id with a slash", JSON.stringify(report({ server: "a/b" }))],
    [
      "a certificate's days as text",
      JSON.stringify(
        report({
          certificates: [{ hostname: "shop.example.com", status: "warn", days: "9" as never }],
        }),
      ),
    ],
  ])("a signed body with %s: 400, before any KV operation", async (_, body) => {
    const world = reporting();
    expect(await world.send(body)).toBe(400);
    expect(world.kv.ops).toEqual([]);
  });
});

describe("handleReport's refusals after the reads", () => {
  it("a server the entry doesn't list: 401, after reading only the entry", async () => {
    const world = reporting();
    expect(await world.send(report({ server: "own-shop" }))).toBe(401);
    expect(world.kv.ops).toEqual([`get entry:${ID}`]);
    expect(world.posts).toEqual([]);
  });

  it("an entry with no servers, or none at all: 401, writing nothing", async () => {
    const world = new World();
    expect(await world.send(report())).toBe(401);
    world.kv.data.clear();
    expect(await world.send(report())).toBe(401);
    expect(world.kv.ops).toEqual([`get entry:${ID}`, `get entry:${ID}`]);
  });

  it("a replay, or a time not newer than the stored report's: 409, writing nothing", async () => {
    const world = reporting();
    const time = Math.floor(world.now / 1000);
    const failing = report({ disk: WARN });
    expect(await world.send(failing, { time })).toBe(204);
    expect(world.posts).toHaveLength(1);
    world.kv.ops.length = 0;
    world.now += 60_000;
    // The same signed request again, and an older one still within 5 minutes.
    expect(await world.send(failing, { time })).toBe(409);
    expect(await world.send(report(), { time: time - 60 })).toBe(409);
    expect(world.kv.ops).toEqual([
      `get entry:${ID}`,
      `get ${REPORT_KEY}`,
      `get entry:${ID}`,
      `get ${REPORT_KEY}`,
    ]);
    expect(world.posts).toHaveLength(1);
    expect(await world.send(report(), { time: time + 1 })).toBe(204);
  });
});

describe("handleReport's changes", () => {
  it("a disk going ok to warn posts one message, with the percentage and the free space, and writes report: once with { at }", async () => {
    const world = reporting();
    expect(await world.send(report())).toBe(204);
    expect(world.posts).toEqual([]);
    world.now += FIVE_MINUTES;
    world.kv.ops.length = 0;
    expect(await world.send(report({ disk: WARN }))).toBe(204);
    expect(said(world)).toEqual([
      [
        "OpsCrew check: shop (prod) disk over 85% full on hetzner-shop",
        "4",
        `The disk of the server hetzner-shop is 87% full: 5.4 GB free of 42.9 GB.\n\nSince 2026-11-25 10:05 UTC.\n\n${DISK_HINT}`,
      ],
    ]);
    expect(world.kv.ops).toEqual([`get entry:${ID}`, `get ${REPORT_KEY}`, `put ${REPORT_KEY}`]);
    const at = Math.floor(world.now / 1000);
    expect(world.kv.metadata.get(REPORT_KEY)).toEqual({ at });
    expect(world.stored()).toEqual({
      ...report({ disk: { ...WARN, since: "2026-11-25T10:05:00Z" } }),
      at,
    });
  });

  it("warn to high posts again, back to ok posts once that it recovered, and a percentage moving within warn posts nothing", async () => {
    const world = reporting();
    await world.send(report({ disk: WARN }));
    world.now += FIVE_MINUTES;
    await world.send(report({ disk: { ...WARN, percent: 89, free: 4_000_000_000 } }));
    expect(world.posts).toHaveLength(1);
    world.now += FIVE_MINUTES;
    await world.send(
      report({ disk: { ...WARN, status: "high", percent: 96, free: 1_700_000_000 } }),
    );
    world.now += FIVE_MINUTES;
    await world.send(report());
    world.now += FIVE_MINUTES;
    await world.send(report({ kind: "heartbeat" }));
    expect(said(world).slice(1)).toEqual([
      [
        "OpsCrew check: shop (prod) disk over 95% full on hetzner-shop",
        "4",
        `The disk of the server hetzner-shop is 96% full: 1.7 GB free of 42.9 GB.\n\nSince 2026-11-25 10:00 UTC.\n\n${DISK_HINT}`,
      ],
      [
        "OpsCrew check: resolved, shop (prod), the disk on hetzner-shop",
        "3",
        "Resolved after 15 minutes.",
      ],
    ]);
    // Every accepted report is kept: one write each.
    expect(world.kv.writes).toBe(5);
    expect(world.stored()?.disk).toEqual(report().disk);
  });

  it("Slack and Discord get the title and the text in one message", async () => {
    const slack = reporting({ webhook: "slack" });
    await slack.send(report({ disk: WARN }));
    expect(JSON.parse(slack.posts[0]?.body ?? "")).toEqual({
      text: `OpsCrew check: shop (prod) disk over 85% full on hetzner-shop\nThe disk of the server hetzner-shop is 87% full: 5.4 GB free of 42.9 GB.\n\nSince 2026-11-25 10:00 UTC.\n\n${DISK_HINT}`,
    });
    const discord = reporting({ webhook: "discord" });
    await discord.send(report({ disk: WARN }));
    const body = JSON.parse(discord.posts[0]?.body ?? "");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toMatch(
      /^OpsCrew check: shop \(prod\) disk over 85% full on hetzner-shop\n/,
    );
  });

  const failures: [string, Partial<UptimeReport>, Partial<UptimeReport>, string, string, string][] =
    [
      [
        "a failed snapshot",
        {},
        { snapshot: { status: "failed" } },
        "OpsCrew check: shop (prod) scheduled snapshot failed on hetzner-shop",
        "The last scheduled snapshot of shop on the server hetzner-shop failed: OpsCrew took no snapshot.",
        "OpsCrew check: resolved, shop (prod), the scheduled snapshot on hetzner-shop",
      ],
      [
        "a snapshot whose copy failed",
        {},
        { snapshot: { status: "copy-failed", id: "20261125T030000Z" } },
        "OpsCrew check: shop (prod) scheduled snapshot's off-server copy failed on hetzner-shop",
        "The scheduled snapshot 20261125T030000Z of shop, due at 2026-11-25 03:00 UTC, was taken on the server hetzner-shop, but its copy off the server failed.",
        "OpsCrew check: resolved, shop (prod), the scheduled snapshot on hetzner-shop",
      ],
      [
        "a failed drill",
        {},
        { drill: { status: "failed", result: "unhealthy", at: "2026-11-24T03:41:00Z" } },
        "OpsCrew check: shop (prod) scheduled restore drill failed on hetzner-shop",
        "The last scheduled restore drill of shop on the server hetzner-shop failed, at 2026-11-24 03:41 UTC: the app did not become healthy on the restored data, with no internet and none of production's .env values.",
        "OpsCrew check: resolved, shop (prod), the scheduled restore drill on hetzner-shop",
      ],
      [
        "a late drill",
        {},
        { drill: { status: "late", result: "healthy", at: "2026-11-10T03:41:00Z" } },
        "OpsCrew check: shop (prod) no scheduled restore drill on hetzner-shop",
        "No scheduled restore drill of shop has run on the server hetzner-shop since 2026-11-10 03:41 UTC, more than twice its weekly schedule: each was skipped or did not start.",
        "OpsCrew check: resolved, shop (prod), the scheduled restore drill on hetzner-shop",
      ],
      [
        "a late drill, none having run yet",
        {},
        { drill: { status: "late" } },
        "OpsCrew check: shop (prod) no scheduled restore drill on hetzner-shop",
        "No scheduled restore drill of shop has run on the server hetzner-shop within twice its weekly schedule: each was skipped or did not start.",
        "OpsCrew check: resolved, shop (prod), the scheduled restore drill on hetzner-shop",
      ],
      [
        "a certificate within 14 days",
        {},
        { certificates: [{ hostname: "shop.example.com", status: "warn", days: 9 }] },
        "OpsCrew check: shop (prod) certificate expires within 14 days on shop.example.com",
        "The certificate of shop.example.com expires in 9 days.",
        "OpsCrew check: resolved, shop (prod), the certificate on shop.example.com",
      ],
      [
        "an expired certificate",
        {},
        { certificates: [{ hostname: "shop.example.com", status: "expired", days: -2 }] },
        "OpsCrew check: shop (prod) certificate has expired on shop.example.com",
        "The certificate of shop.example.com expired 2 days ago.",
        "OpsCrew check: resolved, shop (prod), the certificate on shop.example.com",
      ],
      [
        "an old credential",
        { credentials: [OK_CREDENTIAL] },
        { credentials: [{ ...OK_CREDENTIAL, status: "old", days: 400 }] },
        "OpsCrew check: shop (prod) credential deploy-key is due for rotation",
        "The credential deploy-key of shop (prod) was last rotated 400 days ago, more than the plan's credentials.maxAgeDays.",
        "OpsCrew check: resolved, shop (prod), the age of the credential deploy-key",
      ],
    ];
  it.each(failures)(
    "%s posts check.mjs's text once, and recovers once",
    async (_, healthy, failing, title, what, resolved) => {
      const world = reporting();
      await world.send(report(healthy));
      world.now += FIVE_MINUTES;
      expect(await world.send(report(failing))).toBe(204);
      world.now += FIVE_MINUTES;
      expect(await world.send(report({ ...failing, kind: "heartbeat" }))).toBe(204);
      world.now += FIVE_MINUTES;
      expect(await world.send(report(healthy))).toBe(204);
      world.now += FIVE_MINUTES;
      expect(await world.send(report(healthy))).toBe(204);
      expect(said(world).map(([t, priority]) => [t, priority])).toEqual([
        [title, "4"],
        [resolved, "3"],
      ]);
      expect(world.posts[0]?.body.startsWith(`${what}\n\nSince 2026-11-25 10:05 UTC.\n\n`)).toBe(
        true,
      );
      expect(world.posts[1]?.body).toBe("Resolved after 10 minutes.");
    },
  );

  it("a credential's message names npx opscrew rotate <name> with the entry's rotate flags", async () => {
    const world = reporting({ rotate: " --env staging" });
    await world.send(report({ credentials: [{ ...OK_CREDENTIAL, status: "old", days: 400 }] }));
    expect(world.posts[0]?.body).toBe(
      "The credential deploy-key of shop (prod) was last rotated 400 days ago, more than the plan's credentials.maxAgeDays.\n\nSince 2026-11-25 10:00 UTC.\n\nTo rotate it, run `npx opscrew rotate deploy-key --env staging` in this repository.",
    );
  });

  it.each([
    ["made", "was made 400 days ago"],
    ["first-deploy", "dates from the first deploy, 400 days ago"],
  ] as const)("a credential dated from %s says it %s", async (source, when) => {
    const world = reporting();
    await world.send(
      report({ credentials: [{ ...OK_CREDENTIAL, status: "old", days: 400, source }] }),
    );
    expect(world.posts[0]?.body).toContain(
      `The credential deploy-key of shop (prod) ${when}, more`,
    );
    expect(world.posts[0]?.body).toContain("`npx opscrew rotate deploy-key` in this repository.");
  });

  it("a failing check on the first report posts; a healthy first report posts nothing", async () => {
    const world = reporting();
    await world.send(report({ snapshot: { status: "failed" } }));
    expect(world.posts).toHaveLength(1);
    const other = reporting();
    await other.send(report({ snapshot: { status: "none" }, drill: { status: "none" } }));
    expect(other.posts).toEqual([]);
  });

  it("unknown never posts, and keeps the last known status", async () => {
    const world = reporting();
    const unknown = {
      disk: { status: "unknown" },
      snapshot: { status: "unknown" },
      drill: { status: "unknown" },
    } as const;
    await world.send(report(unknown));
    world.now += FIVE_MINUTES;
    await world.send(report({ disk: WARN, snapshot: { status: "failed" } }));
    expect(world.posts).toHaveLength(2);
    world.now += FIVE_MINUTES;
    await world.send(report(unknown));
    expect(world.stored()?.disk).toEqual({ ...WARN, since: "2026-11-25T10:05:00Z" });
    expect(world.stored()?.snapshot.status).toBe("failed");
    world.now += FIVE_MINUTES;
    await world.send(report({ disk: WARN, snapshot: { status: "failed" } }));
    expect(world.posts).toHaveLength(2);
    world.now += FIVE_MINUTES;
    await world.send(report());
    expect(said(world).map(([title]) => title)).toEqual([
      "OpsCrew check: shop (prod) disk over 85% full on hetzner-shop",
      "OpsCrew check: shop (prod) scheduled snapshot failed on hetzner-shop",
      "OpsCrew check: resolved, shop (prod), the disk on hetzner-shop",
      "OpsCrew check: resolved, shop (prod), the scheduled snapshot on hetzner-shop",
    ]);
    expect(world.posts[2]?.body).toBe("Resolved after 15 minutes.");
  });

  it("a certificate's none never posts: it keeps warn, and the renewed one recovers once", async () => {
    const world = reporting();
    const cert = (status: "ok" | "warn" | "none", days?: number) =>
      report({
        certificates: [
          { hostname: "shop.example.com", status, ...(days === undefined ? {} : { days }) },
        ],
      });
    await world.send(cert("none"));
    world.now += FIVE_MINUTES;
    await world.send(cert("ok", 60));
    expect(world.posts).toEqual([]);
    world.now += FIVE_MINUTES;
    await world.send(cert("warn", 9));
    world.now += FIVE_MINUTES;
    await world.send(cert("none"));
    world.now += FIVE_MINUTES;
    await world.send(cert("warn", 9));
    expect(world.posts).toHaveLength(1);
    world.now += FIVE_MINUTES;
    await world.send(cert("ok", 89));
    expect(said(world).map(([title]) => title)).toEqual([
      "OpsCrew check: shop (prod) certificate expires within 14 days on shop.example.com",
      "OpsCrew check: resolved, shop (prod), the certificate on shop.example.com",
    ]);
  });

  it("a certificate or credential no longer reported leaves the report with no message", async () => {
    const world = reporting();
    await world.send(
      report({
        certificates: [{ hostname: "shop.example.com", status: "warn", days: 9 }],
        credentials: [{ ...OK_CREDENTIAL, status: "old", days: 400 }],
      }),
    );
    expect(world.posts).toHaveLength(2);
    world.now += FIVE_MINUTES;
    await world.send(report({ certificates: [] }));
    expect(world.posts).toHaveLength(2);
    expect(world.stored()?.certificates).toEqual([]);
    expect(world.stored()?.credentials).toBeUndefined();
  });

  it("a heartbeat with no change writes once and posts nothing", async () => {
    const world = reporting();
    await world.send(report());
    world.now += 24 * HOUR;
    world.kv.ops.length = 0;
    expect(await world.send(report({ kind: "heartbeat" }))).toBe(204);
    expect(world.posts).toEqual([]);
    expect(world.kv.ops).toEqual([`get entry:${ID}`, `get ${REPORT_KEY}`, `put ${REPORT_KEY}`]);
    expect(world.kv.metadata.get(REPORT_KEY)).toEqual({ at: Math.floor(world.now / 1000) });
  });

  it("a failed post answers 502 and writes nothing, so the server's next send posts it", async () => {
    const world = reporting();
    await world.send(report());
    world.now += FIVE_MINUTES;
    world.webhookStatus = 500;
    world.kv.ops.length = 0;
    // Two changes: the first post fails, and the second isn't tried.
    expect(await world.send(report({ disk: WARN, snapshot: { status: "failed" } }))).toBe(502);
    expect(world.posts).toHaveLength(1);
    expect(world.kv.ops).toEqual([`get entry:${ID}`, `get ${REPORT_KEY}`]);
    expect(world.stored()?.disk.status).toBe("ok");
    expect(logs).toContain(`${ID}: the ntfy webhook failed (HTTP 500).`);
    world.webhookStatus = 200;
    world.now += FIVE_MINUTES;
    expect(await world.send(report({ disk: WARN, snapshot: { status: "failed" } }))).toBe(204);
    expect(world.posts).toHaveLength(3);
    expect(world.stored()?.disk.status).toBe("warn");
  });

  it("a webhook that can't be reached answers 502 too", async () => {
    const world = reporting();
    world.webhookStatus = new TypeError("fetch failed");
    expect(await world.send(report({ disk: WARN }))).toBe(502);
    expect(world.kv.writes).toBe(0);
    expect(logs).toContain(`${ID}: the ntfy webhook failed (not reachable).`);
  });
});

describe("runUptime's server reports", () => {
  it("a listed server silent for 26 hours and one minute posts 'reports … stopped' once and writes state: once", async () => {
    const world = reporting();
    await world.send(report());
    world.now = START + 26 * HOUR;
    await world.run();
    expect(world.posts).toEqual([]);
    world.now = START + 26 * HOUR + 60_000;
    world.kv.ops.length = 0;
    await world.run();
    expect(said(world)).toEqual([
      [
        "OpsCrew uptime check: reports from shop (prod) on hetzner-shop stopped",
        "4",
        "OpsCrew uptime check: reports from shop (prod) on hetzner-shop stopped: the last came at 2026-11-25 10:00 UTC, more than 1 day 2 hours ago. The server may be down, or its timer stopped. Run npx opscrew status to see more.",
      ],
    ]);
    expect(world.kv.ops.filter((op) => !op.startsWith("get ") && op !== "list")).toEqual([
      `put state:${ID}`,
    ]);
    expect(world.state()).toEqual({ hosts: {}, stopped: { [SERVER]: "2026-11-26T12:01:00Z" } });
    await world.run();
    await world.run();
    expect(world.posts).toHaveLength(1);
    // Since the op log was cleared: only that one write.
    expect(world.kv.writes).toBe(1);
  });

  it("a newer report makes the next run post 'reports resumed', once, and clear the record", async () => {
    const world = reporting();
    await world.send(report());
    world.now = START + 27 * HOUR;
    await world.run();
    expect(world.posts).toHaveLength(1);
    await world.send(report({ kind: "heartbeat" }));
    await world.run();
    expect(said(world)[1]).toEqual([
      "OpsCrew uptime check: reports resumed from shop (prod) on hetzner-shop",
      "3",
      "OpsCrew uptime check: reports resumed from shop (prod) on hetzner-shop: the last came at 2026-11-26 13:05 UTC.",
    ]);
    expect(world.state()).toBeUndefined();
    await world.run();
    expect(world.posts).toHaveLength(2);
  });

  it("a server listed less than 26 hours ago with no report posts nothing; past that, it says none came", async () => {
    const world = reporting();
    world.now = Date.parse("2026-11-26T11:00:00Z");
    await world.run();
    expect(world.posts).toEqual([]);
    world.now = Date.parse("2026-11-26T11:01:00Z");
    await world.run();
    expect(world.posts[0]?.body).toBe(
      "OpsCrew uptime check: reports from shop (prod) on hetzner-shop stopped: none came since it was listed at 2026-11-25 09:00 UTC, more than 1 day 2 hours ago. The server may be down, or its timer stopped. Run npx opscrew status to see more.",
    );
  });

  it("a failed 'stopped' post writes nothing, and the next run posts it again", async () => {
    const world = reporting();
    world.now = START + 27 * HOUR;
    world.webhookStatus = 500;
    await world.run();
    expect(world.posts).toHaveLength(1);
    expect(world.kv.writes).toBe(0);
    world.webhookStatus = 200;
    await world.run();
    expect(world.posts).toHaveLength(2);
    expect(world.state()?.stopped).toEqual({ [SERVER]: "2026-11-26T13:05:00Z" });
  });

  it("a server that left the entry leaves the stopped record with no message", async () => {
    const world = reporting();
    world.now = START + 27 * HOUR;
    await world.run();
    world.kv.data.set(`entry:${ID}`, JSON.stringify(entry({ servers: [] })));
    await world.run();
    expect(world.posts).toHaveLength(1);
    expect(world.state()).toBeUndefined();
  });

  it("the stopped record sits beside the hostnames' state, and each keeps the other", async () => {
    const world = reporting();
    world.now = START + 27 * HOUR;
    world.answer(502);
    await world.run();
    expect(world.state()).toEqual({
      hosts: {
        "shop.example.com": {
          status: "suspect",
          since: "2026-11-26T13:00:00Z",
          reason: "answered with status 502",
        },
      },
      stopped: { [SERVER]: "2026-11-26T13:00:00Z" },
    });
    world.answer(200);
    await world.run();
    expect(world.state()).toEqual({ hosts: {}, stopped: { [SERVER]: "2026-11-26T13:00:00Z" } });
  });

  it("the stopped and resumed posts share the run's budget with the hostnames' posts", async () => {
    const hostnames = Array.from({ length: 40 }, (_, h) => `h${h}.example.com`);
    const world = reporting({ hostnames });
    world.answer(500, ...hostnames);
    await world.run();
    world.now = START + 27 * HOUR;
    await world.run();
    // 40 fetches leave 10 posts: the hostnames' first, and the server's waits.
    expect(world.posts).toHaveLength(10);
    expect(world.posts.every((p) => p.body.includes("is down on"))).toBe(true);
    expect(world.state()?.stopped).toBeUndefined();
  });

  it("one list per run, with the report times from its metadata: no read of a report: key", async () => {
    const world = reporting();
    await world.send(report());
    world.kv.ops.length = 0;
    await world.run();
    expect(world.kv.ops).toEqual(["list", `get entry:${ID}`, `get state:${ID}`]);
  });

  it("an entry with heartbeatMinutes: 10 posts 'reports … stopped' after 10 minutes and one second", async () => {
    const world = reporting({ heartbeatMinutes: 10 });
    await world.send(report());
    world.now = START + 10 * 60_000;
    await world.run();
    expect(world.posts).toEqual([]);
    world.now = START + 10 * 60_000 + 1000;
    await world.run();
    expect(world.posts[0]?.body).toContain(
      "stopped: the last came at 2026-11-25 10:00 UTC, more than 10 minutes ago.",
    );
  });

  it.each([5, 1560])("heartbeatMinutes: %s is used", async (minutes) => {
    const world = reporting({ heartbeatMinutes: minutes });
    await world.send(report());
    world.now = START + minutes * 60_000 + 1000;
    await world.run();
    expect(world.posts).toHaveLength(1);
  });

  it.each([
    ["4", 4],
    ["1,561", 1561],
    ["absent", undefined],
    ["text", "10"],
  ])("heartbeatMinutes %s: the limit stays 26 hours", async (_, minutes) => {
    const world = reporting(minutes === undefined ? {} : { heartbeatMinutes: minutes as number });
    await world.send(report());
    world.now = START + 10 * 60_000 + 1000;
    await world.run();
    world.now = START + 26 * HOUR;
    await world.run();
    expect(world.posts).toEqual([]);
    world.now = START + 26 * HOUR + 60_000;
    await world.run();
    expect(world.posts).toHaveLength(1);
  });
});

describe("the server reports' secrets", () => {
  it("no message, log line or KV value holds the report key, the webhook's address or the request's body", async () => {
    const world = reporting();
    world.secrets = {
      [SECRET]: JSON.stringify({ url: WEBHOOK, token: NTFY_TOKEN, report: reportHex }),
    };
    const failing = report({
      disk: WARN,
      certificates: [{ hostname: "shop.example.com", status: "warn", days: 9 }],
      credentials: [{ ...OK_CREDENTIAL, status: "old", days: 400 }],
    });
    // Refusals.
    expect(await world.send(JSON.stringify({ ...report(), note: IN_BODY }))).toBe(400);
    expect(await world.send(failing, { key: otherKey })).toBe(401);
    expect(await world.send(report({ server: "own-shop" }))).toBe(401);
    // A failed post, the changes, a stop and a resume.
    world.webhookStatus = 500;
    expect(await world.send(failing)).toBe(502);
    world.webhookStatus = 200;
    world.now += FIVE_MINUTES;
    expect(await world.send(failing)).toBe(204);
    world.now += 27 * HOUR;
    await world.run();
    await world.send(report({ credentials: [OK_CREDENTIAL] }));
    await world.run();
    expect(world.posts.length).toBeGreaterThan(5);
    const text = [...logs, ...world.posts.map((p) => `${p.body} ${p.headers.title}`)].join("\n");
    for (const secret of [
      reportHex,
      WEBHOOK,
      "hooks.example.com",
      NTFY_TOKEN,
      IN_BODY,
      JSON.stringify(failing),
    ]) {
      expect(text).not.toContain(secret);
    }
    for (const [, value] of world.kv.data) {
      for (const secret of [reportHex, "hooks.example.com", NTFY_TOKEN, IN_BODY]) {
        expect(value).not.toContain(secret);
      }
    }
  });
});

describe("a report as the server's script (uptime-report.sh) sends it", () => {
  /**
   * The script's `sign`, step by step: HMAC-SHA256 by RFC 2104, with the 64 hex characters of the
   * key read as 32 bytes and padded with zeros to SHA-256's 64-byte block, each XOR 0x36 for the
   * inner hash and 0x5c for the outer one, hashed with sha256sum.
   */
  function scriptSign(keyHex: string, text: string): string {
    const block = Buffer.alloc(64);
    Buffer.from(keyHex, "hex").copy(block);
    const pad = (byte: number) => Buffer.from(block.map((b) => b ^ byte));
    const inner = createHash("sha256").update(pad(0x36)).update(text).digest();
    return createHash("sha256").update(pad(0x5c)).update(inner).digest("hex");
  }

  /** `curl` as the script runs it: its headers, `<NOW>\n<body>` signed, the body as is. */
  async function curl(world: World, body: string) {
    const now = String(Math.floor(world.now / 1000)); // date -u +%s
    const request = new Request("https://opscrew-uptime.acme.workers.dev/report", {
      method: "POST",
      headers: {
        "User-Agent": "OpsCrew uptime report",
        "Content-Type": "application/json",
        "X-OpsCrew-Entry": ID,
        "X-OpsCrew-Time": now,
        "X-OpsCrew-Signature": scriptSign(reportHex, `${now}\n${body}`),
      },
      body,
    });
    const env: UptimeEnv = { UPTIME: world.kv, ...world.secrets };
    return (await handleReport(request, env, { fetch: world.fetch, now: () => world.now })).status;
  }

  it("is accepted with its signature, its bodies with no data and with every figure", async () => {
    const world = reporting();
    // No data: disk unknown, no snapshot log, no drill, no TLS answer, a date just ahead.
    const empty =
      '{"version":1,"server":"hetzner-shop","kind":"change","disk":{"status":"unknown"},"snapshot":{"status":"none"},"drill":{"status":"none"},"certificates":[{"hostname":"shop.example.com","status":"none"}],"credentials":[{"name":"deploy-key","status":"ok","days":-1,"source":"rotated"}]}';
    expect(await curl(world, empty)).toBe(204);
    expect(world.posts).toEqual([]);
    world.now += FIVE_MINUTES;
    const full =
      '{"version":1,"server":"hetzner-shop","kind":"change","disk":{"status":"warn","percent":87,"free":5368709120,"total":42949672960},"snapshot":{"status":"copy-failed","id":"20261125T030000Z"},"drill":{"status":"failed","result":"unhealthy","at":"2026-11-24T03:41:00Z"},"certificates":[{"hostname":"shop.example.com","status":"warn","days":9}],"credentials":[{"name":"deploy-key","status":"old","days":400,"source":"first-deploy"}]}';
    expect(await curl(world, full)).toBe(204);
    expect(world.posts).toHaveLength(5);
    world.now += FIVE_MINUTES;
    // A late drill, none having run yet: its status only.
    const late = full.replace(
      '{"status":"failed","result":"unhealthy","at":"2026-11-24T03:41:00Z"}',
      '{"status":"late"}',
    );
    expect(await curl(world, late)).toBe(204);
    expect(world.posts.at(-1)?.headers.title).toBe(
      "OpsCrew check: shop (prod) no scheduled restore drill on hetzner-shop",
    );
  });
});

/**
 * The address updater's script itself, run in a real shell with the test machine's jq: `curl`
 * answers from fixtures (the two IPv4 sources, then Cloudflare as each case sets it, logging every
 * request) and `ip` prints `ip -j` fixtures. Skipped, with a message, without jq.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import { DNS_UPDATER_RECORD_COMMENT, renderDnsUpdaterScript } from "./dns-updater";

const JQ = BASH_AVAILABLE
  ? spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim() || undefined
  : undefined;
const reason = !BASH_AVAILABLE
  ? "no POSIX shell"
  : JQ === undefined
    ? "jq is not installed"
    : undefined;
if (reason)
  console.warn(`[connector-ssh-host] skipping the address updater's script fixtures: ${reason}`);

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/home/${name}`, import.meta.url), "utf8");

const TOKEN = fakeSecret("cloudflare-token");
const ZONE = "0123456789abcdef0123456789abcdef";
const NAME = "shop.example.com";
const API = `https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records`;
const LIST = `${API}?name=${NAME}&per_page=50`;
const PROXIED_V4 = {
  schemaVersion: 1,
  app: "shop",
  zoneId: ZONE,
  name: NAME,
  proxied: true,
  ipv4: true,
  ipv6: false,
};
const DNS_ONLY = { ...PROXIED_V4, proxied: false, ipv6: true };

/** A Cloudflare DNS record at the name. */
function record(type: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    id: `${type.toLowerCase()}${content.replace(/[^0-9a-f]/g, "")}`.padEnd(32, "0").slice(0, 32),
    type,
    name: NAME,
    content,
    ttl: 1,
    proxied: true,
    comment: DNS_UPDATER_RECORD_COMMENT,
    ...extra,
  };
}

/** Cloudflare's answer: a body and an HTTP status, as curl prints them with `-w '\n%{http_code}'`. */
const ok = (result: unknown) => `${JSON.stringify({ success: true, errors: [], result })}\n200`;
const failure = (status: number, code: number) =>
  `${JSON.stringify({ success: false, errors: [{ code, message: "the reason in Cloudflare's words" }], result: null })}\n${status}`;

interface Case {
  config?: object | string;
  token?: string;
  /** The state a previous run left. */
  state?: object;
  /** Cloudflare's trace answer, and checkip's; absent: that source does not answer. */
  trace?: string;
  checkip?: string;
  /** The records at the name (Cloudflare's GET answers with them), or the GET's whole answer. */
  records?: object[];
  get?: string;
  /** Answers for the writes, by method (default: a success). */
  answers?: Partial<Record<"POST" | "PATCH" | "DELETE", string>>;
  unreachable?: true;
  /** `ip -j -6 route show default` and `ip -j addr show` (the stub keeps the asked device's). */
  route6?: string;
  addresses?: string;
  ipFails?: true;
}

interface Run {
  status: number | null;
  journal: string;
  stderr: string;
  state: Record<string, unknown>;
  /** Each request to Cloudflare: method, URL and body (parsed). */
  requests: { method: string; url: string; body?: unknown }[];
  /** The bearer token of each request, as curl read it on its standard input. */
  tokens: string[];
  /** Every stubbed command's arguments. */
  calls: string[];
}

const CURL = `last=''
for a do last=$a; done
case " $* " in
  *" -K - "*)
    conf=$(cat)
    printf '%s\\n' "$conf" | sed -n 's/^header = "Authorization: Bearer \\(.*\\)"$/\\1/p' >> "$S/tokens"
    method=$(printf '%s\\n' "$conf" | sed -n 's/^request = "\\(.*\\)"$/\\1/p')
    url=$(printf '%s\\n' "$conf" | sed -n 's/^url = "\\(.*\\)"$/\\1/p')
    data=$(printf '%s\\n' "$conf" | sed -n 's/^data = //p')
    printf '%s\\t%s\\t%s\\n' "$method" "$url" "$data" >> "$S/requests"
    if [ -e "$S/unreachable" ]; then exit 7; fi
    if [ -e "$S/answer-$method" ]; then cat "$S/answer-$method"; else cat "$S/answer-ok"; fi
    ;;
  *)
    case "$last" in
      */cdn-cgi/trace) if [ -e "$S/trace" ]; then cat "$S/trace"; else exit 7; fi ;;
      *checkip*) if [ -e "$S/checkip" ]; then cat "$S/checkip"; else exit 7; fi ;;
      *) exit 2 ;;
    esac
    ;;
esac`;

const IP = `if [ -e "$S/ip-fails" ]; then exit 1; fi
case "$*" in
  "-j -6 route show default") cat "$S/route6" ;;
  "-j -6 addr show dev "*" scope global") jq -c --arg dev "$6" '[.[] | select(.ifname == $dev) | .addr_info |= map(select(.family == "inet6" and .scope == "global"))]' < "$S/addresses" ;;
  *) exit 1 ;;
esac`;

/** Runs the updater once for `c`, as its service would: the credentials and the state folder set. */
function runUpdater(c: Case): Run {
  const sh = new ShellHarness();
  try {
    sh.stub("jq", `exec '${JQ}' "$@"`, { log: false });
    sh.stub("curl", CURL);
    sh.stub("ip", IP);
    const config = c.config ?? PROXIED_V4;
    sh.write("/creds/config", typeof config === "string" ? config : JSON.stringify(config));
    sh.write("/creds/token", c.token ?? TOKEN);
    // systemd makes the state folder (StateDirectory=).
    mkdirSync(sh.native("/statedir"));
    if (c.state) sh.write("/statedir/state.json", JSON.stringify(c.state));
    if (c.trace !== undefined) sh.write("/state/trace", c.trace);
    if (c.checkip !== undefined) sh.write("/state/checkip", c.checkip);
    sh.write("/state/answer-GET", c.get ?? ok(c.records ?? []));
    sh.write("/state/answer-ok", ok({ id: "00000000000000000000000000000000" }));
    for (const [method, answer] of Object.entries(c.answers ?? {})) {
      sh.write(`/state/answer-${method}`, answer);
    }
    if (c.unreachable) sh.write("/state/unreachable", "");
    if (c.ipFails) sh.write("/state/ip-fails", "");
    sh.write("/state/route6", c.route6 ?? fixture("ip-route6-default.json"));
    sh.write("/state/addresses", c.addresses ?? fixture("ip-addr.json"));
    const result = sh.run(`PATH='${sh.root}/bin:/usr/bin:/bin'
CREDENTIALS_DIRECTORY='${sh.posix("/creds")}'
STATE_DIRECTORY='${sh.posix("/statedir")}'
export PATH CREDENTIALS_DIRECTORY STATE_DIRECTORY
${renderDnsUpdaterScript()}`);
    const lines = (path: string) => (sh.read(path) ?? "").split("\n").filter(Boolean);
    return {
      status: result.status,
      journal: result.stdout,
      stderr: result.stderr,
      state: JSON.parse(sh.read("/statedir/state.json") ?? "{}"),
      requests: lines("/state/requests").map((line) => {
        const [method = "", url = "", data = ""] = line.split("\t");
        return data === "" ? { method, url } : { method, url, body: JSON.parse(JSON.parse(data)) };
      }),
      tokens: lines("/state/tokens"),
      calls: sh.calls(),
    };
  } finally {
    sh.dispose();
  }
}

const SEEN = "203.0.113.7";
const SOURCES = { trace: fixture("cloudflare-trace.txt"), checkip: fixture("checkip.txt") };
const EARLIER = {
  schemaVersion: 1,
  version: 1,
  lastRun: "2026-11-20T09:12:40Z",
  lastSuccess: "2026-11-20T09:12:40Z",
  seen: { ipv4: SEEN, ipv6: null },
  records: { ipv4: SEEN, ipv6: null },
  lastWrite: { at: "2026-11-20T09:12:40Z", changed: ["A", "created"] },
};

describe.skipIf(reason !== undefined)("the address updater's script (curl and ip stubbed)", () => {
  it("creates its A record when there is none, the token reaching curl on standard input only", () => {
    const run = runUpdater({ ...SOURCES });
    expect(run.status).toBe(0);
    expect(run.journal).toBe("address updater: A record created\n");
    expect(run.stderr).toBe("");
    expect(run.requests).toEqual([
      { method: "GET", url: LIST },
      {
        method: "POST",
        url: API,
        body: {
          type: "A",
          name: NAME,
          content: SEEN,
          ttl: 1,
          proxied: true,
          comment: DNS_UPDATER_RECORD_COMMENT,
        },
      },
    ]);
    expect(run.tokens).toEqual([TOKEN, TOKEN]);
    expect(run.calls.join("\n")).not.toContain(TOKEN);
    expect(run.state).toEqual({
      schemaVersion: 1,
      version: 1,
      lastRun: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      lastSuccess: run.state.lastRun,
      seen: { ipv4: SEEN, ipv6: null },
      records: { ipv4: SEEN, ipv6: null },
      lastWrite: { at: run.state.lastRun, changed: ["A", "created"] },
    });
  });

  it("changes nothing when its record holds the address", () => {
    const run = runUpdater({
      ...SOURCES,
      state: EARLIER,
      records: [record("A", SEEN), record("TXT", "v=spf1 -all", { comment: null })],
    });
    expect(run.journal).toBe("address updater: no change\n");
    expect(run.requests.map((request) => request.method)).toEqual(["GET"]);
    expect(run.state).toMatchObject({
      lastSuccess: run.state.lastRun,
      lastWrite: EARLIER.lastWrite,
    });
  });

  it("puts back a record changed by hand, and DNS-only settings", () => {
    const changed = runUpdater({
      ...SOURCES,
      state: EARLIER,
      records: [record("A", "198.51.100.99")],
    });
    expect(changed.journal).toBe("address updater: A record updated (the address changed)\n");
    expect(changed.requests[1]).toEqual({
      method: "PATCH",
      url: `${API}/${record("A", "198.51.100.99").id}`,
      body: { content: SEEN, ttl: 1, proxied: true },
    });
    expect(changed.state).toMatchObject({ lastWrite: { changed: ["A"] }, records: { ipv4: SEEN } });

    const settings = runUpdater({
      ...SOURCES,
      config: { ...PROXIED_V4, proxied: false },
      records: [record("A", SEEN)],
    });
    expect(settings.journal).toBe("address updater: A record updated (its settings changed)\n");
    expect(settings.requests[1]?.body).toEqual({ content: SEEN, ttl: 60, proxied: false });
  });

  it("stops at a record it did not write, or a CNAME at the name, and writes nothing", () => {
    for (const [records, code, phrase] of [
      [
        [record("A", "198.51.100.99", { comment: "Managed by OpsCrew" })],
        "foreign-record",
        "an A or AAAA record without the updater's comment holds the name",
      ],
      [
        [record("AAAA", "2001:db8::1", { comment: null })],
        "foreign-record",
        "an A or AAAA record without the updater's comment holds the name",
      ],
      [[record("CNAME", "shop.example.net")], "cname-at-name", "a CNAME record holds the name"],
    ] as const) {
      const run = runUpdater({ ...SOURCES, state: EARLIER, records: [...records] });
      expect(run.journal).toBe(`address updater: ${phrase}\n`);
      expect(run.requests.map((request) => request.method)).toEqual(["GET"]);
      expect(run.state).toMatchObject({
        lastSuccess: EARLIER.lastSuccess,
        lastError: { at: run.state.lastRun, code },
      });
      expect(run.state.lastError).not.toHaveProperty("http");
    }
  });

  it("records Cloudflare's errors by their status and codes, never its words, and writes nothing more", () => {
    const refused = runUpdater({ ...SOURCES, state: EARLIER, get: failure(403, 9109) });
    expect(refused.journal).toBe("address updater: Cloudflare refused the token (HTTP 403)\n");
    expect(refused.state).toMatchObject({
      lastSuccess: EARLIER.lastSuccess,
      records: EARLIER.records,
      lastError: { code: "token-refused", http: 403, cloudflare: [9109] },
    });
    expect(JSON.stringify(refused.state) + refused.journal).not.toContain("Cloudflare's words");
    expect(runUpdater({ ...SOURCES, get: failure(401, 10000) }).state).toMatchObject({
      lastError: { code: "token-refused", http: 401, cloudflare: [10000] },
    });

    // A 429 keeps the record as it is, though the address changed; the next run retries.
    const limited = runUpdater({ ...SOURCES, state: EARLIER, get: failure(429, 10000) });
    expect(limited.journal).toBe(
      "address updater: Cloudflare limited the requests (HTTP 429); the next run tries again\n",
    );
    expect(limited.status).toBe(0);
    expect(limited.state).toMatchObject({ lastError: { code: "rate-limited", http: 429 } });

    const broken = runUpdater({ ...SOURCES, answers: { POST: failure(500, 1004) } });
    expect(broken.journal).toBe("address updater: Cloudflare answered with an error (HTTP 500)\n");
    expect(broken.state).toMatchObject({
      records: { ipv4: null },
      lastError: { code: "cloudflare-error", http: 500, cloudflare: [1004] },
    });
    expect(broken.state).not.toHaveProperty("lastSuccess");

    const away = runUpdater({ ...SOURCES, state: EARLIER, unreachable: true });
    expect(away.journal).toBe("address updater: Cloudflare did not answer\n");
    expect(away.state).toMatchObject({
      records: EARLIER.records,
      lastError: { code: "cloudflare-unreachable" },
    });
    expect(away.state.lastError).not.toHaveProperty("http");
  });

  it("counts a source only when it gives a public IPv4 address, and both must agree", () => {
    const own = [record("A", "198.51.100.99")];
    const disagree = runUpdater({
      ...SOURCES,
      checkip: fixture("checkip-other.txt"),
      records: own,
    });
    expect(disagree.journal).toBe("address updater: the two IPv4 sources disagree\n");
    // The record is neither changed nor deleted: the address is unknown.
    expect(disagree.requests.map((request) => request.method)).toEqual(["GET"]);
    expect(disagree.state).toMatchObject({
      seen: { ipv4: null },
      records: { ipv4: "198.51.100.99" },
      lastError: { code: "sources-disagree" },
    });

    const privateTrace = runUpdater({
      trace: "ip=192.168.1.30\n",
      checkip: "203.0.113.8\n",
      records: own,
    });
    expect(privateTrace.state).toMatchObject({
      seen: { ipv4: "203.0.113.8" },
      records: { ipv4: "203.0.113.8" },
    });
    const oneSource = runUpdater({ checkip: "203.0.113.8\n", records: own });
    expect(oneSource.requests[1]?.body).toMatchObject({ content: "203.0.113.8" });

    for (const [trace, checkip] of [
      ["ip=hello\n", "<html>203.0.113.8</html>\n"],
      ["ip=100.64.0.9\n", "10.0.0.1\n"],
      ["ip=203.0.113.08\n", "203.0.113.256\n"],
      [undefined, undefined],
    ] as const) {
      const run = runUpdater({
        records: own,
        ...(trace ? { trace } : {}),
        ...(checkip ? { checkip } : {}),
      });
      expect(run.journal).toBe("address updater: neither IPv4 source gave a public address\n");
      expect(run.requests.map((request) => request.method)).toEqual(["GET"]);
      expect(run.state).toMatchObject({
        lastError: { code: "address-unknown" },
        records: { ipv4: "198.51.100.99" },
      });
    }
  });

  it("publishes the stable IPv6 address, removes its AAAA only when there is none", () => {
    // Temporary, deprecated, tentative, failed and unique-local addresses don't count; of two
    // with the same lifetime the lower one wins, on the default route's interface only.
    const created = runUpdater({
      ...SOURCES,
      config: DNS_ONLY,
      records: [record("A", SEEN, { ttl: 60, proxied: false })],
    });
    expect(created.journal).toBe("address updater: AAAA record created\n");
    expect(created.requests[1]).toEqual({
      method: "POST",
      url: API,
      body: {
        type: "AAAA",
        name: NAME,
        content: "2001:db8:1:2::30",
        ttl: 60,
        proxied: false,
        comment: DNS_UPDATER_RECORD_COMMENT,
      },
    });
    expect(created.state).toMatchObject({
      seen: { ipv4: SEEN, ipv6: "2001:db8:1:2::30" },
      records: { ipv6: "2001:db8:1:2::30" },
    });

    const both = [
      record("A", SEEN, { ttl: 60, proxied: false }),
      record("AAAA", "2001:db8:1:2::30", { ttl: 60, proxied: false }),
    ];
    const gone = runUpdater({ ...SOURCES, config: DNS_ONLY, records: both, route6: "[]" });
    expect(gone.journal).toBe("address updater: AAAA record removed (no IPv6 address)\n");
    expect(gone.requests[1]).toEqual({ method: "DELETE", url: `${API}/${both[1]?.id}` });
    expect(gone.state).toMatchObject({
      lastSuccess: gone.state.lastRun,
      seen: { ipv6: null },
      records: { ipv4: SEEN, ipv6: null },
      lastWrite: { changed: ["AAAA-deleted"] },
    });

    // ip failing is no proof: the AAAA stays.
    const unknown = runUpdater({ ...SOURCES, config: DNS_ONLY, records: both, ipFails: true });
    expect(unknown.journal).toBe("address updater: the IPv6 address could not be read\n");
    expect(unknown.requests.map((request) => request.method)).toEqual(["GET"]);
    expect(unknown.state).toMatchObject({
      records: { ipv6: "2001:db8:1:2::30" },
      lastError: { code: "address-unknown" },
    });
  });

  it("deletes the records of a family it no longer keeps, and its own duplicates", () => {
    const ipv6Only = runUpdater({
      config: { ...PROXIED_V4, ipv4: false, ipv6: true },
      records: [record("A", SEEN), record("AAAA", "2001:db8:1:2::30")],
    });
    expect(ipv6Only.journal).toBe(
      "address updater: A record removed (the app no longer uses it)\n",
    );
    expect(ipv6Only.requests.map((request) => request.method)).toEqual(["GET", "DELETE"]);
    // The A record is never asked about: IPv4 is not detected for an app without it.
    expect(ipv6Only.calls.filter((call) => call.startsWith("curl -4"))).toEqual([]);

    const twice = [record("A", SEEN), { ...record("A", SEEN), id: "b".repeat(32) }];
    const duplicate = runUpdater({ ...SOURCES, records: twice });
    expect(duplicate.journal).toBe("address updater: a duplicate A record removed\n");
    expect(duplicate.requests[1]).toEqual({ method: "DELETE", url: `${API}/${"b".repeat(32)}` });
  });

  it("checks its config and token first: an invalid one exits 2 without a request", () => {
    for (const c of [
      { config: { ...PROXIED_V4, zoneId: "not-a-zone" } },
      { config: { ...PROXIED_V4, name: "Shop.Example.com" } },
      { config: { ...PROXIED_V4, proxied: "yes" } },
      { config: { ...PROXIED_V4, schemaVersion: 2 } },
      { config: "{" },
      { token: "too-short" },
      { token: `${TOKEN} with spaces` },
    ]) {
      const run = runUpdater({ ...SOURCES, state: EARLIER, ...c });
      expect(run.status).toBe(2);
      expect(run.journal).toBe("address updater: its config or its token is not valid\n");
      expect(run.requests).toEqual([]);
      expect(run.state).toMatchObject({
        lastSuccess: EARLIER.lastSuccess,
        records: EARLIER.records,
        lastError: { code: "config-invalid" },
      });
    }
  });
});

/**
 * The address updater's script, rendered with test endpoints, run as its service would run it (its
 * credentials and state folder in the environment) in a `debian:12-slim` container with real
 * curl, jq (1.6, the oldest the supported systems have) and iproute2, against a small fake
 * Cloudflare and fake IPv4 sources on 127.0.0.1. A dummy interface carries the IPv6 address and
 * default route. It creates the records, changes nothing on a second run, puts back a record
 * changed by hand, deletes the AAAA when the IPv6 address goes, keeps the record on a 429, and the
 * token never shows in `ps` while curl runs. It pulls the image and installs packages, so it runs
 * only with OPSCREW_DOCKER_TESTS=1.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { DNS_UPDATER_RECORD_COMMENT, renderDnsUpdaterScript } from "./dns-updater";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason)
  console.warn(`[connector-ssh-host] skipping the address updater on debian:12: ${reason}`);

const ZONE = "0123456789abcdef0123456789abcdef";
const NAME = "shop.example.com";

/**
 * A fake Cloudflare (the DNS records of one zone, each answer 300 ms late so `ps` sees curl), the
 * two IPv4 sources, and `/ctl`: it sets the outside IPv4 address, turns 429s on, changes a
 * record's content by hand, and answers the records and the count of writes so far.
 */
const FAKE_CLOUDFLARE = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const token = readFileSync("/t/token", "utf8");
const records = new Map();
let next = 1;
let writes = 0;
let ipv4 = "203.0.113.7";
let limited = false;
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const refuse = (res, status, code) => send(res, status, { success: false, errors: [{ code, message: "no" }], result: null });
createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  for await (const chunk of req) body += chunk;
  if (url.pathname === "/ctl") {
    if (url.searchParams.has("ipv4")) ipv4 = url.searchParams.get("ipv4");
    if (url.searchParams.has("limited")) limited = url.searchParams.get("limited") === "1";
    const set = url.searchParams.get("set");
    if (set) {
      const [type, content] = set.split("=");
      for (const record of records.values()) if (record.type === type) record.content = content;
    }
    return send(res, 200, { records: [...records.values()], writes });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (url.pathname === "/cdn-cgi/trace") return res.end("fl=1\\nh=127.0.0.1\\nip=" + ipv4 + "\\n");
  if (url.pathname === "/checkip") return res.end(ipv4 + "\\n");
  if (req.headers.authorization !== "Bearer " + token) return refuse(res, 403, 9109);
  if (limited) return refuse(res, 429, 10000);
  const match = /^\\/client\\/v4\\/zones\\/${ZONE}\\/dns_records(?:\\/([0-9a-f]{32}))?$/.exec(url.pathname);
  if (!match) return refuse(res, 404, 7003);
  if (req.method === "GET") {
    const name = url.searchParams.get("name");
    return send(res, 200, { success: true, errors: [], result: [...records.values()].filter((r) => r.name === name) });
  }
  writes += 1;
  if (req.method === "POST") {
    const record = { id: String(next++).padStart(32, "0"), ...JSON.parse(body) };
    records.set(record.id, record);
    return send(res, 200, { success: true, errors: [], result: record });
  }
  const record = records.get(match[1]);
  if (!record) return refuse(res, 404, 81044);
  if (req.method === "PATCH") Object.assign(record, JSON.parse(body));
  if (req.method === "DELETE") records.delete(record.id);
  return send(res, 200, { success: true, errors: [], result: record });
}).listen(8080, "127.0.0.1");
`;

const SCRIPT = `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends curl jq iproute2 procps nodejs >/dev/null 2>&1
node /t/fake-cloudflare.mjs &
i=0
until curl -s 127.0.0.1:8080/ctl >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 100 ] || exit 9; sleep 0.1; done
# The server's own IPv6 address, on the interface of the IPv6 default route.
ip link add dummy0 type dummy
ip link set dummy0 up
ip -6 addr add 2001:db8:5::7/64 dev dummy0 nodad
ip -6 route add default dev dummy0 metric 50
# As its service runs it: the credentials and the state folder systemd gives it.
mkdir -p /creds /state
cp /t/config.json /creds/config
cp /t/token /creds/token
export CREDENTIALS_DIRECTORY=/creds STATE_DIRECTORY=/state
ctl() { echo "$1: $(curl -s "127.0.0.1:8080/ctl?$2")"; }
updater() { echo "$1: $(sh /t/updater.sh)"; }
# 1. It creates the records, while every process's arguments are read again and again.
(while :; do ps -eo args; done) > /tmp/ps 2>&1 &
sampler=$!
updater run1
kill "$sampler"
ctl after1 ''
echo "curl in ps: $(grep -c -- '-K -' /tmp/ps)"
if grep -qF "$(cat /t/token)" /tmp/ps; then echo "token in ps: yes"; else echo "token in ps: no"; fi
# 2. Nothing changes.
updater run2
ctl after2 ''
# 3. A record changed by hand is put back.
ctl changed 'set=A=198.51.100.99'
updater run3
ctl after3 ''
# 4. The IPv6 address goes, so does the AAAA record.
ip -6 route del default dev dummy0
updater run4
ctl after4 ''
# 5. A 429 keeps the record as it is, though the address changed.
ctl limited 'ipv4=203.0.113.8&limited=1'
updater run5
ctl after5 ''
echo "state5: $(tr -d '\\n' < /state/state.json)"
`;

describe.skipIf(reason !== undefined)(
  "the address updater on debian:12 against a fake Cloudflare",
  () => {
    it("keeps its records at the server's address, puts them back, and never shows its token", {
      timeout: 300_000,
    }, () => {
      const token = fakeSecret("cloudflare-token");
      const dir = mkdtempSync(join(tmpdir(), "opscrew-dns-updater-"));
      try {
        writeFileSync(
          join(dir, "updater.sh"),
          renderDnsUpdaterScript({
            endpoints: {
              api: "http://127.0.0.1:8080/client/v4",
              trace: "http://127.0.0.1:8080/cdn-cgi/trace",
              checkip: "http://127.0.0.1:8080/checkip",
            },
          }),
        );
        writeFileSync(
          join(dir, "config.json"),
          JSON.stringify({
            schemaVersion: 1,
            app: "shop",
            zoneId: ZONE,
            name: NAME,
            proxied: false,
            ipv4: true,
            ipv6: true,
          }),
        );
        writeFileSync(join(dir, "token"), token);
        writeFileSync(join(dir, "fake-cloudflare.mjs"), FAKE_CLOUDFLARE);
        writeFileSync(join(dir, "run.sh"), SCRIPT);
        const run = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--label",
            "opscrew-test=dns-updater",
            "--cap-add",
            "NET_ADMIN",
            "--sysctl",
            "net.ipv6.conf.all.disable_ipv6=0",
            "-v",
            `${dir}:/t:ro`,
            "debian:12-slim",
            "sh",
            "/t/run.sh",
          ],
          { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
        );
        const out = run.stdout;
        expect(run.status, `${out}\n${run.stderr}`).toBe(0);
        const line = (key: string) =>
          out
            .split("\n")
            .find((item) => item.startsWith(`${key}: `))
            ?.slice(key.length + 2) ?? "";
        const records = (key: string) =>
          JSON.parse(line(key)) as {
            records: {
              type: string;
              content: string;
              ttl: number;
              proxied: boolean;
              comment: string;
            }[];
            writes: number;
          };
        const own = { name: NAME, ttl: 60, proxied: false, comment: DNS_UPDATER_RECORD_COMMENT };

        expect(line("run1")).toBe("address updater: A record created; AAAA record created");
        expect(records("after1").records).toEqual([
          expect.objectContaining({ type: "A", content: "203.0.113.7", ...own }),
          expect.objectContaining({ type: "AAAA", content: "2001:db8:5::7", ...own }),
        ]);
        expect(Number(line("curl in ps"))).toBeGreaterThan(0);
        expect(line("token in ps")).toBe("no");

        expect(line("run2")).toBe("address updater: no change");
        expect(records("after2").writes).toBe(records("after1").writes);

        expect(line("run3")).toBe("address updater: A record updated (the address changed)");
        expect(records("after3").records.find((item) => item.type === "A")?.content).toBe(
          "203.0.113.7",
        );

        expect(line("run4")).toBe("address updater: AAAA record removed (no IPv6 address)");
        expect(records("after4").records.map((item) => item.type)).toEqual(["A"]);

        expect(line("run5")).toBe(
          "address updater: Cloudflare limited the requests (HTTP 429); the next run tries again",
        );
        expect(records("after5").records).toEqual([
          expect.objectContaining({ type: "A", content: "203.0.113.7" }),
        ]);
        expect(JSON.parse(line("state5"))).toMatchObject({
          seen: { ipv4: "203.0.113.8", ipv6: null },
          records: { ipv4: "203.0.113.7", ipv6: null },
          lastError: { code: "rate-limited", http: 429, cloudflare: [10000] },
        });
        // No address and no token in what the runs printed (the journal).
        const journal = out
          .split("\n")
          .filter((item) => /^run\d: /.test(item))
          .join("\n");
        expect(journal).not.toMatch(/203\.0\.113|2001:db8|198\.51\.100/);
        expect(out).not.toContain(token);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

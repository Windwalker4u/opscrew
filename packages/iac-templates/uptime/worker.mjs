// OpsCrew's uptime check, a Cloudflare Worker (`opscrew-uptime`) that a Cron Trigger runs every
// 5 minutes. OpsCrew uploads the same script to every account that uses it, and replaces it.
//
// Each app that sets `observability.check.runner: cloudflare` has an entry in the Workers KV
// namespace bound as UPTIME (`entry:<id>`, its hostnames and health path) and its webhook's address
// in its own Worker secret. Each run fetches each hostname once. The first failure marks it
// `suspect` in `state:<id>`; a second in a row marks it `down` and posts to the app's webhook; a
// success clears `suspect` silently and posts "up again" after `down`. The state is written only
// when it changes, and a change that posts only after the webhook accepted the post.
//
// The servers an entry lists check their own disk, snapshots, restore drills, certificates and
// credentials, and send `POST /report` to the Worker's workers.dev address on a change, and once a
// day: signed with the environment's report key (in the entry's secret), within 5 minutes of the
// Worker's clock, and newer than the last one kept. The `fetch` handler posts each check whose
// status changed, with the Actions check's texts, and only then keeps the report in
// `report:<id>/<server>`, with its time as the key's metadata. The cron posts once when a
// server's reports stop for more than 26 hours, and once when they resume. Each key has one
// writer: `report:` keys the `fetch` handler, `state:` keys the cron.
//
// A message holds only fixed sentences, names, hostnames, status codes, figures and times: never
// what the app answered, never an address, never a report's body and never a secret. It has no
// imports.

/** The free plan's subrequests per run: the fetches, then the posts. */
const SUBREQUESTS = 50;

/** The hostnames one run checks, leaving 10 subrequests for posts. */
const MAX_HOSTNAMES = 40;

/** Fetches at once, under the 6 open connections a run has. */
const POOL = 5;

const TIMEOUT_MS = 10_000;

/** The most each webhook takes: Slack's and Discord's in characters, ntfy's in bytes. */
const WEBHOOK_LIMITS = { slack: 4000, discord: 2000, ntfy: 4096 };

const ENTRY = "entry:";
const STATE = "state:";
const REPORT = "report:";

/**
 * The most a report's body holds, in bytes: the largest report the servers' step allows (40
 * certificates and 64 credentials, each at its longest) is about 25 KB, well under it.
 */
export const MAX_BODY = 65_536;

/** How far a report's time may be from the Worker's clock. */
const SKEW_MS = 5 * 60_000;

/** How long a listed server may stay silent: its daily heartbeat, and two hours. */
const HEARTBEAT_MS = 26 * 3_600_000;

/** The test-only `heartbeatMinutes` an entry may set instead (the live test's), in minutes. */
const HEARTBEAT_MINUTES = { min: 5, max: 1560 };

/** The Actions check's thresholds (`CHECK_THRESHOLDS`), which the servers apply. */
export const DISK_WARN = 85;
export const DISK_HIGH = 95;
export const CERT_DAYS = 14;

/** `<owner>/<repo>/<app>/<env>`. */
const ENTRY_ID = /^[^/\s]+\/[^/\s]+\/[^/\s]+\/[^/\s]+$/;
const UNIX_SECONDS = /^\d{1,12}$/;
/** A report key, or an HMAC-SHA256: 32 bytes in hex. */
const HEX_32 = /^[0-9a-f]{64}$/i;

/** The statuses that fail; any other passes. */
const FAILING = new Set(["warn", "high", "failed", "copy-failed", "late", "expired", "old"]);

/** Why the last scheduled drill failed, by its result: check.mjs's `DRILL_FAILURES`. */
export const DRILL_FAILURES = {
  "not-restored": "the snapshot did not restore.",
  unhealthy:
    "the app did not become healthy on the restored data, with no internet and none of production's .env values.",
  failed: "the copy could not be made, cut off from the internet or started.",
};

/** check.mjs's hints, by check. */
export const HINTS = {
  disk: "Old container images and logs usually fill it. To see more, run `npx opscrew status` in this repository; on the server, `docker system df` shows what Docker keeps.",
  snapshot:
    "To see why, run `npx opscrew status` in this repository, with `--app <key>` and `--env <name>` for an app or environment other than the first app's prod. The snapshot's output stays on the server, in .snapshots/scheduled.log in the app's folder.",
  drill:
    "To see why, run `npx opscrew status` in this repository, with `--app <key>` and `--env <name>` for an app or environment other than the first app's prod; `npx opscrew restore --drill` runs a drill now. Each drill's line stays on the server, in .snapshots/drills.log in the app's folder.",
  certificate:
    "Certificates are normally renewed 30 days before they expire, so this one's renewal is failing. To see why, run `npx opscrew status` in this repository; on a server, `npx opscrew logs --service edge` shows the reverse proxy's lines.",
};

/** How a credential's date came about: check.mjs's `CREDENTIAL_DATES`. */
export const CREDENTIAL_DATES = {
  rotated: "was last rotated",
  made: "was made",
  "first-deploy": "dates from the first deploy,",
};

/**
 * One run: every entry's hostnames, their posts, the servers whose reports stopped or resumed,
 * and the states that changed.
 */
export async function runUptime(env, io) {
  const kv = env.UPTIME;
  const now = io.now();
  // One list of every key: the entries, and each server's last report time, in its metadata.
  const { keys } = await kv.list();
  const reported = new Map(
    keys
      .filter(({ name }) => name.startsWith(REPORT))
      .map(({ name, metadata }) => [name, metadata]),
  );
  const loaded = await Promise.all(
    keys
      .filter(({ name }) => name.startsWith(ENTRY))
      .map(async ({ name }) => {
        const id = name.slice(ENTRY.length);
        const [entry, state] = await Promise.all([
          kv.get(name, "json"),
          kv.get(STATE + id, "json"),
        ]);
        return { id, entry, state };
      }),
  );

  const entries = [];
  for (const { id, entry, state } of loaded) {
    if (entry === null) continue; // removed since the list
    const secret = env[entry.secret];
    if (typeof secret !== "string") {
      console.log(`${id}: its webhook secret ${entry.secret} is not set, so this run skips it.`);
      continue;
    }
    const hook = hookOf(secret);
    if (hook === undefined) {
      console.log(`${id}: its webhook secret ${entry.secret} is not valid, so this run skips it.`);
      continue;
    }
    const old = state?.hosts ?? {};
    // A hostname or server no longer in the entry leaves the state now, with no message.
    const next = {};
    for (const { hostname } of entry.hosts) if (old[hostname]) next[hostname] = old[hostname];
    const wasStopped = state?.stopped ?? {};
    const stopped = {};
    for (const { id: server } of entry.servers ?? []) {
      if (wasStopped[server]) stopped[server] = wasStopped[server];
    }
    const changed =
      Object.keys(old).some((hostname) => next[hostname] === undefined) ||
      Object.keys(wasStopped).some((server) => stopped[server] === undefined);
    entries.push({ id, entry, hook, old, next, stopped, changed, tried: new Set() });
  }

  const tries = entries.flatMap((e) => e.entry.hosts.map((host) => ({ e, host })));
  if (tries.length > MAX_HOSTNAMES) {
    console.log(
      `${tries.length} hostnames are listed, more than the ${MAX_HOSTNAMES} one run can check, so the last ${tries.length - MAX_HOSTNAMES} are not checked.`,
    );
    tries.length = MAX_HOSTNAMES;
  }
  for (const { e, host } of tries) e.tried.add(host.hostname);
  const reasons = await pool(tries, ({ host }) => tryHost(host, io.fetch));

  let budget = SUBREQUESTS - tries.length;
  for (const [i, { e, host }] of tries.entries()) {
    const { hostname } = host;
    const reason = reasons[i];
    const current = e.old[hostname];
    if (current === undefined) {
      if (reason === null) continue;
      e.next[hostname] = { status: "suspect", since: iso(now), reason };
      e.changed = true;
      continue;
    }
    if (reason === null && current.status === "suspect") {
      delete e.next[hostname];
      e.changed = true;
      continue;
    }
    if (reason !== null && current.status === "down") continue;
    // From suspect to down, or from down to up: the change counts once its post is accepted.
    if (budget === 0) continue;
    budget--;
    const name = label(e.entry);
    const message =
      reason === null
        ? {
            down: false,
            title: `OpsCrew uptime check: ${name} is up again`,
            text: `OpsCrew uptime check: ${name} is up again on ${hostname}, after ${duration(now - Date.parse(current.since))}.`,
          }
        : {
            down: true,
            title: `OpsCrew uptime check: ${name} is down`,
            text: `OpsCrew uptime check: ${name} is down on ${hostname}: ${reason}, since ${utc(current.since)}. Run npx opscrew status to see more.`,
          };
    if (!(await post(e, message, io.fetch))) continue;
    if (reason === null) delete e.next[hostname];
    else e.next[hostname] = { status: "down", since: current.since, reason };
    e.changed = true;
  }

  // The servers' reports: "stopped" once one is silent past the limit, "resumed" once it isn't,
  // in what is left of the budget. A post that fails, or doesn't fit, waits for the next run.
  for (const e of entries) {
    const limit = heartbeatLimit(e.entry);
    for (const server of e.entry.servers ?? []) {
      const at = reported.get(`${REPORT}${e.id}/${server.id}`)?.at;
      const last = typeof at === "number" ? at * 1000 : Date.parse(server.since);
      const silent = now - last > limit;
      if (silent === (e.stopped[server.id] !== undefined)) continue;
      if (budget === 0) continue;
      budget--;
      const message = silent
        ? stoppedMessage(e.entry, server, at, limit)
        : resumedMessage(e.entry, server, last);
      if (!(await post(e, message, io.fetch))) continue;
      if (silent) e.stopped[server.id] = iso(now);
      else delete e.stopped[server.id];
      e.changed = true;
    }
  }

  for (const e of entries) {
    if (e.changed) {
      const stopped = Object.keys(e.stopped).length === 0 ? undefined : e.stopped;
      if (Object.keys(e.next).length === 0 && stopped === undefined) await kv.delete(STATE + e.id);
      else await kv.put(STATE + e.id, JSON.stringify({ hosts: e.next, stopped }));
    }
    // The counts are of the hostnames this run tried; those past the cap are not checked.
    const states = [...e.tried].flatMap((hostname) => e.next[hostname] ?? []);
    const suspect = states.filter((s) => s.status === "suspect").length;
    const down = states.length - suspect;
    const unchecked = e.entry.hosts.length - e.tried.size;
    console.log(
      `${e.id}: ${e.tried.size - states.length} up, ${suspect} suspect, ${down} down${unchecked === 0 ? "" : `, ${unchecked} not checked`}.`,
    );
  }
}

/** How long a server of `entry` may stay silent: 26 hours, or the test-only `heartbeatMinutes`. */
function heartbeatLimit(entry) {
  const minutes = entry.heartbeatMinutes;
  return typeof minutes === "number" &&
    minutes >= HEARTBEAT_MINUTES.min &&
    minutes <= HEARTBEAT_MINUTES.max
    ? minutes * 60_000
    : HEARTBEAT_MS;
}

/** "reports … stopped": `at`, the last report's Unix seconds, or none since it was listed. */
function stoppedMessage(entry, server, at, limit) {
  const about = `reports from ${label(entry)} on ${server.id} stopped`;
  const last =
    typeof at === "number"
      ? `the last came at ${utc(iso(at * 1000))}`
      : `none came since it was listed at ${utc(server.since)}`;
  return {
    down: true,
    title: `OpsCrew uptime check: ${about}`,
    text: `OpsCrew uptime check: ${about}: ${last}, more than ${duration(limit)} ago. The server may be down, or its timer stopped. Run npx opscrew status to see more.`,
  };
}

/** "reports resumed": `last`, the newest report's time in milliseconds. */
function resumedMessage(entry, server, last) {
  const about = `reports resumed from ${label(entry)} on ${server.id}`;
  return {
    down: false,
    title: `OpsCrew uptime check: ${about}`,
    text: `OpsCrew uptime check: ${about}: the last came at ${utc(iso(last))}.`,
  };
}

/** `<app> (<env>)`. */
function label(entry) {
  return `${entry.app} (${entry.environment})`;
}

/**
 * A request to the Worker's address. Only `POST /report` is served, and 404 answers anything
 * else. Before any KV operation it refuses a body over {@link MAX_BODY} bytes (413), and a
 * report not signed with the entry's report key, or more than 5 minutes off this clock (401), or
 * not in the report's shape (400). It then refuses a server the entry doesn't list (401), and a report no newer than
 * the one kept (409). It posts each check whose status changed, and keeps the report once every
 * post was accepted (204): a failed post answers 502 and keeps nothing, so the server sends again.
 */
export async function handleReport(request, env, io) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/report") return answer(404);
  const body = await readBody(request);
  if (body === undefined) return answer(413);
  const id = request.headers.get("x-opscrew-entry") ?? "";
  const time = request.headers.get("x-opscrew-time") ?? "";
  const signature = request.headers.get("x-opscrew-signature") ?? "";
  if (!ENTRY_ID.test(id) || !UNIX_SECONDS.test(time) || !HEX_32.test(signature)) {
    return answer(401);
  }
  // The entry's secret, by the name OpsCrew gives it: `HOOK_<16 hex of the id's SHA-256>`.
  const secret = env[`HOOK_${hex(await sha256(id)).slice(0, 16)}`];
  const hook = typeof secret === "string" ? hookOf(secret) : undefined;
  if (typeof hook?.report !== "string" || !HEX_32.test(hook.report)) return answer(401);
  if (!(await verify(hook.report, signature, `${time}\n`, body))) return answer(401);
  const at = Number(time);
  if (Math.abs(io.now() - at * 1000) > SKEW_MS) return answer(401);
  const report = parseReport(body);
  if (report === undefined) return answer(400);

  const kv = env.UPTIME;
  const entry = await kv.get(ENTRY + id, "json");
  const server = entry?.servers?.find((each) => each.id === report.server);
  if (server === undefined) {
    console.log(
      `${id}: a report from ${report.server}, a server the entry doesn't list, was refused.`,
    );
    return answer(401);
  }
  const key = `${REPORT}${id}/${server.id}`;
  const stored = await kv.get(key, "json");
  if (stored !== null && at <= stored.at) {
    console.log(`${id}: a report from ${server.id} no newer than the last one kept was refused.`);
    return answer(409);
  }
  const { kept, changes } = merge(report, stored, at);
  const e = { id, entry, hook };
  for (const change of changes) {
    if (!(await post(e, serverMessage(entry, server, change, at), io.fetch))) return answer(502);
  }
  await kv.put(key, JSON.stringify(kept), { metadata: { at } });
  console.log(
    `${id}: a ${report.kind} report from ${server.id}, with ${plural(changes.length, "change")} posted.`,
  );
  return answer(204);
}

/** An answer with no body. */
function answer(status) {
  return new Response(null, { status });
}

/** The request's body, or `undefined` once it holds more than {@link MAX_BODY} bytes. */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesOf(hexText) {
  return Uint8Array.from(hexText.match(/../g), (pair) => Number.parseInt(pair, 16));
}

/** Whether `signature` is the HMAC-SHA256 of `prefix` and `body` with `key`, in constant time. */
async function verify(key, signature, prefix, body) {
  const hmac = await crypto.subtle.importKey(
    "raw",
    bytesOf(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const start = new TextEncoder().encode(prefix);
  const data = new Uint8Array(start.length + body.length);
  data.set(start);
  data.set(body, start.length);
  return crypto.subtle.verify("HMAC", hmac, bytesOf(signature), data);
}

const oneOf =
  (...values) =>
  (value) =>
    values.includes(value);
const integer = (value) => Number.isSafeInteger(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const matches = (pattern) => (value) => typeof value === "string" && pattern.test(value);
const listOf = (test) => (value) => Array.isArray(value) && value.every(test);

/** An object with only `fields`' keys, each passing its test, and each of `required`. */
function shaped(value, fields, required) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, field]) => Object.hasOwn(fields, key) && fields[key](field))
  );
}

/** A check's test: `fields`, with `status` and `required`, and the figures its status `needs`. */
function check(fields, required = [], needs = {}) {
  return (value) =>
    shaped(value, fields, [
      "status",
      ...required,
      ...(Object.hasOwn(needs, value?.status) ? needs[value.status] : []),
    ]);
}

const FIGURES = ["percent", "free", "total"];

/**
 * data-model.md's report: its fields, and nothing else. The names are those the server's script
 * accepts in its config.
 */
const REPORT_FIELDS = {
  version: (value) => value === 1,
  server: matches(/^[A-Za-z0-9._-]+$/),
  kind: oneOf("change", "heartbeat"),
  disk: check(
    { status: oneOf("ok", "warn", "high", "unknown"), percent: count, free: count, total: count },
    [],
    { warn: FIGURES, high: FIGURES },
  ),
  snapshot: check(
    {
      status: oneOf("ok", "failed", "copy-failed", "none", "unknown"),
      id: matches(/^\d{8}T\d{6}Z$/),
    },
    [],
    { "copy-failed": ["id"] },
  ),
  drill: (value) =>
    check(
      {
        status: oneOf("ok", "failed", "late", "none", "unknown"),
        result: oneOf("healthy", ...Object.keys(DRILL_FAILURES)),
        at: matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      },
      [],
      { failed: ["result", "at"] },
    )(value) &&
    (value.status !== "failed" || Object.hasOwn(DRILL_FAILURES, value.result)),
  certificates: listOf(
    check(
      {
        hostname: matches(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/),
        status: oneOf("ok", "warn", "expired", "none"),
        days: integer,
      },
      ["hostname"],
      { warn: ["days"], expired: ["days"] },
    ),
  ),
  credentials: listOf(
    check(
      {
        // The script's names, and the plan's (`grant:laptop/cache`).
        name: matches(/^[A-Za-z0-9._:/-]+$/),
        status: oneOf("ok", "old"),
        // Below 0 for a date a little ahead of the server's clock.
        days: integer,
        source: oneOf(...Object.keys(CREDENTIAL_DATES)),
      },
      ["name", "days", "source"],
    ),
  ),
};

/** The report in `body`, or `undefined` when it isn't JSON in data-model.md's shape. */
function parseReport(body) {
  let report;
  try {
    report = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
  const required = ["version", "server", "kind", "disk", "snapshot", "drill", "certificates"];
  return shaped(report, REPORT_FIELDS, required) ? report : undefined;
}

/**
 * The report as the Worker keeps it, and the checks whose status changed. An `unknown` status,
 * and a certificate's `none`, keep the last known one, so they never post. A failing check keeps
 * `since`, when it started failing; one the report no longer holds leaves with no message.
 */
function merge(report, stored, at) {
  const before = new Map(
    stored === null ? [] : checksOf(stored).map(([kind, item]) => [keyOf(kind, item), item]),
  );
  const changes = [];
  const next = (kind, item) => {
    const last = before.get(keyOf(kind, item));
    if (
      last !== undefined &&
      (item.status === "unknown" || (kind === "certificate" && item.status === "none"))
    ) {
      return last;
    }
    const failed = last !== undefined && FAILING.has(last.status);
    if (!FAILING.has(item.status)) {
      if (failed) changes.push({ kind, item, since: last.since });
      return item;
    }
    const since = failed ? last.since : iso(at * 1000);
    if (last?.status !== item.status) changes.push({ kind, item, since });
    return { ...item, since };
  };
  const kept = {
    ...report,
    disk: next("disk", report.disk),
    snapshot: next("snapshot", report.snapshot),
    drill: next("drill", report.drill),
    certificates: report.certificates.map((item) => next("certificate", item)),
    ...(report.credentials === undefined
      ? {}
      : { credentials: report.credentials.map((item) => next("credential", item)) }),
    at,
  };
  return { kept, changes };
}

/** A report's checks, each with its kind. */
function checksOf(report) {
  return [
    ["disk", report.disk],
    ["snapshot", report.snapshot],
    ["drill", report.drill],
    ...report.certificates.map((item) => ["certificate", item]),
    ...(report.credentials ?? []).map((item) => ["credential", item]),
  ];
}

/** A check's key: its kind, and a certificate's hostname or a credential's name. */
function keyOf(kind, item) {
  return `${kind}/${item.hostname ?? item.name ?? ""}`;
}

/**
 * The message of a check whose status changed: the Actions check's title and text when it fails,
 * and when it passes again, the check and how long it failed.
 */
function serverMessage(entry, server, { kind, item, since }, at) {
  const name = label(entry);
  if (!FAILING.has(item.status)) {
    const what = {
      disk: `the disk on ${server.id}`,
      snapshot: `the scheduled snapshot on ${server.id}`,
      drill: `the scheduled restore drill on ${server.id}`,
      certificate: `the certificate on ${item.hostname}`,
      credential: `the age of the credential ${item.name}`,
    }[kind];
    return withTitle(
      false,
      `OpsCrew check: resolved, ${name}, ${what}`,
      `Resolved after ${duration(at * 1000 - Date.parse(since))}.`,
    );
  }
  const { title, what, hint } = failure(entry, server, kind, item);
  return withTitle(
    true,
    `OpsCrew check: ${name} ${title}`,
    `${what}\n\nSince ${utc(since)}.\n\n${hint}`,
  );
}

/** A message whose chat text starts with its title, and whose ntfy body doesn't. */
function withTitle(down, title, body) {
  return { down, title, text: `${title}\n${body}`, body };
}

/** check.mjs's title (after the app), what-line and hint of a failing check. */
function failure(entry, server, kind, item) {
  const { app } = entry;
  const on = server.id;
  if (kind === "disk") {
    return {
      title: `disk over ${item.status === "high" ? DISK_HIGH : DISK_WARN}% full on ${on}`,
      what: `The disk of the server ${on} is ${item.percent}% full: ${gigabytes(item.free)} free of ${gigabytes(item.total)}.`,
      hint: HINTS.disk,
    };
  }
  if (kind === "snapshot") {
    if (item.status === "failed") {
      return {
        title: `scheduled snapshot failed on ${on}`,
        what: `The last scheduled snapshot of ${app} on the server ${on} failed: OpsCrew took no snapshot.`,
        hint: HINTS.snapshot,
      };
    }
    const { id } = item;
    const due = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)} ${id.slice(9, 11)}:${id.slice(11, 13)} UTC`;
    return {
      title: `scheduled snapshot's off-server copy failed on ${on}`,
      what: `The scheduled snapshot ${id} of ${app}, due at ${due}, was taken on the server ${on}, but its copy off the server failed.`,
      hint: HINTS.snapshot,
    };
  }
  if (kind === "drill") {
    if (item.status === "failed") {
      return {
        title: `scheduled restore drill failed on ${on}`,
        what: `The last scheduled restore drill of ${app} on the server ${on} failed, at ${utc(item.at)}: ${DRILL_FAILURES[item.result]}`,
        hint: HINTS.drill,
      };
    }
    const schedule = server.drill === undefined ? "schedule" : `${server.drill} schedule`;
    return {
      title: `no scheduled restore drill on ${on}`,
      what:
        item.at === undefined
          ? `No scheduled restore drill of ${app} has run on the server ${on} within twice its ${schedule}: each was skipped or did not start.`
          : `No scheduled restore drill of ${app} has run on the server ${on} since ${utc(item.at)}, more than twice its ${schedule}: each was skipped or did not start.`,
      hint: HINTS.drill,
    };
  }
  if (kind === "certificate") {
    const { hostname, days } = item;
    return item.status === "expired"
      ? {
          title: `certificate has expired on ${hostname}`,
          what: `The certificate of ${hostname} expired ${plural(-days, "day")} ago.`,
          hint: HINTS.certificate,
        }
      : {
          title: `certificate expires within ${CERT_DAYS} days on ${hostname}`,
          what: `The certificate of ${hostname} expires in ${plural(days, "day")}.`,
          hint: HINTS.certificate,
        };
  }
  return {
    title: `credential ${item.name} is due for rotation`,
    what: `The credential ${item.name} of ${label(entry)} ${CREDENTIAL_DATES[item.source]} ${plural(item.days, "day")} ago, more than the plan's credentials.maxAgeDays.`,
    hint: `To rotate it, run \`npx opscrew rotate ${item.name}${entry.rotate ?? ""}\` in this repository.`,
  };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function gigabytes(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** The webhook secret's value, or `undefined` when it isn't JSON with a string `url`. */
function hookOf(secret) {
  try {
    const hook = JSON.parse(secret);
    return typeof hook?.url === "string" ? hook : undefined;
  } catch {
    return undefined;
  }
}

/** `fn` over `items`, {@link POOL} at once, the results in their order. */
async function pool(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, work));
  return results;
}

/** One try, which never reads the answer's body: `null` when up, else the failure's reason. */
async function tryHost({ hostname, healthPath }, fetch) {
  let status;
  try {
    const response = await fetch(`https://${hostname}${healthPath}`, {
      redirect: "manual",
      headers: { "user-agent": "OpsCrew uptime check" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
    await response.body?.cancel();
  } catch {
    if (status === undefined) return "not reachable";
  }
  if (status >= 200 && status < 400) return null;
  // Cloudflare's own errors: the origin's certificate, or the origin not answering.
  if (status === 525 || status === 526) return "an invalid certificate";
  if ((status >= 520 && status <= 524) || status === 530) return "not reachable";
  return `answered with status ${status}`;
}

/**
 * Posts `message` to the entry's webhook, cut to its limit: its `text` to Slack and Discord, and
 * to ntfy its `title` and its `body` (or its `text`). True once it was accepted.
 */
async function post(e, message, fetch) {
  const kind = e.entry.webhook;
  let init;
  if (kind === "slack") {
    init = json({ text: cut(message.text, WEBHOOK_LIMITS.slack) });
  } else if (kind === "discord") {
    init = json({
      content: cut(message.text, WEBHOOK_LIMITS.discord),
      allowed_mentions: { parse: [] },
    });
  } else {
    init = {
      headers: {
        title: message.title,
        priority: message.down ? "4" : "3",
        ...(e.hook.token ? { authorization: `Bearer ${e.hook.token}` } : {}),
      },
      body: cutBytes(message.body ?? message.text, WEBHOOK_LIMITS.ntfy),
    };
  }
  let why;
  try {
    const response = await fetch(e.hook.url, {
      method: "POST",
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok) return true;
    why = `HTTP ${response.status}`;
  } catch {
    why = "not reachable";
  }
  console.log(`${e.id}: the ${kind} webhook failed (${why}).`);
  return false;
}

function json(value) {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

/** `2026-11-25T10:05:00Z`, to the second. */
function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `2026-11-25 10:05 UTC`. */
function utc(isoTime) {
  return `${isoTime.slice(0, 16).replace("T", " ")} UTC`;
}

/** `15 minutes`, `1 hour 5 minutes`, `2 days 3 hours`. */
function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const parts =
    days > 0
      ? [
          [days, "day"],
          [hours, "hour"],
        ]
      : [
          [hours, "hour"],
          [minutes % 60, "minute"],
        ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}${n === 1 ? "" : "s"}`)
    .join(" ");
}

/** `text` cut to `limit` characters. */
function cut(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** `text` cut to `limit` bytes of UTF-8, never inside a character. */
function cutBytes(text, limit) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  let end = limit - 3; // room for "…"
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${new TextDecoder().decode(bytes.slice(0, end))}…`;
}

export default {
  /** The Cron Trigger's handler. */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runUptime(env, { fetch: (input, init) => fetch(input, init), now: Date.now }));
  },

  /** The workers.dev address's handler: the servers' reports. */
  async fetch(request, env) {
    return handleReport(request, env, {
      fetch: (input, init) => fetch(input, init),
      now: Date.now,
    });
  },
};

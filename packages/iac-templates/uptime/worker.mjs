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
// A message holds only fixed sentences, names, hostnames, status codes and times: never what the
// app answered, never an address and never a secret. It has no imports.

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

/** One run: every entry's hostnames, their posts, and the states that changed. */
export async function runUptime(env, io) {
  const kv = env.UPTIME;
  const now = io.now();
  const { keys } = await kv.list({ prefix: ENTRY });
  const loaded = await Promise.all(
    keys.map(async ({ name }) => {
      const id = name.slice(ENTRY.length);
      const [entry, state] = await Promise.all([kv.get(name, "json"), kv.get(STATE + id, "json")]);
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
    const old = state?.hosts ?? {};
    // A hostname no longer in the entry leaves the state at its next write.
    const next = {};
    for (const { hostname } of entry.hosts) if (old[hostname]) next[hostname] = old[hostname];
    entries.push({ id, entry, hook: JSON.parse(secret), old, next, changed: false });
  }

  const tries = entries.flatMap((e) => e.entry.hosts.map((host) => ({ e, host })));
  if (tries.length > MAX_HOSTNAMES) {
    console.log(
      `${tries.length} hostnames are listed, more than the ${MAX_HOSTNAMES} one run can check, so the last ${tries.length - MAX_HOSTNAMES} are not checked.`,
    );
    tries.length = MAX_HOSTNAMES;
  }
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
    const label = `${e.entry.app} (${e.entry.environment})`;
    const message =
      reason === null
        ? {
            down: false,
            title: `OpsCrew uptime check: ${label} is up again`,
            text: `OpsCrew uptime check: ${label} is up again on ${hostname}, after ${duration(now - Date.parse(current.since))}.`,
          }
        : {
            down: true,
            title: `OpsCrew uptime check: ${label} is down`,
            text: `OpsCrew uptime check: ${label} is down on ${hostname}: ${reason}, since ${utc(current.since)}. Run npx opscrew status to see more.`,
          };
    if (!(await post(e, message, io.fetch))) continue;
    if (reason === null) delete e.next[hostname];
    else e.next[hostname] = { status: "down", since: current.since, reason };
    e.changed = true;
  }

  for (const e of entries) {
    if (e.changed) {
      if (Object.keys(e.next).length === 0) await kv.delete(STATE + e.id);
      else await kv.put(STATE + e.id, JSON.stringify({ hosts: e.next }));
    }
    const states = Object.values(e.next);
    const suspect = states.filter((s) => s.status === "suspect").length;
    const down = states.length - suspect;
    console.log(
      `${e.id}: ${e.entry.hosts.length - states.length} up, ${suspect} suspect, ${down} down.`,
    );
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

/** Posts `message` to the entry's webhook, cut to its limit; true once it was accepted. */
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
      body: cutBytes(message.text, WEBHOOK_LIMITS.ntfy),
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
};

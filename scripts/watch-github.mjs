#!/usr/bin/env node
// Wakes an AI agent within seconds of someone's activity on a GitHub repository, then ends. Run it
// as a background task (in Claude Code, `run_in_background`); its ending is what wakes the session.
// Nothing wakes it while nothing happens, so it costs no model usage between events. Start it again
// after every wake.
//
// Usage:
//   node scripts/watch-github.mjs --wake-on <login>   wake on that user's activity (an answer)
//   node scripts/watch-github.mjs --except <login>    wake on anyone else's activity
//   [--repo <owner/name>] (default opscrew-hub/opscrew) [--title <text>] (only issues and pull
//   requests whose title contains it, such as "[035]")
//
// It wakes on an issue or pull request opened, reopened or closed, a pull request's new commits or
// review, and a new comment. How: `gh webhook forward` (GitHub's CLI extension,
// `gh extension install cli/gh-webhook`) creates a temporary webhook and streams its events, over
// a connection it opens itself, to a listener on 127.0.0.1, checked with a random secret per run.
// It needs the `admin:repo_hook` scope (`gh auth refresh -s admin:repo_hook`) and admin rights on
// the repository. Without them, or when GitHub drops the connection for long, it checks by polling
// every 5 minutes instead. It prints one line per wake, never an event's contents.

import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "opscrew-hub/opscrew" },
    "wake-on": { type: "string" },
    except: { type: "string" },
    title: { type: "string" },
  },
});
const repo = values.repo;
if ((values["wake-on"] === undefined) === (values.except === undefined)) {
  console.error("Give exactly one of --wake-on <login> or --except <login>.");
  process.exit(2);
}
/** Whether an action by `login` should wake the agent. */
const wakes = (login) =>
  login !== undefined &&
  !login.endsWith("[bot]") &&
  (values["wake-on"] !== undefined ? login === values["wake-on"] : login !== values.except);
const titled = (title) => values.title === undefined || (title ?? "").includes(values.title);

const SECRET = randomBytes(32).toString("hex");
const EVENTS = "issue_comment,issues,pull_request,pull_request_review,pull_request_review_comment";
const ACTIONS = new Set([
  "opened",
  "reopened",
  "closed",
  "created",
  "submitted",
  "synchronize",
  "ready_for_review",
]);

function wake(line) {
  console.log(`Woken: ${line}`);
  process.exit(0);
}

/** The line to wake on for a pushed event, if it is one. */
function summary(event, body) {
  const login = body.sender?.login;
  const item = body.issue ?? body.pull_request ?? {};
  if (!wakes(login) || !ACTIONS.has(body.action) || !titled(item.title)) return undefined;
  return `${event} ${body.action} by ${login} on #${item.number}: ${item.title} ${item.html_url ?? ""}`;
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    response.end();
    const raw = Buffer.concat(chunks);
    const expected = Buffer.from(
      `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
    );
    const given = Buffer.from(String(request.headers["x-hub-signature-256"] ?? ""));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return;
    const line = summary(String(request.headers["x-github-event"]), JSON.parse(raw.toString()));
    if (line) wake(line);
  });
});

const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const HOOK_QUERY =
  '.[] | select(.name == "cli" and .config.url == "https://webhook-forwarder.github.com/hook") | .id';

/** The ids of the repository's forwarding hooks now; none without admin rights. */
function forwardingHooks() {
  try {
    return new Set(
      gh(["api", `repos/${repo}/hooks`, "--jq", HOOK_QUERY])
        .split(/\s+/)
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * The hooks this run's forwarder created, the ones that appeared after it started. Only those are
 * ever deleted: another agent's watcher on the same repository keeps its own.
 */
let ownHooks = new Set();
function removeOwnHooks() {
  for (const id of ownHooks) {
    try {
      gh(["api", "-X", "DELETE", `repos/${repo}/hooks/${id}`]);
    } catch {
      // Already gone.
    }
  }
  ownHooks = new Set();
}

/** Every activity line polling can see now, keyed so each is reported once. */
function polled() {
  const lines = new Map();
  for (const kind of ["issue", "pr"]) {
    const items = JSON.parse(
      gh([
        kind,
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--limit",
        "50",
        "--json",
        kind === "pr"
          ? "number,title,author,comments,state,isDraft,headRefOid,reviews"
          : "number,title,author,comments,state",
      ]),
    );
    for (const item of items.filter((i) => titled(i.title))) {
      if (wakes(item.author.login))
        lines.set(
          `${kind}#${item.number}`,
          `${kind} #${item.number} by ${item.author.login}: ${item.title}`,
        );
      if (kind === "pr" && wakes(item.author.login)) {
        // A draft turned ready, and each new push, wake as well (the push key is its head commit).
        if (item.isDraft === false)
          lines.set(
            `pr#${item.number}:ready`,
            `pr #${item.number} ready for review: ${item.title}`,
          );
        if (item.headRefOid)
          lines.set(
            `pr#${item.number}@${item.headRefOid}`,
            `push to pr #${item.number}: ${item.title}`,
          );
      }
      for (const review of item.reviews ?? []) {
        if (wakes(review.author?.login)) {
          lines.set(
            `${kind}#${item.number}~${review.submittedAt}`,
            `review by ${review.author.login} on ${kind} #${item.number}: ${item.title}`,
          );
        }
      }
      for (const comment of item.comments ?? []) {
        if (wakes(comment.author.login)) {
          lines.set(
            `${kind}#${item.number}@${comment.createdAt}`,
            `comment by ${comment.author.login} on ${kind} #${item.number}: ${item.title}`,
          );
        }
      }
    }
  }
  return lines;
}

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  let seen = new Map();
  try {
    seen = polled();
  } catch {
    // GitHub unreachable at start: the next poll tries again.
  }
  setInterval(
    () => {
      try {
        for (const [key, line] of polled()) if (!seen.has(key)) wake(`${line} (polled)`);
      } catch {
        // A failed poll waits for the next one.
      }
    },
    5 * 60 * 1000,
  );

  let backoff = 5;
  let child;
  const forward = () => {
    const before = forwardingHooks();
    const started = Date.now();
    // The forwarder's own hook appears within seconds of its start.
    setTimeout(() => {
      for (const id of forwardingHooks()) if (!before.has(id)) ownHooks.add(id);
    }, 15 * 1000);
    child = spawn(
      "gh",
      [
        "webhook",
        "forward",
        `--repo=${repo}`,
        `--events=${EVENTS}`,
        `--url=http://127.0.0.1:${port}/`,
        `--secret=${SECRET}`,
      ],
      { stdio: "ignore" },
    );
    child.on("exit", () => {
      // GitHub drops the connection every few hours: reconnect, backing off to 5 minutes.
      removeOwnHooks();
      backoff = Date.now() - started > 10 * 60 * 1000 ? 5 : Math.min(300, backoff * 2);
      setTimeout(forward, backoff * 1000);
    });
  };
  process.on("exit", () => {
    child?.kill();
    removeOwnHooks();
  });
  forward();
  console.error(`Watching ${repo}; started ${new Date().toISOString()}.`);
});

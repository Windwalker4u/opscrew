#!/usr/bin/env node
// Announces a release in the Announcements category of OpsCrew's forum, discuss.opscrew.dev: the
// changelog section's opening paragraphs (what to redo), the first sentence of each entry, and the
// links to the full notes. Without --post it only prints the post.
//
// Usage: node scripts/forum-announce.mjs <version>                                    (print)
//        node --env-file=.env.release scripts/forum-announce.mjs <version> --post     (post)
// --post reads the forum's API key from OPSCREW_FORUM_API_KEY and never prints it.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const forum = "https://discuss.opscrew.dev";
const [version, flag] = process.argv.slice(2);
if (!version || (flag !== undefined && flag !== "--post")) {
  console.error("Name the version, for example: node scripts/forum-announce.mjs 0.2.11 [--post]");
  process.exit(1);
}

// The GitHub release's notes: the section with absolute links and unwrapped lines.
const notes = execFileSync(
  process.execPath,
  [join(dirname(fileURLToPath(import.meta.url)), "release-notes.mjs"), version],
  { encoding: "utf8" },
).replace(/\n\*\*Full changelog:\*\*.*\n?$/, "");

const firstSentence = (item) => {
  const bold = item.match(/^\*\*([^*]+[.!?])\*\*/);
  if (bold) return `**${bold[1]}**`;
  return item.match(/^(.*?[.!?])(?=\s+[A-Z`*[]|$)/)?.[1] ?? item;
};

const [intro, ...sections] = notes.split(/^### /m);
const summary = sections.map((section) => {
  const [heading, ...rest] = section.split("\n");
  const items = rest.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
  return `**${heading.trim()}**\n\n${items.map((item) => `- ${firstSentence(item)}`).join("\n")}`;
});
const release = `https://github.com/opscrew-hub/opscrew/releases/tag/v${version}`;
const title = `OpsCrew ${version}`;
const content = [
  `OpsCrew ${version} is out: \`npx opscrew@latest --version\` prints it, and \`claude plugin update opscrew@opscrew\` brings the Claude Code plugin to it.`,
  intro.trim(),
  ...summary,
  `Every change, explained: [the release notes on GitHub](${release}).`,
]
  .filter(Boolean)
  .join("\n\n");

if (flag !== "--post") {
  process.stdout.write(`# ${title}\n\n${content}\n`);
  process.exit(0);
}

const key = process.env.OPSCREW_FORUM_API_KEY;
if (!key) {
  console.error(
    "OPSCREW_FORUM_API_KEY is not set. Run it as `node --env-file=.env.release scripts/forum-announce.mjs <version> --post`.",
  );
  process.exit(1);
}
const headers = {
  authorization: `Token ${key}`,
  accept: "application/vnd.api+json",
  "content-type": "application/vnd.api+json",
};
const api = async (path, init = {}) => {
  const response = await fetch(`${forum}/api${path}`, { ...init, headers });
  if (!response.ok) {
    console.error(
      `The forum answered ${path} with HTTP ${response.status}. Check that the key in .env.release is still in the forum's api_keys table.`,
    );
    process.exit(1);
  }
  return response.json();
};

const tags = await api("/tags");
const tag = tags.data.find((t) => t.attributes.slug === "announcements");
if (!tag) {
  console.error(
    "The forum has no category with the slug `announcements`. Create it, then run this again.",
  );
  process.exit(1);
}
const existing = await api("/discussions?filter[tag]=announcements&page[limit]=50");
const same = existing.data.find((d) => d.attributes.title === title);
if (same) {
  console.log(`Already announced: ${forum}/d/${same.id}`);
  process.exit(0);
}
const created = await api("/discussions", {
  method: "POST",
  body: JSON.stringify({
    data: {
      type: "discussions",
      attributes: { title, content },
      relationships: { tags: { data: [{ type: "tags", id: tag.id }] } },
    },
  }),
});
console.log(`Announced: ${forum}/d/${created.data.id}`);

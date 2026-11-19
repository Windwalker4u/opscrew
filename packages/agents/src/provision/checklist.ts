/**
 * The two review lists of the pull requests OpsCrew opens: what this run checked ("Checked by
 * OpsCrew", ticked) and what is left to the reviewer ("For you to check"). The checks are
 * read-only: OpsCrew's secret rules over the files the pull request changes, and whether each
 * action of the workflows it writes is pinned to a commit SHA.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSecretsScanner } from "@opscrew/secops";
import type { PhaseDeps } from "../context";

/** A finding of OpsCrew's secret rules: its rule and file, never its value. */
export interface SecretFinding {
  ruleId: string;
  file: string;
}

/** What the workflows' `uses:` lines say about their actions. */
export interface WorkflowCheck {
  /** Each `uses:` not pinned to a commit SHA, with its file. */
  unpinned: readonly { file: string; uses: string }[];
  /** The owners of the actions that are not GitHub's own (`actions/*`), sorted. */
  owners: readonly string[];
}

/** What the run that writes a pull request body checked (absent: not checked, left to the reviewer). */
export interface ReviewChecks {
  /** The secret rules' findings in the files the pull request changes. */
  secrets?: readonly SecretFinding[];
  /** The check of the workflows the run wrote. */
  workflow?: WorkflowCheck;
}

/** A pull request's two review lists, as item texts without their boxes. */
export interface ReviewLists {
  checked: string[];
  forYou: string[];
}

/**
 * Runs OpsCrew's secret rules (offline) over `files`, relative to `root`, and returns each
 * finding's rule and file once. A file that is missing or binary has none.
 */
export async function scanSecrets(
  deps: Pick<PhaseDeps, "fetch" | "runner">,
  root: string,
  files: readonly string[],
): Promise<SecretFinding[]> {
  const findings = await createSecretsScanner().scan({
    rootDir: root,
    files,
    readFile: (path) => readFile(join(root, path), "utf8"),
    offline: true,
    fetch: deps.fetch,
    runner: deps.runner,
  });
  const seen = new Map<string, SecretFinding>();
  for (const { ruleId, file } of findings) {
    if (file !== undefined) seen.set(`${ruleId}\0${file}`, { ruleId, file });
  }
  return [...seen.values()];
}

/** `owner/repo[/path]@<40 hex>`, or a local action. */
const PINNED = /^(?:\.\/.*|[\w.-]+\/[\w./-]+@[0-9a-f]{40})$/;
const USES = /^\s*(?:-\s+)?uses:\s*(["']?)([^"'\s#]+)\1/gm;

/** Checks the `uses:` lines of each workflow `text` by its file. */
export function checkWorkflows(
  workflows: readonly { file: string; text: string }[],
): WorkflowCheck {
  const unpinned: { file: string; uses: string }[] = [];
  const owners = new Set<string>();
  for (const { file, text } of workflows) {
    for (const match of text.matchAll(USES)) {
      const uses = match[2] as string;
      if (!PINNED.test(uses)) unpinned.push({ file, uses });
      const owner = uses.split("/")[0] as string;
      if (!uses.startsWith("./") && !uses.startsWith("docker://") && owner !== "actions") {
        owners.add(owner);
      }
    }
  }
  return { unpinned, owners: [...owners].sort() };
}

/** Reads the workflows of `files` under `root` and checks them; undefined when none was read. */
export async function checkWorkflowFiles(
  root: string,
  files: readonly string[],
): Promise<WorkflowCheck | undefined> {
  const read = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(root, file), "utf8").catch(() => undefined);
      return text === undefined ? undefined : { file, text };
    }),
  );
  const workflows = read.filter((entry) => entry !== undefined);
  return workflows.length === 0 ? undefined : checkWorkflows(workflows);
}

/** `a`, `a and b`, `a, b and c`. */
function and(items: readonly string[]): string {
  return items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The secret item: ticked when the rules found nothing, else for the reviewer with each finding's
 * rule and file. Unchecked, `unchecked` for the reviewer (none when it is undefined).
 */
export function secretItems(
  secrets: readonly SecretFinding[] | undefined,
  unchecked?: string,
): ReviewLists {
  if (secrets === undefined)
    return { checked: [], forYou: unchecked === undefined ? [] : [unchecked] };
  if (secrets.length === 0) {
    return {
      checked: [
        "OpsCrew's secret rules found no secret value in the files this pull request changes.",
      ],
      forYou: [],
    };
  }
  const found = secrets.map(({ ruleId, file }) => `\`${ruleId}\` in \`${file}\``);
  return {
    checked: [],
    forYou: [
      `OpsCrew's secret rules flagged ${and(found)}: check each and move any secret value out of the repository.`,
    ],
  };
}

/**
 * The workflow's items: ticked when every action is pinned to a commit SHA, else each unpinned one
 * for the reviewer; and the owners of actions that are not GitHub's own, to trust. Unchecked, both
 * for the reviewer.
 */
export function workflowItems(workflow: WorkflowCheck | undefined): ReviewLists {
  if (workflow === undefined) {
    return {
      checked: [],
      forYou: [
        "Every action the workflow uses is pinned to a commit SHA, and you trust the owners of those that are not GitHub's own.",
      ],
    };
  }
  const lists: ReviewLists = { checked: [], forYou: [] };
  if (workflow.unpinned.length === 0) {
    lists.checked.push("Every action the workflow uses is pinned to a commit SHA.");
  } else {
    const named = workflow.unpinned.map(({ file, uses }) => `\`${uses}\` in \`${file}\``);
    lists.forYou.push(
      `Not pinned to a commit SHA: ${and(named)}. Pin each to a commit SHA, or check that you trust what it points at.`,
    );
  }
  if (workflow.owners.length > 0) {
    lists.forYou.push(
      `The workflow also uses actions by ${and(workflow.owners)}: check that you trust them.`,
    );
  }
  return lists;
}

/** The lists of `parts` joined in order. */
export function joinLists(...parts: readonly ReviewLists[]): ReviewLists {
  return {
    checked: parts.flatMap((part) => part.checked),
    forYou: parts.flatMap((part) => part.forYou),
  };
}

/**
 * The body's lines for the two lists, each after a blank line: `## ` headings (`section`) or a
 * label line (`label`). A list with no item is left out.
 */
export function reviewListLines(lists: ReviewLists, style: "section" | "label"): string[] {
  const list = (title: string, box: string, items: readonly string[]) =>
    items.length === 0
      ? []
      : [
          "",
          ...(style === "section" ? [`## ${title}`, ""] : [`${title}:`]),
          ...items.map((item) => `- ${box} ${item}`),
        ];
  return [
    ...list("Checked by OpsCrew", "[x]", lists.checked),
    ...list("For you to check", "[ ]", lists.forYou),
  ];
}

/**
 * A deployment pull request's lists (label style): the secret and workflow checks, then the
 * reviewer's own items `forYou`.
 */
export function deployReviewLines(checks: ReviewChecks | undefined, ...forYou: string[]): string[] {
  return reviewListLines(
    joinLists(secretItems(checks?.secrets), workflowItems(checks?.workflow), {
      checked: [],
      forYou,
    }),
    "label",
  );
}

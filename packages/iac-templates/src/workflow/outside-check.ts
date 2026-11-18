// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import type { RenderedFile } from "../types";

/** The outside check's workflow file name, under `.github/workflows/`. */
export const OUTSIDE_CHECK_WORKFLOW_FILE = "opscrew-outside-check.yml";

/** The outside check's jobs: port 80 and port 443, each answered from GitHub's hosted network. */
export const OUTSIDE_CHECK_JOBS = ["http", "https"] as const;

/** One of {@link OUTSIDE_CHECK_JOBS}. */
export type OutsideCheckJob = (typeof OUTSIDE_CHECK_JOBS)[number];

const JOBS: Record<OutsideCheckJob, { name: string; url: string }> = {
  http: { name: "Port 80 answers from outside", url: "http://$HOST/" },
  https: {
    name: "Port 443 answers from outside",
    url: "https://$HOST$CHECK_PATH?opscrew-outside-check=$GITHUB_RUN_ID",
  },
};

/**
 * A job's script: fixed text that reads the inputs only from `env`, checks them, and requests the
 * URL up to six times, 20 s apart. A try passes on an answer that is not `000`, a Cloudflare origin
 * error (520 to 527, 530) or a Cloudflare challenge (a `cf-mitigated` header). curl runs with `-s`
 * and without `-S`, so its error text, which can name an address, is never printed; nor is the
 * header file. Only each try's codes are.
 */
function probe(job: OutsideCheckJob): string[] {
  return [
    "host_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'",
    "path_re='^/[A-Za-z0-9._~/-]{0,200}$'",
    "if (( ${#HOST} > 253 )) || [[ ! $HOST =~ $host_re || ! $CHECK_PATH =~ $path_re ]] || [[ $MODE != proxied && $MODE != direct ]]; then",
    '  echo "invalid input"',
    "  exit 1",
    "fi",
    `URL="${JOBS[job].url}"`,
    "for try in 1 2 3 4 5 6; do",
    '  rm -f "$RUNNER_TEMP/h"',
    "  rc=0",
    `  code=$(curl -s -o /dev/null -D "$RUNNER_TEMP/h" --max-time 15 -w '%{http_code}' "$URL") || rc=$?`,
    '  challenged=""',
    '  if grep -qi \'^cf-mitigated:\' "$RUNNER_TEMP/h" 2> /dev/null; then challenged=", challenged"; fi',
    `  echo "${job} try $try: code $code, curl $rc$challenged"`,
    "  if (( rc == 0 )) && [[ -z $challenged ]]; then",
    "    case $code in 000 | 52[0-7] | 530) ;; *) exit 0 ;; esac",
    "  fi",
    "  if (( try < 6 )); then sleep 20; fi",
    "done",
    "exit 1",
  ];
}

function jobLines(job: OutsideCheckJob): string[] {
  return [
    `  ${job}:`,
    "    runs-on: ubuntu-24.04",
    "    timeout-minutes: 5",
    "    steps:",
    `      - name: ${JOBS[job].name}`,
    "        env:",
    "          HOST: ${{ inputs.host }}",
    "          CHECK_PATH: ${{ inputs.path }}",
    "          MODE: ${{ inputs.mode }}",
    "        run: |",
    ...probe(job).map((line) => `          ${line}`),
  ];
}

/**
 * `.github/workflows/opscrew-outside-check.yml`: one file per repository, started with
 * `workflow_dispatch` (`host`, `path`, `mode`), that checks from GitHub's hosted network that a
 * home app answers on ports 80 and 443. It has no token permissions, no secret, no action and no
 * checkout, and never gets the home's address: the runner resolves the hostname itself.
 */
export function renderOutsideCheckWorkflow(): RenderedFile {
  const lines = [
    "# Managed by OpsCrew: checks from outside your home that your app answers on ports 80 and 443.",
    "# `opscrew verify` starts it. It changes nothing, and it never gets your home's address.",
    "name: OpsCrew outside check",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      host:",
    `        description: "The app's hostname"`,
    "        required: true",
    "        type: string",
    "      path:",
    `        description: "The app's health path"`,
    "        required: true",
    "        type: string",
    "      mode:",
    `        description: "proxied or direct"`,
    "        required: true",
    "        type: choice",
    "        options: [proxied, direct]",
    "permissions: {}",
    "concurrency:",
    "  group: opscrew-outside-check-${{ inputs.host }}",
    "  cancel-in-progress: false",
    "jobs:",
    ...OUTSIDE_CHECK_JOBS.flatMap(jobLines),
  ];
  return {
    path: `.github/workflows/${OUTSIDE_CHECK_WORKFLOW_FILE}`,
    content: `${lines.join("\n")}\n`,
    kind: "workflow",
  };
}

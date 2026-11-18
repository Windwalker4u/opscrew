// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
/**
 * `snapshot.sh drill` (029 plan.md 19., research R15–R19, R26, R28, R29): the app's server's, or
 * this computer's, restore drill by hand, and on a server the scheduled one, which keep their
 * bounds themselves, whatever asks them.
 */
import { APP_SERVER, type DeployPlan, servicesOn, snapshotScheduleOf } from "@opscrew/plan-schema";
import { IMAGES } from "../pins";
import type { PreviewEnvTemplates } from "../previews";
import { PREVIEW_SECRET_PLACEHOLDER, previewGenerate, previewSecretFill } from "../previews/script";
import { wrongTarget } from "../providers";
import { shellQuote } from "../runtime/services";
import type { RenderedFile } from "../types";
import { planFilePath, said } from "../workflow/shared";
import {
  databaseCount,
  type RestoreProject,
  restoreFunctions,
  SNAPSHOTS_DIR,
  snapshotParts,
} from "../workflow/snapshots";
import { appFolder, approvalExpiry, readApproval, START_LOCK } from "../workflow/switch";
import { DRILL_DIR, renderDrill } from "./index";
import {
  DRILL_APPROVAL_FILE,
  DRILL_LIMIT_SECONDS,
  DRILL_RECORD_PREFIX,
  DRILLS_LOG,
} from "./record";

/** How long the app's health check may take to pass (R17). */
const HEALTH_SECONDS = 300;

/** How long an app with no health check must keep running (R17). */
const RUNNING_SECONDS = 60;

/** The seconds between two reads of the app's health. */
const HEALTH_POLL_SECONDS = 5;

/** The copy's folder in the script: `.drill/<id>`. */
const DIR = '"$_drill_dir"';

/** The words of a skip's reason, after "OpsCrew skipped this drill: ". */
const SKIPS: Record<string, string> = {
  locked: "a deploy or a snapshot was running.",
  rotation: "a credential rotation holds the app.",
  disk: "the disk has less free space than the snapshot's size and 1 GiB and 10% of the disk.",
  memory: "the machine has less free memory than the copy's memory limits add up to.",
  kept: "the copy of an earlier drill, kept with --keep, is still here; opscrew restore --drill --remove removes it.",
  none: "there is no complete scheduled snapshot here yet.",
};

/**
 * The scheduled drill's copy in the app's folder on its server (research R28): outside
 * {@link DRILL_DIR}, which each drill clears. The host plan that installs the schedule writes it
 * with {@link drillRecipe}'s files, and `values.env` (`.env.preview`'s values, mode 600) at apply
 * time; `snapshot.sh drill scheduled` only reads it.
 */
export const DRILL_RECIPE_DIR = ".drill-recipe";

/** The file in {@link DRILL_RECIPE_DIR} with the drills' schedule: `weekly` or `daily`. */
export const DRILL_RECIPE_SCHEDULE = "schedule";

/**
 * The digest the recipe's `compose.yaml` names the app's image with: the scheduled drill puts the
 * version the snapshot recorded in its place, so the copy runs the snapshot's own version.
 */
export const DRILL_RECIPE_DIGEST = `sha256:${"0".repeat(64)}`;

/** The hours a scheduled drill's slot comes after the scheduled snapshot's (research R28). */
export const DRILL_SLOT_AFTER_HOURS = 3;

/** The schedule's period in hours: weekly 168, daily 24. */
export function drillScheduleHours(every: "weekly" | "daily"): number {
  return every === "daily" ? 24 : 168;
}

/**
 * The files of the scheduled drill's copy, each under {@link DRILL_RECIPE_DIR}, for the host plan
 * that installs the schedule (`snapshots.drills.schedule`): the copy {@link renderDrill} renders
 * of the parts a scheduled snapshot holds (those copied while they run, and the stop-only ones
 * `snapshots.schedule.stop` names), the app's image `<o.repository>@`{@link DRILL_RECIPE_DIGEST},
 * and {@link DRILL_RECIPE_SCHEDULE}. `values.env` is not among them: with `o.previewValues`, the
 * host plan writes it at apply time. Generated values stay the preview server's placeholders,
 * which the drill fills on the server.
 * @throws OpsCrewError without `snapshots.drills.schedule` or a part on the app's server, or for
 * what {@link renderDrill} refuses.
 */
export function drillRecipe(
  plan: DeployPlan,
  o: { repository: string; env: PreviewEnvTemplates; previewValues?: boolean },
): RenderedFile[] {
  const every = plan.snapshots?.drills?.schedule;
  const stop = snapshotScheduleOf(plan)?.stop ?? [];
  const parts = snapshotParts(plan)
    .filter((part) => part.online || stop.includes(part.name))
    .map((part) => part.name);
  if (every === undefined || parts.length === 0) {
    throw wrongTarget(
      `${planFilePath(plan)} schedules no restore drill of data on the app's server (snapshots.drills.schedule).`,
    );
  }
  const id = "scheduled";
  const prefix = `${DRILL_DIR}/${id}/`;
  const files = renderDrill(
    plan,
    { id, parts },
    {
      image: `${o.repository}@${DRILL_RECIPE_DIGEST}`,
      env: o.env,
      ...(o.previewValues === true ? { previewValues: true } : {}),
    },
  );
  return [
    ...files.map((file) => ({
      ...file,
      path: `${DRILL_RECIPE_DIR}/${file.path.slice(prefix.length)}`,
    })),
    {
      path: `${DRILL_RECIPE_DIR}/${DRILL_RECIPE_SCHEDULE}`,
      content: `${every}\n`,
      kind: "runtime",
    },
  ];
}

/**
 * `snapshot_cmd_drill [<id>] [--only <service>] [--keep]` and `snapshot_cmd_drill --remove` of
 * the app's {@link SNAPSHOT_SCRIPT} on its server or this computer (none without a part there),
 * which runs in a subshell, so the drill's part restores replace the app's in it alone. Its
 * bounds, each in its own lines (research R29):
 * 1. only its own names: the project `<app>-drill`, the folder `.drill/<id>/`, the project's
 *    containers, networks and volumes and `/srv/data/<app>-drill/`, every one built here from the
 *    app's name and the word `drill`; the id is letters and digits (`snapshot_id`), and the part
 *    restores ({@link restoreFunctions}) go into the drill's project, reading the snapshot only;
 * 2. the latest complete snapshot, unless the id is given by hand (`opscrew restore --drill`
 *    passes the one the user approved);
 * 3. no outbound network and no published port, read back from Docker after the copy is made and
 *    again once it runs, before the data goes in; the copy's files come on stdin (`image <ref>`,
 *    `file <path> <base64>` lines) and hold no `.env`, which nothing here reads;
 * 4. everything of the project removed at the end, unless `--keep` (then `.drill/<id>/kept`), and
 *    at the start whatever a crashed run left (noted in the log as `cleaned=yes`); a kept copy
 *    stops another drill until `--remove`;
 * 6. the app folder's start lock, taken without waiting: held, the drill is skipped;
 * 7. free disk for the snapshot's size and the snapshot rule (1 GiB and 10%), and free memory for
 *    the app's and the restored services' limits, else skipped;
 * 8. at most {@link DRILL_LIMIT_SECONDS}: then its containers are killed and it is removed.
 * It needs its one-time approval ({@link DRILL_APPROVAL_FILE}), read and removed first. The
 * copy's generated values are filled in on the machine with the preview server's own fill, the app
 * starts after the parts are restored, its health is read (its health check until healthy or 5
 * minutes; without one, still running after 60 seconds), then each restored database's tables
 * are counted. One line per run goes to {@link DRILLS_LOG} and stdout ({@link DRILL_RECORD_PREFIX});
 * it exits 0 when healthy (or removed), 1 for a refusal (nothing changed), 2 when the drill failed
 * and 3 when it was skipped. Stop-only services start without waiting for their health checks
 * once restored: their data keeps production's logins.
 *
 * On a server, `snapshot_cmd_drill scheduled` is the scheduled drill, which the deploy user's
 * crontab runs each hour (research R28): approved by the host plan that installs it, so it reads
 * no one-time approval. It drills only in its slot, {@link DRILL_SLOT_AFTER_HOURS} hours after the
 * scheduled snapshot's ({@link DRILL_RECIPE_SCHEDULE}'s `weekly` or `daily`, else it refuses), and
 * only the latest complete scheduled snapshot (none: skipped), never keeping its copy (a kept one:
 * skipped). Its copy's files are {@link DRILL_RECIPE_DIR}'s, `values.env` with them, copied into
 * `.drill/<id>/` (env files owner-only), the app's image the snapshot's version in place of
 * {@link DRILL_RECIPE_DIGEST}. Every other bound, and its line (`scheduled`), are the drill's by
 * hand.
 */
export function drillCommand(plan: DeployPlan): string[] {
  const parts = snapshotParts(plan);
  if (parts.length === 0) return [];
  const name = `${plan.app.name}-drill`;
  const local = plan.target.provider === "localhost";
  const project: RestoreProject = {
    name,
    file: `${DIR}/compose.yaml`,
    log: `${DIR}/restore.log`,
  };
  const compose = `docker compose -p ${name} -f ${project.file}`;
  const log = project.log;
  const label = `"label=com.docker.compose.project=${name}"`;
  const data = `/srv/data/${name}`;
  const services = servicesOn(plan, APP_SERVER).map((service) => service.name);
  const serviceParts = parts.filter((part) => services.includes(part.name));
  const stopOnly = parts.filter((part) => !part.online).map((part) => part.name);
  const databases = parts.flatMap((part) => {
    const count = databaseCount(part);
    return count === undefined ? [] : [{ name: part.name, count }];
  });
  const memory = (part: string) =>
    servicesOn(plan, APP_SERVER).find((service) => service.name === part)?.memoryMb ?? 0;
  const folder = appFolder(plan);
  const fill = `${DRILL_DIR}/.fill.sed`;
  const secrets = `${DRILL_DIR}/.secrets.env`;
  const timedOut = `${DRILL_DIR}/.timed-out`;
  const recipe = DRILL_RECIPE_DIR;
  const zeros = "0\\{64\\}";
  // The scheduled drill: on a server only, in its slot, with no one-time approval.
  const scheduled = local
    ? []
    : [
        '  if [ "${1:-}" = scheduled ]; then',
        '    [ "$#" -eq 1 ] || { snapshot_usage; exit 1; }',
        "    shift",
        "    _drill_kind=scheduled",
        `    case "$(cat ${recipe}/${DRILL_RECIPE_SCHEDULE} 2> /dev/null || true)" in`,
        `      weekly) _drill_every=${drillScheduleHours("weekly")} ;;`,
        `      daily) _drill_every=${drillScheduleHours("daily")} ;;`,
        `      *) echo ${shellQuote(`There is no schedule of restore drills here (${recipe}/${DRILL_RECIPE_SCHEDULE}), so nothing was changed. opscrew snapshot drill schedule on, then opscrew provision, puts it here.`)} >&2; exit 1 ;;`,
        "    esac",
        `    if [ $(( $(date +%s) / 3600 % _drill_every )) -ne ${DRILL_SLOT_AFTER_HOURS} ]; then exit 0; fi`,
        "  fi",
      ];
  const approval = [
    `if [ ! -f ${DRILL_APPROVAL_FILE} ]; then`,
    `  echo ${shellQuote(`A drill needs its one-time approval here (${DRILL_APPROVAL_FILE}), which opscrew restore --drill writes once you approve it, so nothing was changed. Run opscrew restore --drill.`)} >&2`,
    "  exit 1",
    "fi",
    ...readApproval(DRILL_APPROVAL_FILE),
    'if [ "$approved" != "${_drill_id:--}" ] || [ "$choice" != "$_drill_action" ] || [ "$kept" != "${_drill_only:--}" ]; then',
    `  echo ${shellQuote(`The one-time approval here (${DRILL_APPROVAL_FILE}) is for another drill, so OpsCrew removed it and changed nothing. Run opscrew restore --drill again.`)} >&2`,
    "  exit 1",
    "fi",
    ...approvalExpiry([
      `echo ${shellQuote("The one-time approval of this drill expired before it started, so nothing was changed. Run opscrew restore --drill again.")} >&2`,
      "exit 1",
    ]),
  ];
  // 3. The copy's files: by hand from stdin into its own folder, env files owner-only.
  const fromInput = [
    "while IFS=' ' read -r _drill_what _drill_a _drill_b; do",
    '  case "$_drill_what" in',
    '    image) _drill_image="$_drill_a" ;;',
    "    file)",
    '      case "$_drill_a" in "" | /* | *..* | *[!A-Za-z0-9._/-]*) drill_finish failed files ;; esac',
    `      case "$_drill_a" in */*) mkdir -p ${DIR}/"\${_drill_a%/*}" || drill_finish failed files ;; esac`,
    '      _drill_mode=022; case "$_drill_a" in *.env) _drill_mode=077 ;; esac',
    `      (umask "$_drill_mode" && printf '%s' "$_drill_b" | base64 -d > ${DIR}/"$_drill_a") || drill_finish failed files ;;`,
    '    "") ;;',
    "    *) drill_finish failed files ;;",
    "  esac",
    "done",
  ];
  // Scheduled, from the recipe; the app's image is the snapshot's version.
  const fromRecipe = [
    `_drill_hex="$(sed -n 's/.*"version":"sha256:\\([0-9a-f]\\{64\\}\\)".*/\\1/p' ${SNAPSHOTS_DIR}/"$_drill_id"/about.json)"`,
    '[ -n "$_drill_hex" ] || drill_finish failed version',
    `cp -Rp ${recipe}/. ${DIR}/ || drill_finish failed files`,
    `rm -f ${DIR}/${DRILL_RECIPE_SCHEDULE}`,
    `chmod 700 ${DIR} || drill_finish failed files`,
    `for _drill_f in ${DIR}/*.env; do if [ -f "$_drill_f" ]; then chmod 600 "$_drill_f" || drill_finish failed files; fi; done`,
    `[ -f ${DIR}/compose.yaml ] || drill_finish failed files`,
    `_drill_image="$(sed -n 's|^ *image: *\\(ghcr\\.io/[a-z0-9._/-]*\\)@sha256:${zeros}$|\\1|p' ${DIR}/compose.yaml | head -n 1)"`,
    '[ -n "$_drill_image" ] || drill_finish failed files',
    '_drill_image="$_drill_image@sha256:$_drill_hex"',
    `{ sed "s|@sha256:${zeros}\\$|@sha256:$_drill_hex|" ${DIR}/compose.yaml > ${DIR}/compose.yaml.new && mv -f ${DIR}/compose.yaml.new ${DIR}/compose.yaml; } || drill_finish failed files`,
  ];
  const lines = [
    // The drill's own part restores, in the project <app>-drill: only in this subshell.
    ...restoreFunctions(plan, APP_SERVER, folder, project).map((line) => `  ${line}`),
    `  ${previewGenerate().split("\n").join("\n  ")}`,
    "  drill_record() {",
    '    _drill_line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $_drill_kind $1 id=${_drill_id:--} version=${_drill_version:--} start=$_drill_start parts=${_drill_parts:--} health=${_drill_health:--} tables=${_drill_tables:--} removal=${_drill_removal:--} cleaned=$_drill_cleaned reason=${2:--}"',
    `    (mkdir -p ${SNAPSHOTS_DIR} && printf '%s\\n' "$_drill_line" >> ${DRILLS_LOG}) || true`,
    `    echo "${DRILL_RECORD_PREFIX}$_drill_line"`,
    "  }",
    "  drill_skip() {",
    '    case "$1" in',
    ...Object.entries(SKIPS).map(
      ([reason, words]) =>
        `      ${reason}) echo ${shellQuote(`OpsCrew skipped this drill: ${words} Nothing was changed.`)} >&2 ;;`,
    ),
    "    esac",
    '    drill_record skipped "$1"',
    "    exit 3",
    "  }",
    // Everything of the project, by its label, its data folder and .drill/, in an order a later
    // removal repeats.
    "  drill_remove_all() {",
    `    _drill_ids="$(docker ps -aq --filter ${label} 2> /dev/null)" || return 1`,
    '    if [ -n "$_drill_ids" ]; then docker rm -f $_drill_ids > /dev/null 2>&1 || return 1; fi',
    `    _drill_ids="$(docker network ls -q --filter ${label} 2> /dev/null)" || return 1`,
    '    if [ -n "$_drill_ids" ]; then docker network rm $_drill_ids > /dev/null 2>&1 || return 1; fi',
    `    _drill_ids="$(docker volume ls -q --filter ${label} 2> /dev/null)" || return 1`,
    '    if [ -n "$_drill_ids" ]; then docker volume rm $_drill_ids > /dev/null 2>&1 || return 1; fi',
    ...(local
      ? []
      : [
          `    if [ -e ${data} ]; then docker run --rm --network none --user 0:0 --entrypoint rm -v /srv/data:/d ${IMAGES.busybox.ref} -rf /d/${name} > /dev/null 2>&1 || return 1; fi`,
        ]),
    `    rm -rf ${DRILL_DIR}`,
    "  }",
    "  drill_left() {",
    `    [ -e ${DRILL_DIR} ] && return 0`,
    `    [ -n "$(docker ps -aq --filter ${label} 2> /dev/null)" ] && return 0`,
    `    [ -n "$(docker network ls -q --filter ${label} 2> /dev/null)" ] && return 0`,
    `    [ -n "$(docker volume ls -q --filter ${label} 2> /dev/null)" ] && return 0`,
    ...(local ? [] : [`    [ -e ${data} ] && return 0`]),
    "    return 1",
    "  }",
    "  drill_kill() {",
    `    _drill_ids="$(docker ps -q --filter ${label} 2> /dev/null || true)"`,
    '    if [ -n "$_drill_ids" ]; then docker kill $_drill_ids > /dev/null 2>&1 || true; fi',
    "  }",
    // No outbound network and no published port: the project's network is internal and each of
    // its containers is on that network alone, with no port bound.
    "  drill_cut_off() {",
    `    [ "$(docker network inspect --format '{{.Internal}}' ${name}_internal 2> /dev/null)" = true ] || return 1`,
    `    for _drill_cc in $(docker ps -aq --filter ${label}); do`,
    `      [ "$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}{{range $k, $v := .HostConfig.PortBindings}}port {{end}}' "$_drill_cc")" = "${name}_internal " ] || return 1`,
    "    done",
    "  }",
    `  drill_timed_out() { [ -f ${timedOut} ]; }`,
    "  drill_memory() {",
    '    case "$1" in',
    ...serviceParts.map((part) => `      ${part.name}) echo ${memory(part.name)} ;;`),
    "      *) echo 0 ;;",
    "    esac",
    "  }",
    "  drill_count() {",
    '    case "$1" in',
    ...databases.map(
      (database) =>
        `      ${database.name}) ${compose} exec -T ${database.name} sh -c ${shellQuote(database.count)} < /dev/null 2>> ${log} ;;`,
    ),
    "      *) return 1 ;;",
    "    esac",
    "  }",
    // The end of every run past its checks: the copy kept or removed (at once when it was not cut
    // off or ran out of time), its line written, and the exit code.
    "  drill_finish() {",
    "    trap - HUP INT TERM",
    '    if [ -n "$_drill_watch" ]; then',
    '      kill "$_drill_watch" 2> /dev/null || true',
    '      wait "$_drill_watch" 2> /dev/null || true',
    '      _drill_watch=""',
    "    fi",
    '    _drill_result="$1"; _drill_reason="${2:--}"',
    '    if drill_timed_out && [ "$_drill_result" != healthy ]; then _drill_result=failed; _drill_reason=timeout; fi',
    '    if [ "$_drill_action" = keep ] && [ "$_drill_reason" != network ] && [ "$_drill_reason" != timeout ] && [ -d "$_drill_dir" ]; then',
    `      : > ${DIR}/kept`,
    "      _drill_removal=kept",
    "    elif drill_remove_all; then",
    "      _drill_removal=removed",
    "    else",
    "      _drill_removal=failed",
    "    fi",
    '    drill_record "$_drill_result" "$_drill_reason"',
    '    case "$_drill_result" in healthy) exit 0 ;; *) exit 2 ;; esac',
    "  }",
    ...scheduled,
    // The request: an id or the latest, --only, --keep, or --remove alone.
    '  while [ "$#" -gt 0 ]; do',
    '    case "$1" in',
    "      --keep | --remove)",
    '        [ "$_drill_action" = drill ] || { snapshot_usage; exit 1; }',
    '        _drill_action="${1#--}" ;;',
    "      --only)",
    '        [ "$#" -ge 2 ] && [ -z "$_drill_only" ] || { snapshot_usage; exit 1; }',
    '        snapshot_known "$2" || exit 1',
    '        _drill_only="$2"',
    "        shift ;;",
    "      -*) snapshot_usage; exit 1 ;;",
    "      *)",
    '        [ -z "$_drill_id" ] || { snapshot_usage; exit 1; }',
    '        snapshot_id "$1" || exit 1',
    '        _drill_id="$1" ;;',
    "    esac",
    "    shift",
    "  done",
    '  if [ "$_drill_action" = remove ] && [ -n "$_drill_id$_drill_only" ]; then snapshot_usage; exit 1; fi',
    ...(local
      ? approval.map((line) => `  ${line}`)
      : [
          '  if [ "$_drill_kind" = manual ]; then',
          ...approval.map((line) => `    ${line}`),
          "  fi",
        ]),
    // 6. No overlap with a deploy, a snapshot or a restore: their lock, never waited for.
    `  exec 7> ${START_LOCK}`,
    local
      ? "  if command -v flock > /dev/null 2>&1 && ! flock -n 7; then drill_skip locked; fi"
      : "  if ! flock -n 7; then drill_skip locked; fi",
    `  if snapshot_rotation_held ${shellQuote("OpsCrew skipped this drill: ")}; then drill_skip rotation; fi`,
    // 4. A kept copy stays until --remove; anything else of the project is a crashed run's.
    '  if [ "$_drill_action" = remove ]; then',
    "    if ! drill_left; then",
    `      echo ${shellQuote("There is no drill's copy here, so nothing was changed.")} >&2`,
    `      echo "drill-removal none"`,
    "      exit 0",
    "    fi",
    '    if drill_remove_all; then echo "drill-removal removed"; exit 0; fi',
    `    echo ${shellQuote(`OpsCrew could not remove every part of the drill's copy (the project ${name}, its volumes and folders). Run opscrew restore --drill --remove again.`)} >&2`,
    '    echo "drill-removal failed"',
    "    exit 2",
    "  fi",
    `  for _drill_k in ${DRILL_DIR}/*/kept; do`,
    '    if [ -f "$_drill_k" ]; then',
    '      if [ "$_drill_kind" = scheduled ]; then drill_skip kept; fi',
    '      _drill_k="${_drill_k%/kept}"',
    `      ${said(`A kept copy of the snapshot %s is still here, so OpsCrew started no other drill: nothing was changed. Remove it with opscrew restore --drill --remove, then run the drill again.`)} "\${_drill_k#${DRILL_DIR}/}" >&2`,
    `      echo "drill-kept \${_drill_k#${DRILL_DIR}/}"`,
    "      exit 1",
    "    fi",
    "  done",
    "  if drill_left; then",
    "    if ! drill_remove_all; then drill_record failed leftovers; exit 2; fi",
    "    _drill_cleaned=yes",
    "  fi",
    // 2. The snapshot: the id given, else the latest complete one (scheduled: the latest scheduled).
    '  if [ -z "$_drill_id" ]; then',
    `    _drill_id="$(for _drill_f in ${SNAPSHOTS_DIR}/*/about.json; do case "$_drill_f" in *.partial/* | *.taking/*) continue ;; esac; if [ "$_drill_kind" = scheduled ] && ! grep -qF '"kind":"scheduled"' "$_drill_f" 2> /dev/null; then continue; fi; _drill_f="\${_drill_f%/about.json}"; if [ -f "$_drill_f"/taken ]; then echo "$(cat "$_drill_f"/taken) \${_drill_f#${SNAPSHOTS_DIR}/}"; fi; done | sort -r | head -n 1 | cut -d ' ' -f 2)"`,
    "  fi",
    '  if [ "$_drill_kind" = scheduled ] && { [ -z "$_drill_id" ] || ! snapshot_complete "$_drill_id"; }; then drill_skip none; fi',
    '  if [ -z "$_drill_id" ] || ! snapshot_complete "$_drill_id"; then',
    `    ${said("There is no complete snapshot %s here to drill, so nothing was changed. opscrew snapshot list shows the snapshots.")} "$_drill_id" >&2`,
    "    exit 1",
    "  fi",
    '  _drill_list="$(snapshot_parts "$_drill_id")"',
    '  _drill_list="$(echo $_drill_list)"',
    '  if [ -n "$_drill_only" ]; then',
    '    case " $_drill_list " in',
    '      *" $_drill_only "*) _drill_list="$_drill_only" ;;',
    `      *) ${said("The snapshot %s holds no copy of %s, so nothing was changed.")} "$_drill_id" "$_drill_only" >&2; exit 1 ;;`,
    "    esac",
    "  fi",
    '  if [ -z "$_drill_list" ]; then',
    `    ${said("The snapshot %s holds no copy of any part, so nothing was changed.")} "$_drill_id" >&2`,
    "    exit 1",
    "  fi",
    `  _drill_version="$(sed -n 's/.*"version":"sha256:\\([0-9a-f]\\{12\\}\\).*/\\1/p' ${SNAPSHOTS_DIR}/"$_drill_id"/about.json)"`,
    // 7. Room for the copy.
    `  _drill_size="$(du -sk ${SNAPSHOTS_DIR}/"$_drill_id" | cut -f 1)"`,
    `  if ! df -Pk . | awk -v s="$_drill_size" 'NR == 2 { m = $2 / 10; if (m < 1048576) m = 1048576; exit !($4 >= s + m) }'; then drill_skip disk; fi`,
    `  _drill_need=${plan.app.memoryMb}`,
    '  for _drill_p in $_drill_list; do _drill_need=$((_drill_need + $(drill_memory "$_drill_p"))); done',
    '  _drill_free=""',
    `  if [ -r /proc/meminfo ]; then _drill_free="$(awk '/^MemAvailable:/ { a = $2 } /^MemFree:/ { f = $2 } END { if (a == "") a = f; if (a != "") print int(a / 1024) }' /proc/meminfo)"; fi`,
    '  if [ -n "$_drill_free" ] && [ "$_drill_free" -lt "$_drill_need" ]; then drill_skip memory; fi',
    // 3. The copy's files, into its own folder.
    `  _drill_dir=${DRILL_DIR}/"$_drill_id"`,
    "  trap 'drill_finish failed stopped' HUP INT TERM",
    `  mkdir -p ${DIR} || drill_finish failed files`,
    '  _drill_image=""',
    ...(local
      ? fromInput.map((line) => `  ${line}`)
      : [
          '  if [ "$_drill_kind" = scheduled ]; then',
          ...fromRecipe.map((line) => `    ${line}`),
          "  else",
          ...fromInput.map((line) => `    ${line}`),
          "  fi",
        ]),
    `  [ -f ${DIR}/compose.yaml ] || drill_finish failed files`,
    '  case "$_drill_image" in',
    `    ghcr.io/*@sha256:*${local ? ` | opscrew-local/${plan.app.name}:*` : ""}) ;;`,
    "    *) drill_finish failed files ;;",
    "  esac",
    '  case "${_drill_image#ghcr.io/}" in *[!a-z0-9._/@:-]*) drill_finish failed files ;; esac',
    // The copy's generated values: new ones, made here by the preview server's own fill.
    "  (",
    `    : > ${secrets}`,
    `    : > ${fill}`,
    previewSecretFill(DIR, secrets, fill, "    "),
    "  ) || drill_finish failed files",
    `  for _drill_f in $(grep -rlE '${PREVIEW_SECRET_PLACEHOLDER}' ${DIR} || true); do`,
    `    { sed -f ${fill} "$_drill_f" > "$_drill_f.new" && mv -f "$_drill_f.new" "$_drill_f"; } || drill_finish failed files`,
    "  done",
    `  rm -f ${secrets} ${fill}`,
    // 8. The time limit: its containers are killed, so the step that runs ends, and the copy goes.
    "  (",
    '    _drill_sleep=""',
    "    trap 'kill \"$_drill_sleep\" 2> /dev/null; exit 0' TERM",
    `    sleep ${DRILL_LIMIT_SECONDS} &`,
    "    _drill_sleep=$!",
    '    wait "$_drill_sleep" || exit 0',
    `    : > ${timedOut}`,
    "    drill_kill",
    "  ) < /dev/null > /dev/null 2>&1 &",
    "  _drill_watch=$!",
    // The snapshot's version of the app: a pinned image pulled with this machine's own login when
    // it is not here; a local build's never.
    `  if ! docker image inspect "$_drill_image" > /dev/null 2>&1; then`,
    '    case "$_drill_image" in',
    `      *@sha256:*) docker pull "$_drill_image" >> ${log} 2>&1 || drill_finish failed gone ;;`,
    "      *) drill_finish failed gone ;;",
    "    esac",
    "  fi",
    `  ${compose} create >> ${log} 2>&1 || drill_finish failed start`,
    "  drill_cut_off || drill_finish failed network",
    '  _drill_up=""',
    "  for _drill_p in $_drill_list; do",
    `    case " ${serviceParts.map((part) => part.name).join(" ")} " in *" $_drill_p "*) _drill_up="$_drill_up $_drill_p" ;; esac`,
    "  done",
    `  if [ -n "$_drill_up" ]; then ${compose} up -d --no-deps --wait $_drill_up >> ${log} 2>&1 || drill_finish failed start; fi`,
    "  drill_cut_off || drill_finish failed network",
    // The parts, each timed; a stop-only one starts again without waiting for its health check.
    `  SNAPSHOT_NO_WAIT=${shellQuote(stopOnly.join(" "))}`,
    "  for _drill_p in $_drill_list; do",
    '    _drill_t="$(date +%s)"',
    '    if ! snapshot_restore "$_drill_id" "$_drill_p"; then drill_finish not-restored "$_drill_p"; fi',
    `    _drill_bytes="$(wc -c < ${SNAPSHOTS_DIR}/"$_drill_id"/"$(part_file "$_drill_p")" | tr -d ' ')"`,
    '    _drill_parts="${_drill_parts:+$_drill_parts,}$_drill_p:$_drill_bytes:$(( $(date +%s) - _drill_t ))"',
    "  done",
    // The app on the restored data, and its health.
    '  _drill_t="$(date +%s)"',
    "  _drill_state=stopped",
    `  if ${compose} up -d --no-deps app >> ${log} 2>&1; then`,
    "    drill_cut_off || drill_finish failed network",
    `    _drill_c="$(${compose} ps -aq app 2>> ${log})" || _drill_c=""`,
    `    if [ "$(docker inspect --format '{{if .State.Health}}yes{{end}}' "$_drill_c" 2> /dev/null || true)" = yes ]; then`,
    "      while :; do",
    `        _drill_state="$(docker inspect --format '{{.State.Health.Status}}' "$_drill_c" 2> /dev/null || echo stopped)"`,
    '        if [ "$_drill_state" = healthy ]; then break; fi',
    `        if [ $(( $(date +%s) - _drill_t )) -ge ${HEALTH_SECONDS} ] || drill_timed_out; then break; fi`,
    `        sleep ${HEALTH_POLL_SECONDS}`,
    "      done",
    "    else",
    `      sleep ${RUNNING_SECONDS}`,
    `      _drill_state="$(docker inspect --format '{{.State.Status}}' "$_drill_c" 2> /dev/null || echo stopped)"`,
    '      if [ "$_drill_state" != running ]; then _drill_state=stopped; fi',
    "    fi",
    "  fi",
    '  _drill_health="$_drill_state:$(( $(date +%s) - _drill_t ))"',
    // Each restored database answers and holds a table.
    '  _drill_bad=""',
    "  for _drill_p in $_drill_list; do",
    `    case " ${databases.map((database) => database.name).join(" ")} " in *" $_drill_p "*) ;; *) continue ;; esac`,
    `    _drill_n="$(drill_count "$_drill_p" | tr -d ' \\r' | tail -n 1)"`,
    '    case "$_drill_n" in "" | *[!0-9]*) _drill_n=failed ;; esac',
    '    _drill_tables="${_drill_tables:+$_drill_tables,}$_drill_p:$_drill_n"',
    '    case "$_drill_n" in failed | 0) _drill_bad="${_drill_bad:-$_drill_p}" ;; esac',
    "  done",
    '  if [ -n "$_drill_bad" ]; then drill_finish not-restored "$_drill_bad"; fi',
    '  case "$_drill_state" in healthy | running) drill_finish healthy ;; esac',
    "  drill_finish unhealthy",
  ];
  return [
    "snapshot_cmd_drill() (",
    "  umask 077",
    '  _drill_id=""; _drill_only=""; _drill_action=drill; _drill_kind=manual; _drill_dir=""; _drill_every=""',
    '  _drill_watch=""; _drill_version=""; _drill_parts=""; _drill_health=""; _drill_tables=""',
    '  _drill_removal=""; _drill_cleaned=no; _drill_start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    ...lines,
    ")",
    // One line per entry: the deploy writes the script into its workflow one line at a time.
  ].flatMap((line) => line.split("\n"));
}

# OpsCrew — agent guidance for Claude Code

@AGENTS.md

The guide above (`AGENTS.md`) is shared by every AI agent working in this repository. What follows
is for Claude Code only: the core's implementation subagents and the core's lead.

## Working as an implementation subagent

- Read your task block in `specs/*/tasks.md`, the feature's `spec.md`, `plan.md` and any files
  listed under `Reads:`. Do not explore beyond what the task needs.
- Edit only files matching your task's `Owns:` globs. Never edit `tasks.md`, `specs/**`,
  `CLAUDE.md`, `AGENTS.md`, root config files, `pnpm-lock.yaml` or another package's files. If you need a new
  dependency or a contract change, stop and report it instead of making it.
- Test first, then implement. Run the task's exact `Verify:` command and include its output in your
  final report. Commit on your worktree branch with a Conventional Commit message ending with
  the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Detailed rules: `.claude/agents/task-implementer.md`; reviewer rules:
  `.claude/agents/task-reviewer.md`.

## Lead-only responsibilities

- Writing specs, plans, `tasks.md`, contracts, ADRs, this file and `AGENTS.md`; adding
  dependencies; merging branches one at a time; regenerating the lockfile; ticking tasks. An
  outside contributor leading a roadmap feature writes that feature's own specs (`AGENTS.md`);
  the lead reviews them with its pull request.
- Deciding implementation questions that agents report (extra scope, design choices, deviations):
  the lead is the architect and decides them, preferring the smaller solution. Bring to the founder
  only product-direction decisions (features, roadmap, pricing, anything outward-facing).
- Releases: follow `docs/releasing.md` every time; each release adds its section to `CHANGELOG.md`.
- Spec Kit v1.1.3 is pinned. Never re-run `specify init --here --force` (it can overwrite the
  constitution and templates). Spec Kit skills live in `.claude/skills/speckit-*`.
- Model routing: research with Sonnet subagents (official sources only, few fetches); coding with
  Opus subagents at the task's `Effort:` (`medium` simple, `high` default, `xhigh` complex,
  `max` rarely).

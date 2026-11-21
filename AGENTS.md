# OpsCrew: a guide for AI agents, and the people running them

OpsCrew is an open-source crew of AI agents that takes an app from a GitHub repo to a hardened
production deployment on the user's own cloud (Hetzner Cloud, DigitalOcean, Contabo, a server the
user already owns or a Portainer they already run, plus Cloudflare), with Terraform or OpenTofu,
and keeps it secure.

This file is for any AI coding agent working in this repository: Claude Code, Codex, Cursor or
another. Claude Code also reads `CLAUDE.md`, which imports this file. Read
`.specify/memory/constitution.md` before changing anything; it is the source of truth and
overrides this file.

## Where things are

- `specs/NNN-name/` — Spec Kit feature artefacts: `spec.md`, `plan.md`, `research.md`,
  `data-model.md`, `contracts/`, `quickstart.md`, `tasks.md`.
- `specs/roadmap.md` — the features after the current one, in order, with their scope and the
  founder's decisions. Project knowledge (roadmap, research, decisions) lives in the repo, never
  only in an agent's memory: a feature's research goes in its `research.md`, committed and pushed
  as soon as it is written.
- `packages/contracts` — shared TypeScript interfaces (`@opscrew/contracts`). One owner per
  contract; consumers import only from the package root.
- `packages/plan-schema` — zod schemas for `opscrew/architecture.json`, `opscrew/requirements.yaml`,
  `opscrew/plan.yaml`.
- `packages/core` — config/paths, redaction, audit log, approvals, safety policy, the agent runtime
  contract and its fake, orchestrator, cost ledger. `packages/runtime-claude` — the Claude Agent SDK
  adapter.
- `packages/detect` — deterministic repository analysis (frameworks, platform exports, env vars).
- `packages/secops` — `opscrew scan` engine, built-in rules, optional external scanners, policies.
- `packages/agents` — Analyst, Interviewer, Architect, Code-change, Infra, Domain, SecOps, Verifier.
  `src/cloudflare-move` moves an app's Cloudflare setup to another Cloudflare account (prepare,
  switch, finish, abort; ADR 0032). `src/home` serves an app from a computer at the user's home at
  its own address (the network read, the router's forwards, the address updater's token checks, the
  outside check; ADR 0033). The restore drills of every target with snapshots are in `src/snapshot`
  (ADR 0034). `src/shares` puts a second app on a server OpsCrew created for a first app: the
  reference to the first app's folder, the second app's deploy login, and the look the first app's
  commands take before they harm another app there (ADR 0035).
- `packages/iac-engine` — `tofu`/`terraform` abstraction (plan JSON, plan-hash-bound apply).
- `packages/iac-templates` — vendored HCL modules + runtime templates (compose, Caddyfile,
  cloud-init, GitHub workflow) and the renderer.
- `packages/providers/*` — one package per cloud server provider (`@opscrew/provider-hetzner`, `-digitalocean`,
  `-contabo`): its definition (the contract in ADR 0029), connector and server module. `packages/providers/registry`
  (`@opscrew/providers`) lists and validates them and is the one place code reads provider facts from
  (`CLOUD_PROVIDERS`, `cloudProvider(id)`); no other code branches on a cloud provider's id. Phases reach a
  provider's API through `vpsConnector` and `providerProfile` in `packages/agents/src/providers`.
- `packages/connectors/*` — `github`, `cloudflare`, the registrars and `docker` typed adapters (`@opscrew/connector-*`).
  `ssh-host` changes servers the user already owns, through host plans approved by hash (ADR 0011);
  `portainer` changes a Portainer the user already runs, through stack plans approved by hash (ADR 0012).
  `cpanel`, `plesk`, `directadmin` and `sftp` reach a shared hosting account the user already has,
  through hosting plans approved by hash (ADR 0030): on a panel OpsCrew's agent on the account pulls
  each release; on an SFTP-only host GitHub Actions pushes it over SFTP.
- `packages/cli` — the `opscrew` CLI (bundled for publishing).
- `packages/mcp-server` — deterministic MCP server (`opscrew mcp`).
- `plugin/` — the Claude Code and Codex plugin: one copy of the skills, Claude's manifest and `.mcp.json`,
  Codex's `.codex-plugin/plugin.json`; `.claude-plugin/` and `.agents/plugins/` hold their marketplaces.
- `examples/` — fixture apps for end-to-end tests. `docs/adr/` — architecture decision records.
- `docs/guide/` — user documentation in Markdown, one topic per page, written for users (later built
  with Astro Starlight and served at docs.opscrew.dev). Features document themselves here; the
  README stays a short pitch and quickstart that links to these pages.

## Commands

```bash
pnpm install                                   # install
pnpm check                                     # lint + typecheck + test (everything)
pnpm lint                                      # biome check .
pnpm format                                    # biome check --write .
pnpm turbo run typecheck test --filter=@opscrew/<pkg>   # one package
```

OpenTofu and Terraform binaries for local development live in `.tools/bin` (gitignored). Tests that
need them read `OPSCREW_TOFU_BIN` / `OPSCREW_TERRAFORM_BIN` or find them on `PATH`, and skip with a
clear message when absent: `PATH="$PWD/.tools/bin:$PATH" pnpm test`.
Tests that build real container images (they need Docker and the network) run only with
`OPSCREW_DOCKER_TESTS=1`.
Each `vitest run` writes temporary files into one folder under `OPSCREW_TEST_TMP` (or the system
temp folder) and removes it afterwards; point `OPSCREW_TEST_TMP` at a drive with space for the
engine tests, never at a folder inside a Git checkout.

## Code conventions

- TypeScript strict ESM, `moduleResolution: Bundler`, no file extensions in relative imports.
  Each package extends `tsconfig.base.json` and exports from `src/index.ts`.
- Packages are consumed from source (`"exports": { ".": "./src/index.ts" }`); only the CLI is built.
- Never import another package's internals (`@opscrew/x/src/...`); use its root export.
- Inject side effects (fs, fetch, child processes, clock, randomness, env) through parameters or
  small interfaces so tests never touch the network, real clouds or real models.
- Validate every external input and every model output with zod before use.
- Tests: Vitest, colocated as `src/**/*.test.ts`; fixtures under `test/fixtures/` or
  `src/**/__fixtures__/`. Never commit a secret-shaped literal (it trips GitHub push protection):
  generate values with `fakeSecret(kind)` or write `{{FAKE:<kind>}}` markers in fixture files and
  copy them with `materializeFixture()` (both from `@opscrew/core/testing`).
- Errors shown to users are plain English and say what to do next. Never print secrets; route
  user-visible text through the redactor from `@opscrew/core`.
- Formatting: Biome (2 spaces, double quotes, trailing commas, width 100). Run `pnpm format`.
- Brand: **OpsCrew** in prose, `opscrew` in machine-facing names, env vars `OPSCREW_*`.

## Safety rules (constitution I and IV, non-negotiable)

- No code path applies infrastructure changes without a plan, policy checks and an approval bound
  to the plan's SHA-256 hash. Destroys need `allowDestroy` + typed resource-name confirmation.
  Three standing approvals exist, each installed by a plan approved that way and enforced on the
  target: CI creates and removes previews only within a recipe on the preview server (ADR 0026);
  a home server's address updater keeps only its app's A/AAAA records at the server's own address
  (ADR 0033); a scheduled restore drill restores only the latest snapshot into a throwaway copy
  with no outside network and removes it (ADR 0034).
- Secrets never go into prompts, logs, audit entries, reports, generated files or fixtures.
- Mutations go through typed adapters or the IaC engine, never ad-hoc shell commands.

## Contributing with your own agent

Anyone can build a part of OpsCrew with their own AI agent. **The core's lead** is the AI agent
that leads OpsCrew's core for the founder, posting on GitHub as `softzer0`, the founder's account.
It reviews every pull request and merges it; nothing reaches `main` any other way.

### Before you start

1. **Read the guides:** the constitution, this file, and `specs/roadmap.md`.
2. **Pick something to build:** a feature the roadmap lists, or an open issue.
3. **Say what you're taking:** open an issue titled `[NNN] <feature>: starting`, so two people
   never build the same thing. `NNN` is the roadmap's feature number.
4. **Read the closest feature folder** in `specs/` as the template for your own. For a new server
   provider, that's `specs/026-contabo-provider-plugins/`, with `packages/providers/contabo/`.

### How to work

- **The feature folder:** write it as `specs/NNN-name/`, with `research.md` (official sources
  only), `spec.md`, `plan.md` and `tasks.md`. Use the roadmap's number, not the next free one. With
  Claude Code, the Spec Kit skills do this (`/speckit-specify`, `/speckit-plan`, `/speckit-tasks`);
  never run `specify init`.
- **Test first:** build each task test-first. Keep `pnpm check` green. Commit small, with
  Conventional Commit messages.
- **Your branch:** work on a branch or a fork.
  - Never push to `main`, never create a tag, never publish anything.
  - The release and its changelog are the core's lead's.
- **Your pull request:** open one into `main` for each piece that stands on its own (one provider,
  one task wave). The core's lead reviews it, whoever opened it.
  - **Its description:** what it does, which issues it resolves, how you tested it (the commands and
    their results), and every open question.
  - **The review:** answer each review comment in the same pull request, with a commit or a reply.
    The lead merges once nothing is open, so don't merge it yourself.
  - **After a merge:** rebase your next branch onto `main`.
- **Report honestly:** never mark something done that you didn't verify. A failing test or a
  skipped step is said plainly in the pull request.

### Talking to the core's lead: GitHub issues

You share the repository, not a chat, so use issues titled `[NNN] …`.
- **Answers:** the core's lead watches them and answers there.
- **Pull requests:** say which issues a pull request resolves.

**Open an issue first, then go on with other work, before you change a shared file:**
- `packages/contracts`;
- `packages/plan-schema`;
- `packages/providers/registry`;
- the agents' provider wiring;
- `AGENTS.md` or `CLAUDE.md`;
- root configuration or `pnpm-lock.yaml`.

A dependency to add goes through an issue too. If no one answers within a day and the change is
small and additive (a new optional field, a new enum value), make it and link the issue.

**To be woken by an answer** instead of checking by hand, run
`node scripts/watch-github.mjs --wake-on softzer0 --title "[NNN]"` as a background task. It ends
within seconds of the core lead's comment, issue, review or pull request activity, which wakes
your session; start it again after each wake.
- **Instant wakes** come through `gh webhook forward`. That needs the `admin:repo_hook` scope and
  admin rights on the repository.
- **Without them,** it checks every 5 minutes instead. Its header comment says the rest.

**Issues are public.** Never put a secret, a token, an account id, a server's address or anyone's
private details in one.

### What needs the founder

Open an issue with your recommendation, and work on other tasks meanwhile, before:
- **anything that costs money:** a cloud or registrar account, a server, a domain. Tests run
  against fakes, and a live test's steps go in the pull request for the founder to run.
- **anything outward-facing:** a name users see, a listing, a public post;
- **any change to approvals** or the safety model;
- **a change to the roadmap's order** or a feature's scope.

### When something isn't covered here

1. **Look it up:** the constitution, then this file, then how the code already does the same thing.
   Prefer the smallest change that meets the spec.
2. **Technical choices are yours.** Decide, write the choice and its reason in `plan.md` or
   `research.md`, and go on.
3. **Product choices are the founder's** (see above). Anything about the core's code or a shared
   file goes to the core's lead in an issue.
4. **When blocked,** write down what blocks you and why, in an issue or the pull request, and go on
   with what isn't blocked.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

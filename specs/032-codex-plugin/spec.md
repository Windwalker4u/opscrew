# Feature Specification: A Codex plugin

**Feature Branch**: `032-codex-plugin`

**Created**: 2026-11-21

**Status**: Draft

**Input**: The founder's decision of 2026-11-21: in the release after 0.2.11, OpsCrew ships as a
plugin for OpenAI's Codex, beside the Claude Code plugin, with the same skills, the same
deterministic MCP server and the same plans approved by their hash. Research:
[research.md](research.md).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install OpsCrew in Codex and deploy an app (Priority: P1)

A developer who works in OpenAI's Codex (its CLI or the ChatGPT desktop app) wants the same OpsCrew
that Claude Code users have. They add OpsCrew's marketplace, install the plugin, and in a new
session ask Codex to deploy their app. Codex follows OpsCrew's deploy skill step by step, calls
OpsCrew's tools, and every change to their infrastructure waits for their approval of the plan's
hash, as in Claude Code.

**Why this priority**: it is the feature. Without it, Codex users can only run the CLI by hand.

**Independent Test**: on a clean machine with Codex, add the marketplace, install the plugin, and in
a new session ask for OpsCrew's status of an example app. The skills are listed, the MCP server
starts, and the read-only tools answer.

**Acceptance Scenarios**:

1. **Given** Codex and Node.js on the user's machine, **When** they add OpsCrew's marketplace and
   install the plugin as the guide says, **Then** a new session lists OpsCrew's skills and its
   tools, with no other step.
2. **Given** the installed plugin, **When** the user asks Codex to deploy their app, **Then** Codex
   follows the deploy skill, and the first change that touches their infrastructure shows a plan
   and its hash and waits for their approval.
3. **Given** a release of OpsCrew, **When** the user upgrades the marketplace, **Then** the plugin
   runs that release's CLI.

---

### User Story 2 - OpsCrew's approvals hold in every Codex mode (Priority: P1)

Codex can run with few approvals, or none. OpsCrew's own approval, bound to the plan's hash, still
gates every infrastructure change. Codex's own prompts ask at the right calls: never for a tool
that only reads, always for one that changes or deletes.

**Why this priority**: the constitution's first principle. A plugin that let Codex's "never ask"
mode apply a plan would break OpsCrew's promise.

**Independent Test**: with Codex set to ask for nothing, an apply without the plan's approved hash
is refused by OpsCrew itself, with the same message as in Claude Code.

**Acceptance Scenarios**:

1. **Given** Codex set to ask for no approval, **When** Codex calls the apply tool without an
   approved hash, **Then** OpsCrew refuses it and nothing changes.
2. **Given** Codex's default mode, **When** Codex calls a tool that only reads (status, plan,
   analyze), **Then** Codex doesn't prompt the user; **When** it calls one that changes or deletes,
   **Then** Codex prompts.

---

### User Story 3 - The settings Codex needs are said, never guessed (Priority: P2)

OpsCrew runs OpenTofu, SSH and Git against the user's clouds, and an apply takes minutes. Codex's
defaults (no network in its sandbox, a 60-second limit per tool call) would cut that off. The guide
says exactly which settings to change and why, and OpsCrew says plainly what to change when a call
is cut off or has no network.

**Why this priority**: without it the first apply fails with an unclear error.

**Independent Test**: following only the guide page, a user sets Codex up so that an apply to a
local target runs to the end.

**Acceptance Scenarios**:

1. **Given** the guide page, **When** a user follows it, **Then** they set network access, a tool
   time limit long enough for an apply, and their provider tokens passed from their environment,
   never written into a configuration file.
2. **Given** Codex's default settings, **When** an OpsCrew tool can't reach the network, **Then**
   the error names the Codex setting to change.

---

### Edge Cases

- **Node.js is missing:** the guide says it's needed, and the plugin's start says so plainly.
- **An older plugin with a newer CLI, or the other way around:** each release pins the plugin to
  that release's CLI, as the Claude Code plugin is pinned.
- **The IDE extension:** OpenAI's docs say plugins don't load there (research R1); the guide says
  so and gives the MCP-only setup for it, if it reads the same MCP configuration.
- **Codex cloud:** its agent phase is offline and removes secrets (research R4). The guide says
  OpsCrew doesn't run there.
- **Both plugins installed** (Claude Code and Codex on one machine): each works on its own; they
  share the project's `opscrew/` files and the user's OpsCrew home.
- **A skill Codex can't read** because of Claude-only frontmatter: the skills stay one source, and
  a check proves both tools read them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-3201**: OpsCrew MUST ship a Codex plugin from its repository: a manifest, the skills, the
  MCP server's configuration, and a marketplace entry that Codex's `marketplace add` reads.
- **FR-3202**: The Codex plugin and the Claude Code plugin MUST use one copy of each skill. Any
  difference Codex needs is generated from it, and a check fails when the two disagree.
- **FR-3203**: The plugin MUST start OpsCrew's deterministic MCP server, pinned to the release's
  CLI, with no model call. Codex installs no npm package for a plugin, so the first start downloads
  that release with npx (research R7).
- **FR-3204**: Every MCP tool MUST declare whether it only reads, changes, or deletes, so that
  Codex's approval modes prompt only at changes. A check fails when a tool lacks the declaration.
- **FR-3205**: No Codex setting MAY bypass OpsCrew's approval bound to the plan's hash: the MCP
  server and the CLI keep enforcing it whatever Codex's mode.
- **FR-3206**: A guide page MUST say, in plain English:
  - how to install, upgrade and remove the plugin;
  - the settings Codex needs (network access in its sandbox, a tool time limit for an apply,
    tokens passed from the user's environment);
  - where it doesn't work (the IDE extension, Codex cloud) and why.
- **FR-3207**: Tokens MUST never be written into a Codex configuration file by OpsCrew or its
  guide; they reach the MCP server from the user's environment.
- **FR-3208**: When a tool call fails because OpsCrew can't reach the network from Codex, its message
  MUST name Codex's setting to change. A call Codex cuts off at its time limit can't be reported by
  OpsCrew, so the plugin sets a limit long enough for an apply.
- **FR-3209**: The release handbook MUST bump the Codex plugin with the Claude Code plugin, at each
  release, and its check MUST cover both.
- **FR-3210**: The plugin MUST NOT be submitted to OpenAI's public plugin directory in this feature
  (it takes no local MCP server); it installs from OpsCrew's repository.

### Key Entities

- **Codex plugin**: its manifest, the shared skills, the MCP server's configuration, and its
  version, pinned to an OpsCrew release.
- **Marketplace entry**: what Codex reads from OpsCrew's repository to find and install the plugin.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-3201**: On a clean machine with Codex and Node.js, a user installs the plugin and sees
  OpsCrew's skills and tools in under 5 minutes, following only the guide.
- **SC-3202**: In every Codex approval mode, no infrastructure change happens without the plan's
  approved hash (0 of every test's attempts).
- **SC-3203**: A deploy to a local target runs to the end from a Codex session set up as the guide
  says.
- **SC-3204**: Each release ships both plugins at the same version, and the release check fails
  when they differ.

## Assumptions

- Codex's plugin format, skills and MCP configuration are as OpenAI's docs of 2026-11-21 describe
  (research R1–R3). The open questions there are answered first in the plan's research.
- The plugin installs from OpsCrew's repository, as the Claude Code plugin does. A listing in
  OpenAI's directory is left for later and would be the founder's decision.
- Users have Node.js 22 or newer, as the Claude Code plugin requires.
- The live pass runs in the Codex CLI with an OpenAI account and a local target only: no cloud
  account, no spending.

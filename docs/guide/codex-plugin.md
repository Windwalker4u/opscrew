# OpsCrew in Codex: the plugin

The OpsCrew plugin lets you run OpsCrew from OpenAI's [Codex](https://developers.openai.com/codex), in the Codex CLI
or the ChatGPT desktop app: the security scan, the interview, the design with real prices, the code
changes and the deploy. Codex does the reasoning and talks to you. OpsCrew's MCP server supplies
safe, deterministic tools and never calls a model itself, so the plugin needs no extra API key.

The plugin has the same skills and the same tools as [the Claude Code plugin](claude-code-plugin.md).
Every change still waits for your approval of its exact plan, in a dialog that only you can answer.

## Install

```bash
codex plugin marketplace add opscrew-hub/opscrew
codex plugin add opscrew@opscrew
```

The first command adds OpsCrew's plugin marketplace, the `opscrew-hub/opscrew` repository on [GitHub](https://github.com/).
The second installs the `opscrew` plugin from it. You can also install it inside Codex: type
`/plugins` and choose OpsCrew. Then start a new Codex session.

You need [Node.js](https://nodejs.org/) 22 or newer and npm on your `PATH`. Codex installs no npm
package for a plugin, so the plugin starts OpsCrew's MCP server with npx, at the release the plugin
pins:

```bash
npx -y opscrew@<version> mcp
```

The first start downloads OpsCrew (about 37 MB) and takes longer than the next ones. Without
Node.js, Codex can't start the server and shows none of OpsCrew's tools: install Node.js, then start
a new session.

## Upgrade and remove

- **Upgrade:** `codex plugin marketplace upgrade opscrew`, then start a new session. Each release of
  the plugin runs that release's OpsCrew.
- **Remove:** `codex plugin remove opscrew@opscrew`, or uninstall it from `/plugins`. To drop
  OpsCrew's marketplace too: `codex plugin marketplace remove opscrew`.

## The skills

| Skill | What it does |
|---|---|
| `opscrew-deploy` | The whole flow: scan, analyze, interview, design, prepare the code, provision and verify |
| `opscrew-scan` | The free security scan, with guided fixes |
| `opscrew-adapt` | Prepares the app's code for its deployment |
| `opscrew-troubleshoot` | Finds out why the app is failing or slow, and what it uses: its status, figures, alerts and logs, and [advice](advise.md) on what to change, read-only |
| `opscrew-snapshots` | Which snapshots of the app's data exist, read-only; taking, restoring and deleting them stay in your terminal |
| `opscrew-rotate` | Which credentials OpsCrew made and how old each is, read-only; rotating one stays in your terminal |

Pick one with `/skills`, or just ask, for example "deploy my app" or "is my app secure?": Codex
picks the skill that fits.

## The settings Codex needs

### Network access

OpsCrew's tools need the network: they reach your clouds, GitHub and your servers. You don't
need to change Codex's sandbox for them. Codex starts OpsCrew's server as a program of its own,
outside its sandbox. So the tools, and the OpenTofu, SSH and Git commands they run, reach the
network whatever `sandbox_mode` says.

The sandbox limits only the commands Codex runs itself in its shell. In its default
`workspace-write` mode those have no network. Run OpsCrew's terminal steps, such as
`npx opscrew provision` (where you type your app's secrets), in your own terminal, not through
Codex. If you want Codex to run a command that needs the network itself, `git push` for example,
turn the network on for its sandbox in `~/.codex/config.toml`:

```toml
[sandbox_workspace_write]
network_access = true
```

### Time limits

The plugin sets them, so you don't have to:
- **Starting the server:** 120 seconds. Codex's default of 10 seconds is shorter than the first
  download.
- **Each tool call:** 30 minutes. Codex's default of 60 seconds is much shorter than an apply or a
  deploy takes.

If a call ever runs longer, Codex stops waiting for it: run the same step in your terminal
(`npx opscrew provision`, for example).

### Your tokens

OpsCrew reads your tokens (`HCLOUD_TOKEN`, `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN` and the others the
guide's pages name) from the environment Codex starts in.

- **Where to set them:** in the shell you start the Codex CLI from. On Windows, the desktop app
  reads your user environment variables: set the tokens there, in Windows' settings, then restart
  the app.
- **How they reach OpsCrew:** Codex passes OpsCrew's server only a short list of its own variables
  and the names the plugin lists (its `env_vars`, names only, never a value). The list holds every
  token OpsCrew reads; it's the same as the `config.toml` entry in
  [OpsCrew in other AI apps](mcp-clients.md#adding-the-entry-by-hand).
- **Never write a token** into Codex's `config.toml`, and never paste one into the chat.

## How approvals work

- **OpsCrew's approval:**
  - A tool that changes something shows its plan, its hash and what it costs in a dialog (MCP
    elicitation). Only you can answer it; Codex can't approve it for you.
  - Destroying plans need you to type the resource's name in the dialog.
  - Your app's secrets never pass through the chat: you enter them in your own terminal
    (`npx opscrew provision`).
  - An SSH host key or a Portainer certificate is confirmed by you in a dialog the first time.
- **Codex's own prompt:**
  - In Codex's default mode, Codex doesn't ask before OpsCrew's tools that only read, such as
    `opscrew_status`, `opscrew_detect` and `opscrew_design_options`.
  - It asks before a tool that deletes something or reaches outside your computer, such as
    `opscrew_plan` and `opscrew_apply`.
  - A tool that only changes OpsCrew's files in your repository, such as `opscrew_app_add`, runs
    without Codex's prompt, as Codex's own file edits do.
- **When Codex asks for nothing:** with Codex set to ask for no approval, Codex either declines
  OpsCrew's dialog or shows it to you; it never answers it for you. When it declines, nothing
  changes: the tool stops, and you run the step in your terminal. No Codex setting skips OpsCrew's
  approval.
- **Removing an app** (`npx opscrew destroy`) stays in your terminal.

## The IDE extension

Codex's IDE extension loads no plugin, but it reads the same `~/.codex/config.toml` as the CLI.
Add OpsCrew's server there:

```bash
npx opscrew mcp install --client codex
```

See [OpsCrew in other AI apps](mcp-clients.md). The extension then has OpsCrew's tools, with the same
time limits and tokens, but not the skills: the server tells Codex the order of the tools itself. In
the CLI and the desktop app, the plugin is enough.

## Codex cloud

OpsCrew doesn't run in Codex cloud. Its agent works offline by default and removes secrets before it
starts, and OpsCrew needs both your tokens and the network to reach your clouds. OpenAI doesn't say
whether Codex cloud loads plugins at all. Run OpsCrew in the Codex CLI or the desktop app on your
computer.

## Data and privacy

The MCP server runs on your computer, sends nothing to OpsCrew and has no telemetry. It talks only
to the services your steps need, with your own tokens: see
[Data and the services it talks to](https://github.com/opscrew-hub/opscrew/tree/main/plugin#data-and-the-services-it-talks-to)
in the plugin's README, and OpsCrew's [privacy policy](https://opscrew.dev/privacy/).

## From the chat or from the terminal

Both work on the same files in your repository, so you can switch at any point: answer the
interview in a terminal with `npx opscrew interview` (it keeps addresses you type out of the chat),
then continue in Codex, or the other way round. With both plugins installed, Codex and Claude Code
share them too.

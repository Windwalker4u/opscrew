# Quickstart: check the Codex plugin

## Offline (every change)

```bash
pnpm turbo run typecheck --filter=opscrew --filter=@opscrew/mcp-server
npx vitest run --root packages/cli src/mcp-clients
npx vitest run --root packages/mcp-server
node plugin/validate.mjs
pnpm lint
```

**Expected:**
- The manifest's server equals `codexEntry` of the pinned release.
- Every MCP tool states its annotations.
- Both plugins have the same version.

## Live (once, with an OpenAI account; waits for the founder)

1. Install Codex's CLI and sign in.
2. Add OpsCrew's marketplace from this repository's branch or `main`:
   `codex plugin marketplace add opscrew-hub/opscrew` (or `--ref <branch>`).
3. Install the plugin with `/plugins`, then start a new session.
4. **Expect the skills and tools:** `/skills` lists OpsCrew's skills; the MCP server starts (npx
   downloads the pinned release on the first start).
5. **Expect no prompt for a read:** in an example app from `examples/`, ask for OpsCrew's status,
   then a design. Read-only tools run with no prompt.
6. **Expect two approvals:** ask for a deploy to the local target. Codex prompts at the first
   change, and OpsCrew shows the plan and its hash and waits for that approval.
7. **Expect OpsCrew's refusal:** with `default_tools_approval_mode = "approve"` (Codex asks for
   nothing), call the apply tool without the hash. OpsCrew refuses it.
8. Record the run in `docs/e2e-coverage.md`: the Codex version, the steps, the outcome.

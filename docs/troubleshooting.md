# Troubleshooting

- Pi package missing: run `scripts/status.sh`, confirm Pi is exactly 0.87.1, then rerun `scripts/bootstrap.sh`. Do not relax version or package pins.
- Semantic navigation unavailable: run `/lsp-status`, then `npm run smoke:lsp`. The lockfile-backed runtime is `runtime/lsp/`; never bypass a missing server by running it outside the sandbox. Rust/Go/Java/Lua/Ruby intentionally report `PARTIAL` until a reviewed server is pinned.
- Browser unavailable: run `agent-browser doctor`; do not point it at a personal profile as a shortcut.
- Search is too broad: start with FFF, AST, or LSP and add a directory/symbol constraint before reading files.
- Large output hid a needed line: rerun the failing command with a narrower filter. Failed commands are not compacted.
- Child agent will not launch: use `subagent` list/capabilities and doctor actions, then verify the role's explicit extensions and allowed model.
- Worktree collision: inspect `git worktree list`; never delete a path until its branch and uncommitted state are understood.
- Sandboxed command needs network: do not weaken the autonomous sandbox. Run dependency acquisition as a separately authorized manual step, then rerun the offline check.
- Need to stop the setup: run `scripts/disable.sh`; it preserves Pi, authentication, caches, backups, and later user setting changes.
- Upgrade problem: restore the backed-up `settings.json`, restart Pi, and re-audit releases/peer ranges before retrying.

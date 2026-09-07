# Troubleshooting

- Pi package missing: run `scripts/status.sh`, confirm Pi is exactly 0.85.1, then rerun `scripts/bootstrap.sh`. Do not relax version or package pins.
- LSP unavailable: run `/lsp`, confirm `~/.local/bin` is on PATH, and inspect the bounded adapter status. First use may install a catalog-pinned server.
- Browser unavailable: run `agent-browser doctor`; do not point it at a personal profile as a shortcut.
- Search is too broad: start with FFF, AST, or LSP and add a directory/symbol constraint before reading files.
- Large output hid a needed line: rerun the failing command with a narrower filter. Failed commands are not compacted.
- Child agent will not launch: use `subagent` list/capabilities and doctor actions, then verify the role's explicit extensions and allowed model.
- Worktree collision: inspect `git worktree list`; never delete a path until its branch and uncommitted state are understood.
- Sandbox command needs network: rerun with `--network` only if the task requires it. Keep Pi credentials outside the sandbox.
- Need to stop the setup: run `scripts/disable.sh`; it preserves Pi, authentication, caches, backups, and later user setting changes.
- Upgrade problem: restore the backed-up `settings.json`, restart Pi, and re-audit releases/peer ranges before retrying.

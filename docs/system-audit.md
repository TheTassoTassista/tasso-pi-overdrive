# System audit — 2026-09-07

## Platform and Pi

- CachyOS/Arch-compatible Linux, kernel 7.2.2, x86_64; login shell is Fish.
- Official Pi Coding Agent 0.85.1 at `~/.local/share/pi-node/node-v22.23.2-linux-x64/bin/pi`, installed with its dedicated Node 22.23.2/npm 10.9.8 runtime.
- Existing provider: `openai-codex`. Authentication values were never displayed and are unchanged.
- Available routed models: GPT-5.6 Luna, Terra, Sol, and GPT-6 Astra. Other catalog entries remain untouched.
- Before this work there were no selected Pi packages, extensions, skills, prompts, or project context files in the audited workspace. Native compaction was enabled.

## Development tools

Present and verified: Git 2.55.0, ripgrep 15.2.0, fd 10.4.2, jq 1.8.2, curl 8.21.0, wget 1.25.0, unzip, Python 3.14.7, GCC 16.2.1, Clang/clangd 22.1.8, Rust/Cargo 1.98.0, Node/npm, pnpm, and Bubblewrap 0.12.0. The home filesystem had 17 GB free after installation.

Installed user-locally by this setup: ast-grep 0.45.3, TypeScript 6.0.3, Pyright 1.1.410, agent-browser 0.36.0, and isolated Chrome for Testing 152.0.7977.82. The active Pi semantic tools use the pinned TypeScript LanguageService directly; the failed `pi-lsp-adapter` integration and its config were removed. Other language-server binaries already on the machine are not claimed as Pi-integrated.

Not present: Docker, Podman, Bun, GitHub CLI, `tree`, or `zip`. GitHub CLI authentication therefore could not be checked. The optional Arch install was attempted non-interactively and stopped at the host's sudo password prompt; no password was requested or captured. Zen is installed but is Firefox-based, so the browser integration uses its own Chromium profile.

Git identity and environment-variable names were audited without recording values in this package. No credential values, `.env` contents, SSH material, or browser profile data were inspected.

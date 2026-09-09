# Semantic navigation

Pi exposes one opt-in `semantic_nav` tool. This avoids one schema per operation or language while keeping the responsibilities distinct:

- FFF, `rg`, and `fd`: file and text discovery.
- ast-grep: structural syntax search and reviewed rewrite.
- `semantic_nav`: diagnostics, definition, references, hover, document/workspace symbols, and preview-only rename.

Positions are one-based. `rename_preview` returns edits but the client rejects every server-originated `workspace/applyEdit` request, and the project is mounted read-only. Apply an accepted rename through the normal editor and verification workflow.

## Runtime and isolation

Servers start only on their first tool call and are keyed by canonical project root plus language. At most three processes are retained; the oldest idle process is shut down before another starts. Instances are reused within a project, never across project roots, shut down after five idle minutes, and closed at Pi session shutdown.

Every admitted server runs through `scripts/sandbox-run.sh --workspace-read-only`: Bubblewrap clears the inherited environment, unshares the network, hides the host home and system configuration, mounts the project read-only, masks detected credential files, and mounts only the pinned runtime read-only. Missing Bubblewrap fails closed.

## Registry

| Files | Backend | Status |
|---|---|---|
| TypeScript/JavaScript | `@vtsls/language-server@0.3.0`, `typescript@6.0.3` | Available. VTSLS provides LSP operations; the constrained TypeScript LanguageService follows import aliases for exact source definitions. |
| Python | `pyright@1.1.410` | Available |
| C/C++ | system `clangd@22.1.8` | Available and version-checked on this host |
| HTML/CSS/JSON | `vscode-langservers-extracted@4.10.0` | Available |
| YAML | `yaml-language-server@1.23.0` | Available |
| Bash | `bash-language-server@5.6.0` | Available |
| Rust | `rust-analyzer` | Detected; `PARTIAL` because no reviewed pinned server is installed |
| Go | `gopls` | Detected; `PARTIAL` because no Go toolchain/server is installed |
| Java | `jdtls` | Detected; `PARTIAL` because no Java runtime/server is installed |
| Lua | `lua-language-server` | Detected; `PARTIAL` until pinned |
| Ruby | `ruby-lsp` | Detected; `PARTIAL` until pinned |

The tool never silently falls back to an unpinned executable found on `PATH`. `/lsp-status` reports availability without starting a server.

## Evidence

`npm run smoke:lsp` calls the registered Pi tool through a deterministic zero-token provider and proves real TypeScript, Python, and C++ results plus visible Rust absence. `tests/lsp-manager.test.mjs` additionally covers all three required operations, lazy startup, reuse, project switching, stale-result isolation, hover, symbols, rename non-mutation, server crash, missing Rust/Go servers, and explicit cleanup.

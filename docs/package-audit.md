# Package audit

All selected npm sources are exact pins. Their manifests, engines, Pi peer ranges, lifecycle scripts, dependency trees, critical configuration/security paths, and unpacked tarballs were inspected before installation. Installation reported zero npm audit vulnerabilities for every selected package.

| Package | Purpose | Decision |
|---|---|---|
| `@ff-labs/pi-fff@0.10.6` | Compact fuzzy repository discovery | Accepted; local tools-only configuration, no filesystem-root/home scan, no symlink following |
| `@juvio15/pi-ast-grep@0.4.2` | Structural search and guarded rewrite | Accepted with ast-grep CLI 0.45.3; Pi and Node requirements satisfied |
| `pi-subagents@0.66.0` | Fresh-context agents, model routing, limits, worktrees | Accepted; explicit tools, depth one, concurrency three, schedules disabled |
| `@juicesharp/rpiv-web-tools@2.9.0` | Provider contracts and compatibility web tools | Accepted; its source/precedence/API contracts were audited, while the local routed client mirrors its Brave/Perplexity endpoints behind DNS pinning and bounded JSON to close dynamic-import and network-safety gaps without another package |
| `pi-agent-browser-native@0.6.6` | DOM/console/browser verification | Accepted with upstream agent-browser 0.36.0 and isolated Chromium |
| `@juicesharp/rpiv-ask-user-question@2.9.0` | Structured material clarifications | Accepted for the supervisor and read-only Planner |
| `pi-observability@1.3.2` | One unobtrusive token/context/tool dashboard | Accepted with the minimal preset |
| `pi-mcp-adapter@2.32.1` at `8243eba3421e301c88c047444f34ab7d5d57163e` | One lazy MCP proxy | Accepted from immutable upstream HTTPS commit; Pi 0.85 peer fix audited, Context7-only allowlist, direct tools off, Hono 4.13.5 security override, isolated locked runtime |
| `tasso-pi-overdrive` | Personal workflow, safety, TypeScript semantic navigation, notebook, handoff, verification, skills/prompts | Git-tracked stable local package; source remains editable and third-party code is not copied into it |

## Intentionally rejected

- `pi-lsp-adapter@0.1.3`: runtime diagnostics were empty and definition/reference support was unreliable. It was removed and replaced by the local pinned TypeScript LanguageService 6.0.3 tools.
- `pi-rtk-optimizer@0.9.0`: declared Pi peer ranges stop before 0.85.x and it adds a lifecycle script. A small local output transformer is measured and easier to audit.
- `context-mode@1.0.169`: large overlapping MCP/context surface and restrictive license without a measured advantage here.
- `pi-agenticoding@0.5.0`: overlaps notebook/subagents and recommends disabling native compaction.
- `pi-router` / `pi-model-router`: unnecessary proxy/model switching with one provider; explicit phase/agent routing preserves cache stability.
- Extra worktree packages: overlap the selected subagent package and the deterministic native helper.
- `pi-bench`: would bulk-call paid models. The local suite is dry-run by default and only small smoke calls are allowed.
- `pi-trace-extension@0.1.16`: records raw prompts, arguments, and outputs. The local trace records metadata only.
- Additional stats and broad extension bundles: duplicate the selected dashboard or inflate the tool/schema surface.
- Automatic memory plugins: no demonstrated gain over repository docs, concise project rules, task notebook, native session/compaction, and handoff.

Re-audit exact releases rather than relaxing these decisions after a Pi upgrade.

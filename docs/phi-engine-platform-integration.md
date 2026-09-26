# Real engine platform integration — first production checkpoint

Status: **PARTIAL; Windows autonomous coding remains BLOCKED**. This is production boundary wiring, not proof that native Windows coding works. No new provider/model call is needed for this stage.

## Actual path audited

| Production path | Existing implementation | Current Windows treatment / missing integration |
|---|---|---|
| `phi` -> official Pi | `bin/phi.mjs`, `lib/phi-runtime.mjs`, `platform/shared/process.mjs` | Launcher still blocks unverified autonomy. Official Pi/auth are not changed. Trusted Job owner is not a replacement sandbox. |
| Director -> delegated workflow | `extensions/director-mode.ts`, `lib/director-mode.mjs`, `extensions/secure-workflow.ts` | Workflow now checks the shared production backend before reading request/routing, creating evidence/worktree or emitting delegation. No direct mutation fallback. |
| Scout/Planner/Worker/Tester/reviewers | secure-workflow request/start/response/cancel events, `lib/workflow-state.mjs`, `lib/subagent-delegation-request.mjs` | Shared orchestrator, routing/caps/Council/Judge untouched. Windows workflow entry denied; no claim of native role execution through real Pi. |
| Managed Git worktree/runtime | `lib/runtime-isolation.mjs`, `lib/process-identity.mjs` | Git runs as trusted controller; process generation still relies on Linux `/proc`. Native process/temp/receipt ownership is not yet integrated here. |
| `safe_exec` | `extensions/safe-exec.ts` | Existing argument/worktree rules retained. Launcher now selected by `platform/shared/coding-execution.mjs`; Windows denies before path inspection or execution. Linux vector/runtime/cwd/timeout/signal semantics unchanged. |
| Source removal | safe-exec extension, `lib/safety.mjs` | Both tool and underlying removal function deny Windows before filesystem mutation. Native handle removal not wired to this operation yet. |
| ResourceFS / reads | `lib/resource-fs.mjs`, guardrails/tool policies | Sensitive traversal uses Linux descriptor-relative `/proc/self/fd`; generic Windows handle adapter still absent. Entry guards do not constitute universal filesystem brokerage. |
| Edit Engine | `extensions/edit-engine.ts`, `lib/edit-engine.mjs`, `lib/ast-edit-engine.mjs` | Constructor rejects Windows before reading options/creating receipt directories. Existing Linux transaction untouched; native anchored in-place primitive is NOT a transactional substitute. |
| LSP / LSP-on-write | `lib/lsp-manager.mjs`, `lib/lsp-write-guard.mjs`, `extensions/lsp.ts` | Real LSP entry checks backend before source IO; spawning uses shared dispatch. Windows piped transport/assets/URI mapping and native semantic E2E remain absent. Existing Linux diagnostics/definition/references/overlay exercised by full gate. |
| Debug / eval | `lib/dap-engine.mjs`, `lib/persistent-eval.mjs` | Constructors reject Windows before caller spawn overrides; default launch uses shared dispatch. Reviewed Linux runtime/process-group policies retained, not portable native proof. |
| Verification | `extensions/verification-gate.ts`, `scripts/verify-project.mjs`, workflow verification callback | Tool and direct CLI deny Windows before project/allocation/check discovery. Linux checks use shared dispatch. Existing explicitly trusted read-only `git diff --check` stays host-side; never mislabel it sandboxed. |
| Receipts / cleanup / recovery | workflow evidence/receipt/state/runtime modules; fixed native `ScopeRecovery.cs` | Linux path unchanged. Native fixed-scope recovery remains proven but not the workflow's transactional/session journal. Full native production cleanup remains unverified. |

## Dispatch contract

`platform/shared/coding-execution.mjs` uses the **actual host platform**, not a caller-supplied platform field, fake environment flag or model-selected backend. Its fixed operation set covers workflow, verification, safe-exec, LSP, debug, eval, transactional editing and safe removal. Windows fails with `PHI_CODING_BACKEND_UNAVAILABLE`; no route to the full-trust Job runner or fixed confinement probe exists. No input can flip certification to VERIFIED.

Linux retains the existing `scripts/sandbox-run.sh` invocation, original arguments and explicit shell-free process spawn. Backend metadata describes the selected implementation, not a fabricated live sandbox attestation. Existing controller-only Linux LSP failure-runner injection remains behind platform admission and is not added to any tool schema. Windows rejects it before use. Caller objects/paths/spawn overrides are not inspected before native backend admission in the newly gated entry points.

Installed-Pi TypeScript validation now copies `platform` along with the other source roots into its disposable project. Previously the new production import correctly failed module resolution there; this is fixed by including actual source, not a permissive fake declaration or new dependency.

## Evidence boundary and exact continuation

Tests: `tests/phi-coding-execution.test.mjs`, the real supported Linux gate and native Windows CI. Static wiring/vector checks are unit evidence only. Actual Windows constructor/LSP/direct-verification denial tests are required on native Windows, not counted from Linux skips. The direct CLI test also supplies misleading enable/platform environment variables; it must still fail before running any check.

Next implement the native trusted confined launch/stdio broker and operation-specific profiles **behind this dispatch**. Resolve pinned Node/libuv non-LOCAL pipe incompatibility without broadening LPAC permissions. Add real pinned-tool/LSP transport and cleanup evidence, then transactional handle-backed writes and their recovery. Do not simply replace the Linux runner with the existing bare Job helper or flip a readiness flag. Full production coding/denial/crash E2Es, full Doctor, backup/restore and complete reconstruction remain required before Windows autonomy changes.

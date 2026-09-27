# C — production Windows JSON LSP (COMPLETE bounded subsystem)

Exact functional216113d3893e1dc52b0e5beee9b71947bc570c8d / native
[CI36333889772](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36333889772)
SUCCESS proves dedicated/aggregate/independent-clone controls and actual Pi
foreground edit -> on-write -> semantic_nav. Windows202PASS/0FAIL, Ubuntu104PASS/
0FAIL, complete Linux637PASS/0FAIL; OS-only skips classified in the
[metadata receipt](phi-windows-lsp-evidence.json). Both clones cleanupPASS.
Actual Pi3 deterministic turns/3 broker calls,0 external requests, same draft/
version/digest, both real Error diagnostics, init/shutdown/LPAC/Job/cleanup.

Production path: actual `semantic_nav` / Windows `safe_exec` tool-result on-write
hook -> `lib/lsp-manager.mjs` -> shared platform dispatch ->
`platform/windows/lsp.mjs` -> opaque Task/Tool Governor Worker admission ->
same immutable B2 draft -> structured native broker -> `LSP_READ_ONLY` ->
LPAC/restricted token + pre-resume Job assignment -> real
`vscode-langservers-extracted@4.10.0` JSON language server -> diagnostics ->
same-digest anchored readback -> empty owned Job/drained output -> cleanup.

This is a finite, bidirectional real LSP session, not a synthetic diagnostics
function or fixture-only tool. The trusted native driver handles initialize,
initialized/configuration, didOpen, optional on-write didChange, diagnostic pull,
shutdown/exit. Unknown server requests receive -32601, never host reads or edits.
Only file schemas are enabled; no HTTP/HTTPS or network capability. Schema reads
are by the actual confined server, not a privileged client proxy.

Capability minimization: workspace/assets read-only, isolated scratch writable,
only existing registryRead capability, network DENY, inherited stdin/stdout/stderr
handles only. No extra home/ancestor ACLs, named-pipe exception, shell, non-LPAC
fallback or Job-only agent runner. LSP requests require a bound opaque Worker
authority and governor lsp capability; no tool input can select runtime/profile,
grants, session, draft, executable or arbitrary protocol method. Ordinary Windows
interactive LSP and unsupported languages/operations remain fail closed.

The existing pinned runtime lock is reused, without a new plugin/dependency.
`lsp-runtime.mjs` collects literal CommonJS dependencies and package manifests,
checks installed versions against the lock, canonical source paths, single links
and stable opened file identities/content. Payload includes only js/json runtime
assets, <=512 files/2 MiB; workspace keeps existing256 files/512 KiB bounds.
The larger4 MiB broker request ceiling is LSP-only; B1/B2 command budgets remain
unchanged. Runtime installation and trusted source/controller/build/cache remain
part of the TCB; these hashes/version checks are not publisher signatures or full
Windows handle-anchored runtime-source attestation. Dynamic/uncollected imports
have no ambient grant and fail closed.

Each request materializes the same logical B2 draft/version/digest, not the host
project. It starts a fresh real server and shuts it down; no persistent physical
LSP process or restart durability claim. Three changed JSON files maximum per
on-write hook; excess returns an explicit FAIL. Each server consumes the same
fixed40-tool attempt budget, exclusivity and revocation lifetime. No model calls.
Diagnostics with severity Error still mean the analysis ran, not that the draft
passed verification or can be published. No real project publication exists.

Required native gate: `tests/phi-windows-lsp.test.mjs` real clean/edited diagnostics,
on-write/same-draft lineage, schema-file positive/private-file denial, timeout,
actual target crash, broker death, revocation and owned recovery/cleanup. Actual
Pi foreground factory `scripts/phi-worker-pi-smoke.mjs --lsp` must demonstrate
registered edit -> on-write -> semantic_nav, not just direct module calls. Both
are mandatory in native Windows CI; source-only clone installs the existing lock
instead of copying ignored development runtimes. Linux skips are not native proof.

C is COMPLETE only for those exact bounded JSON/native gates, Linux and both
clones. Ordinary unbound Windows LSP/other languages/navigation remain denied;
the current lsp-status inventory is Linux-oriented, not Windows readiness proof.
Prior e6d aggregate timeout70 cause remains UNKNOWN; current dedicated/aggregate/
clone gates pass without assertion, timeout, retry or permission relaxation.
Fixed-field trusted helper diagnostics are retained for any recurrence; no raw
helper/server output is added to traces/receipts. D NOT_STARTED. Windows autonomy
BLOCKED; whole-product coding/security/crash E2Es and final reconstruction/Doctor/
backup certification remain pending. Next D must retain original base per-file
identity/hash and use native anchored transactional replace, never in-place write
or recursive host copy masquerading as atomic publication.

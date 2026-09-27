# B2 governed Worker transport — IN_PROGRESS, not Windows-ready

## Persistent draft candidate (native proof pending)

The controller seeds lib/phi-worker-draft.mjs once from the approved native
source snapshot. The immutable bounded payload persists in controller memory
for the bound session, not in the original project or a caller-selected path.
Every command rehydrates that same payload into a fresh LPAC workspace; logical
draft ID/revision/content digest and original native base ID remain continuous.
Actual execution-copy IDs are recorded separately and may change. No restart
durability or physical-file-ID persistence across copies is claimed.

Native workspace/ancestors are pinned before target launch. Readback uses held
handles after owned Job emptiness and drained output, before scope cleanup;
protected entries, reparse/hardlink/non-UTF8/overflow are rejected, not omitted.
Only exit0 + validated readback + cleanupPASS commits. Partial failed copies are
discarded. Revocation aborts tools and clears payload, leaving metadata/digest
evidence, never restoring interactive authority. No raw files in traces.

verification_gate now obtains the real bound Worker authority and holds one
exclusive lease for all TEST checks against the immutable draft revision.
Each command consumes the fixed40-call budget. TEST denial plus content-digest
comparison precede PASS; no-check/list/error/revocation is never verification
PASS. The host snapshot is checked for native base identity, never substituted
as verification input. Source changes are not overwritten; publication is
separate and still blocked. Stale/replayed leases and copied tokens fail closed.

Mandatory native tests and actual Pi factory fixtures cover command persistence,
same-draft verification, nonzero partial-copy preservation, post-edit revoke and
owned cleanup. Linux units/binding pass but native proof is pending the new CI.
Historical receipt below only proves preceding transport. Once accepted, start
C streaming LSP, then D crash-atomic publication preparation. Autonomy BLOCKED.

## Production path and authority

secure-workflow.ts reserves authority only for a controller-selected Worker
attempt, using its already-approved Task Governor policy before the real
delegation event. It revokes on terminal outcome. agents/worker.md loads the
Windows-only boundary; before_agent_start binds the exact delegated task hash,
canonical workspace identity and new child session, not a prompt role tag.
Binding hashes the exact `Task: ` envelope added by the installed foreground
transport; bare/double-prefixed/normalized prompt variants cannot match.
Follow-up turns cannot change the original Task/Tool Governor capability ceiling.

lib/phi-worker-authority.mjs derives a validated Tool Governor policy. Syntax
gets READ_ONLY; ordinary file execution gets EDIT only with active edit authority,
otherwise TEST only with active verify authority, otherwise denied. Tokens are
opaque WeakMap keys, never a schema/env/prompt field. Session/attempt digests
appear in metadata, never raw task text, grants, argv, file payloads or credentials.

Registered safe_exec -> shared handler/dispatch -> coding-tools.mjs admission ->
native anchored source snapshot -> runWindowsSecureBroker -> ExecutionBroker ->
actual LPAC token/Job process -> separated tool output/receipt -> scope cleanup.
Native base root ID must match controller approval; no caller-supplied snapshot.
Registered executable forms remain bounded offline Node files / --check only.
Unknown capability/runtime fails closed; no direct-spawn or bare Job fallback.

Concurrency3/depth1/40 admitted tools and remaining18-minute lifetime are
code-owned, not tool parameters. One tool per bound attempt; finish/shutdown
revokes and aborts execution. Dead sessions retain fail-closed tombstones, capped
at1024 per hosting process (capacity refusal, never authority downgrade/eviction).
Foreground children share a package-scoped process registry across extension
reloads. Async/external children cannot inherit it and are denied. Trusted host
extensions/controller code are part of the TCB, not protected from themselves.

## Bypass classification

| Surface | Windows classification |
|---|---|
| Worker safe_exec | shared brokered handler; opaque authority required for Worker privileges |
| Worker bash/PowerShell/subagent/eval/debug/AST rewrite/write/edit/remove | actual Worker hook denies, even if upstream list exposes them |
| Worker read/grep/find/ls | existing governed host read tools, not an LPAC process; existing path safety still applies |
| verification_gate | B1 read-only TEST broker; Worker uses opaque attempt authority and same immutable draft under a batch lease |
| secure workflow controller pi.exec verification | unreachable on Windows while whole-workflow gate remains false; Linux-only today |
| native snapshot/build/recovery / validation Jobs | INTERNAL_TRUSTED fixed endpoints, not Worker command transport |
| Git allocator/orchestration/Pi SDK | trusted controller, native workflow integration remains incomplete |
| LSP/DAP/EditEngine/persistent eval | platform gate still denies Windows, no legacy fallback |
| Linux tools/Worker | existing Linux Bubblewrap path unchanged; new boundary is inert |

No new worker tool calls a shell/exec/spawn. Broker spawns only the verified native
supervisor; its target is assigned LPAC/Job before resume. Source inspection is
not native security proof; native tests must demonstrate actual kernel denial.

## Evidence contract and remaining work

tests/phi-worker-transport.test.mjs uses deterministic orchestration events on the
actual Worker hook/controller/registered handler, not a broker or denial mock.
Native cases must prove snapshot write/readback, actual forbidden read/mutation,
LPAC/Job/start/cleanup metadata, exited PID, nonzero73/FATAL/timeout124, authority
forgery rejection and unchanged source. Linux skips are NOT Windows PASS.

Native Pi session/foreground transport is proven; full Worker workflow is NOT.
Handler/broker controls have native proof on dc12d5d / CI36314208555:
Windows Worker12/12PASS; full190/181PASS/0FAIL/9Linux-only skips and both
source clones green. Subsequent scripts/phi-worker-pi-smoke.mjs uses actual
pi-subagents runSync/default child factory and real Pi SDK with a deterministic
local-only provider, isolated empty auth/catalog, denied fetch and narrowed
safe_exec-only tool surface. It already proves binding/revocation locally;
Mandatory Windows execution now proves the real session -> broker path on
d14200e / CI36314964435 SUCCESS: actual foreground runSync/default Pi factory,
two deterministic turns, WorkerEDIT/LPAC/Job/start/cleanup, real private denial,
snapshot readback, observed tool PID gone and source unchanged. Metadata receipt:
phi-worker-transport-evidence.json. No full coding/draft/publication certificate.
The same actual foreground fixture with --revocation proves that a present
built-in write tool cannot mutate the host fixture after controller revocation.
Pi's real AUTHORITY_UNAVAILABLE tool error is a fail-closed result, not a bypass.
Local denial/source preservation/cleanup PASS; mandatory native case pending.
Subsequent final1a74cab / CI36315617834 SUCCESS proves this mandatory case on
actual Windows too. Both real-Pi positive transport and revoked-host-write
controls PASS, two deterministic turns each, source unchanged/authority revoked/
temporary removed, external requests0. Full native190/181PASS/0FAIL/9Linux-only
skips and both independent clones PASS; Windows clone cleanup387ms/owned residual0.
This closes those controls only; draft continuity/verification remain unfinished.
This bounded transport task intentionally does not request host publication,
does not disable completion guards and is not the full autonomy coding E2E.
Whole workflow still blocked. At that preceding checkpoint the mutable snapshot was ephemeral per
command: no durable draft, cross-command edits or host publication. VERIFIED
only means command exit0 and owned cleanup, not PUBLISHED_TO_PROJECT. Required
next B2 work is actual Pi child binding and controller-owned draft continuity
plus attempt-aware verification, without enabling unrestricted host mutation.
Only after full B2 green begin real Windows LSP(C), then transactions(D).

WINDOWS AUTONOMY BLOCKED;0 live model/provider calls. No authentication, routing,
provider/model policy, Pi installation, Council/Judge or Linux backend change.

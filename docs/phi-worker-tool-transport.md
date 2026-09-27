# B2 governed Worker transport — IN_PROGRESS, not Windows-ready

## Production path and authority

secure-workflow.ts reserves authority only for a controller-selected Worker
attempt, using its already-approved Task Governor policy before the real
delegation event. It revokes on terminal outcome. agents/worker.md loads the
Windows-only boundary; before_agent_start binds the exact delegated task hash,
canonical workspace identity and new child session, not a prompt role tag.
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
| verification_gate | B1 read-only TEST broker; currently denied in Worker boundary pending attempt-aware integration |
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

This candidate is NOT a fresh native Pi session/full Worker workflow proof.
Whole workflow still blocked. Mutable snapshot is currently ephemeral per
command: no durable draft, cross-command edits or host publication. VERIFIED
only means command exit0 and owned cleanup, not PUBLISHED_TO_PROJECT. Required
next B2 work is actual Pi child binding and controller-owned draft continuity
plus attempt-aware verification, without enabling unrestricted host mutation.
Only after full B2 green begin real Windows LSP(C), then transactions(D).

WINDOWS AUTONOMY BLOCKED;0 live model/provider calls. No authentication, routing,
provider/model policy, Pi installation, Council/Judge or Linux backend change.

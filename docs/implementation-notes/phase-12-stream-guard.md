# Phase 12 — StreamGuard

This phase inspected OMP's pinned TTSR export, coordinator, stream guards, tests, and issue #12057 at commit `4267074ac91456866e95ed8de0b6353388f08502`. Useful ideas are incremental argument observation, narrow rule-specific reminders, cooldown, and reservation-before-injection. No OMP source was copied.

## Pi lifecycle finding

Pi 0.85.1 validates and runs `tool_call` pre-hooks before execution. When a pre-hook blocks, the agent core creates an immediate error result and does not invoke the post-execution `tool_result` hook. The first Phase 12 benchmark correctly proved the safety block and zero execution, but falsified the proposed post-result attachment path: the reservation expired and the correction never reached the next turn.

The landed design follows the actual runtime. StreamGuard observes only incremental/final tool arguments and persists a bounded metadata-only reservation. `safety.ts` remains the authoritative pre-hook. Only after safety has independently decided to block does it consume the reservation bound to the current session ID, tool-call ID, and tool name. Delivery is persisted before the concise correction is composed into that same immediate blocked result. A persistence error returns no correction; it never weakens or cancels the safety block.

## Boundaries

- Complete structured arguments are required before classification; incomplete JSON is not treated as a final match.
- The in-memory buffer is capped at 16 KiB. Raw arguments are never persisted or traced.
- Limits are one reservation per turn, eight per session, and a two-turn cooldown per rule.
- The reviewed rules cover protected-path intent, destructive shell intent, and attempts to broaden `safe_exec` authority.
- Replays, wrong session/tool identity, session replacement, terminal assistant state, turn end, settled agent, and shutdown cannot inject twice or later.
- StreamGuard registers no model tool, prompt, provider, runtime, timer, abort, retry, or follow-up message.
- Existing safety, Tool Governor, allowlisted execution, Bubblewrap, and path/TOCTOU controls remain the execution boundary.

## Evidence

The focused suite covers policy validation, fragmented streams, reservation-before-delivery, exact ownership, metadata non-disclosure, safe/incomplete/malformed input, persistence failure, session replacement, cooldown/count limits, restore suppression, and shutdown expiry. The real Pi benchmark proves exactly one `RESERVED` then one `DELIVERED` receipt, an unchanged sentinel, correction visibility on the next normal provider turn, two total deterministic turns, no extra call, zero network/provider/cost, command registration, and cleanup.

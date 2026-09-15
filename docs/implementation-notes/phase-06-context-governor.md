# Phase 6 implementation note — Context Governor

## Reference inspection

This phase inspects Pi 0.85.1's actual `context` and `before_provider_request` lifecycle, model metadata, context-usage API, tool registry, and direct model-completion paths. It also inspects OMP's pinned compaction methods and context notes at commit `4267074ac91456866e95ed8de0b6353388f08502`. No OMP source is copied.

Pi runs the `context` hook after extensions have assembled the model-facing history and before conversion/provider streaming. Extension-hook exceptions are reported but do not stop execution, so the gate never relies on throwing: an unprovable fit calls `ctx.abort()` and the provider hook separately requires a matching PASS proof. `/handoff` uses `modelRegistry.complete` directly and therefore has its own pre-call gate.

## Context Fit Gate

The clean-room governor estimates the system prompt, active tool schemas, conversation, Shared Memory Pack/Second Brain messages, artifact previews, agent/compaction summaries, tool output, reserved output, and a 4,096-token safety margin against the smaller authoritative model/reported context window. Text estimation deliberately matches Pi's documented four-character approximation; images reserve 1,200 tokens. Provider-reported usage, when present, is authoritative unless measured local reductions account for the difference.

If the initial payload does not fit, only evidence-preserving local transformations run, in this fixed order:

1. replace older duplicate artifact previews with their immutable URI and bounded diagnostic-preserving excerpt;
2. compact historical tool output while retaining every critical diagnostic;
3. convert historical raw reads to a bounded SmartRead envelope with an exact-reopen warning;
4. supersede only older Second Brain packs while retaining the newest pack exactly;
5. discard only the prefix already represented by a real Pi compaction summary, and deduplicate exact summary repeats.

The current user request is never truncated. The governor does not synthesize a lossy conversational summary and does not silently switch provider/model in an in-flight request. If the payload still cannot fit, it fails closed and asks for compaction/handoff or an explicit policy-compatible target. This is a deliberate routing boundary: Pi 0.85.1 provides no safe hook API for replacing the active target after payload assembly without bypassing the existing routing and callability policy.

The governor is the final package extension so it sees the final active schemas and injected memory. Every subagent role loads it in its fresh process. `/context-fit` reports the current accounting without inference. Trace events contain identities, counts, token estimates, reduction names/counts, statuses, and proof digests only—never prompts, message bodies, schemas, file content, artifact URIs, or secrets.

## Evidence

- 11 focused adversarial tests PASS: complete accounting, ordered reductions, tool-call/result pairing, diagnostic retention regardless of position, SmartRead and Second Brain behavior, safe compaction-summary use, reported-usage adjustment, authoritative context bounds, fail-closed malformed policy/model data, non-disclosure, and preservation of an oversized latest user request.
- The real Pi 0.85.1 benchmark uses a deterministic local provider and the actual Artifact Store plus Context Governor. The third request measured 3,268 input tokens against 2,480 usable, removed one redundant artifact preview, saved 1,085 estimated tokens, and entered the provider at 2,183 tokens. Reopenable artifact references, the omission marker, and both critical diagnostics remained present.
- A separate oversized current-user request measured 39,216 input tokens against 1,880 usable and was BLOCKED; the deterministic provider recorded zero stream entries.
- The provider hook attested all three successful proofs, `/context-fit` registered with zero provider calls, and temporary cleanup passed. The run made three deterministic local provider turns, zero network/external-provider/paid calls, and cost zero.
- `/handoff` deterministic real-Pi regression PASS: the canonical notebook marker survived distillation, the new session had zero prior messages, and the command completed.
- Full `npm run check` PASS: 283/283 tests plus syntax, Ultra fixture syntax, memory syntax, installed-Pi TypeScript, package, and secret validation using the verified stable managed LSP runtime.
- OMP execution remains honestly `NOT_RUN` because Bun >=1.4 is unavailable.

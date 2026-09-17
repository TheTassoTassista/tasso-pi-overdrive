# Phase 13 — bounded Sentinel

## Decision

The pinned OMP advisor/watchdog was reviewed at commit `4267074ac91456866e95ed8de0b6353388f08502`. Its useful idea is a conditional second opinion during a difficult live task. Ultra does not copy its asynchronous watchdog, backlog, transcript, steering, retry, or configurable tool roster. In particular, an advisor must never inherit OMP's optional edit/write/bash/eval authority.

Ultra implements Sentinel as the explicit `/sentinel TASK` command. The deterministic Task Governor must independently classify the task as hard or critical debugging work with `needs.sentinel=true`. The command reuses the already-resolved `oracle` route and its exact provider/model/thinking policy; it adds no role, fallback, preset, Council member, workflow stage, subagent, or model-facing schema. Token Saver can therefore remain fail-closed when its selected Oracle route lacks trusted price metadata rather than silently changing route.

## Authority and lifecycle

Sentinel receives one user-supplied task string, one fixed system prompt, and `tools: []`. It cannot read files, edit, write, execute shell, evaluate code, browse, spawn, delegate, steer the active agent, invoke Council, or alter workflow state. Advice is a strict six-field JSON object, is validated before use, and is published as an explicitly untrusted custom message with `triggerTurn:false`. Delimiter characters are escaped; tool calls, prose wrappers, extra fields, secrets, controls, oversize output, route/thinking mismatch, and non-terminal responses fail closed.

The session budget is exactly one invocation. A metadata-only `RESERVED` receipt is appended before the direct completion. That reservation consumes the budget even if Pi crashes or the provider fails. A terminal `COMPLETED` or `FAILED` receipt records the requested/observed route, thinking source, normalized usage, cost, counts, digests, and error code. Resume accepts only digest-valid same-session receipts; corrupt or cross-session state blocks rather than replaying. There is no automatic retry: `maxRetries=0` and a 45-second abort deadline are passed directly to the provider runtime.

## Budgets and privacy

`config/sentinel.json` fixes one invocation, 6,000 task characters, a 4,096-token conservative input estimate, 768 output tokens, 3,000 advice characters, four bounded evidence strings, a 45-second timeout, and a USD 0.05 worst-case price ceiling. The ceiling uses the highest advertised base/tier input and output rates before launch; missing price metadata blocks. Provider-reported actual cost above the reservation ceiling rejects the advice.

Trace rows contain route identity, thinking source, launch/call state, context/cost/output counts, usage status, task/model/advice/receipt digests, and error codes only. They never contain the task, prompt, evidence, recommendation, advice text, provider output, files, or secrets. The raw validated advice exists only in the normal Pi session message where the user and primary agent can inspect it.

## Evidence

- Ten focused cases cover policy bounds, task gating, route and price attestation, strict structured output, delimiter escape, reservation ordering, single-use/resume suppression, provider-thinking mismatch, actual-cost excess, and metadata privacy.
- The real Pi 0.85.1 benchmark registers `/sentinel`, proves status and negative paths use zero calls, performs exactly one deterministic local `openai-codex/gpt-6-astra:high` completion with zero tools and zero retries, then blocks the repeated invocation before context assembly.
- The benchmark makes zero network, external-provider, paid, or billable calls, starts no runtime/process, leaves routing unchanged, and removes its temporary root.

No OMP source was copied. OMP remains source-inspected only because its Bun >=1.4 runtime is unavailable on this host.

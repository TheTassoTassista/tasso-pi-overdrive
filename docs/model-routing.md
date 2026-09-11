# Model routing, presets, and council

The policy is user-owned at `${XDG_CONFIG_HOME:-~/.config}/pi-overdrive/model-policy.json` with mode `0600`. Pi models cannot edit it through a tool. Changes are accepted only from user-invoked slash commands; provider/model/thinking fields are rejected recursively from subagent tool input, and autonomous roles cannot write outside their allocated worktree. A separate owner-only, secret-free cache at `pi-overdrive/model-callability.json` records authenticated runtime evidence without probing a paid provider at startup.

`/models` reports `REGISTRY_AVAILABLE`, `AUTHENTICATED`, and `RUNTIME_CALLABLE` independently, plus public metadata only. It never asks for or prints credential values. A route is usable only when all three conditions hold. `/model-routing` shows the resolved map, skip/fallback reasons, and policy digest. `/model-role ROLE PROVIDER/MODEL[:THINKING]` validates and persists one exact callable route. `/model-preset NAME` selects a preset and clears old overrides deterministically; `/model-preset custom` retains the current concrete base plus explicit overrides and fails with `BLOCKED_BY_MODEL` rather than silently rewriting an invalid user choice. `/model-preset preview NAME` resolves without writing either the policy or Pi settings.

At the 2026-09-10 audit, `openai-codex` was the only configured provider. The registry/authenticated catalog contains eight IDs. Existing authenticated receipts prove Luna, Terra, Sol, Astra and 5.5 runtime-callable. `gpt-5.4` is `RUNTIME_REJECTED` for the current ChatGPT-account provider path; 5.4-mini and 5.3-codex-spark have no cached runtime proof and are `RUNTIME_UNKNOWN`. Registry/authentication presence alone never admits any of those three.

- `openai-codex/gpt-5.3-codex-spark`
- `openai-codex/gpt-5.4`
- `openai-codex/gpt-5.4-mini`
- `openai-codex/gpt-5.5`
- `openai-codex/gpt-5.6-luna`
- `openai-codex/gpt-5.6-sol`
- `openai-codex/gpt-5.6-terra`
- `openai-codex/gpt-6-astra`

Every other registered provider was reported as `configured: false` with zero available models. In particular, `deepseek` and the three `qwen-token-plan*` provider IDs are supported by Pi but not authenticated. Cross-provider heterogeneity is therefore not claimed.

## Exact current preset maps

These are the routes resolved against the catalog plus cached runtime evidence. If a preferred model is missing, unauthenticated, unknown, or rejected, the resolver selects the next explicitly ordered callable route and records every skipped candidate and reason. If none is callable it returns `BLOCKED_BY_MODEL` before any Council fan-out.

| Role | Budget | Efficient (default) | Balanced | Max quality |
|---|---|---|---|---|
| Scout | Luna · low | Luna · low | Luna · low | Terra · medium |
| Planner | Luna · medium | Sol · high | Sol · high | Astra · max |
| Oracle | Luna · medium | Astra · high | Astra · high | Astra · max |
| Worker | Luna · medium | Terra · high | Terra · high | Terra · max |
| Tester | Luna · low | Luna · medium | Luna · medium | Sol · high |
| Correctness | Luna · medium | Sol · high | 5.5 · high | 5.5 · xhigh |
| Security | Luna · medium | Sol · high | Luna · high | Luna · max |
| Simplicity | Luna · low | Luna · medium | Luna · medium | Sol · high |
| Council 1 | Luna · medium | Sol · high | Sol · high | Sol · max |
| Council 2 | Luna · medium | 5.5 · high | 5.5 · high | 5.5 · xhigh |
| Council 3 | Luna · medium | Luna · high | Luna · high | Luna · max |
| Council judge | Luna · medium | Astra · high | Astra · high | Astra · max |

`Luna`, `Terra`, `Sol`, `Astra`, and `5.5` in the table mean the full `openai-codex/gpt-*` IDs listed above. `custom` has no fixed map: it is one concrete base preset plus an exact override for any or all twelve roles.

The deterministic route-rate benchmark sums Pi's published input-plus-output rates for each invoked role; it is not a task-cost prediction:

| Preset | Normal seven-role path | Additional five high-risk/council roles | Model identities | Providers |
|---|---:|---:|---:|---:|
| Budget | 9.8 | 7.0 | 1 | 1 |
| Efficient | 123.2 | 191.4 | 5 | 1 |
| Balanced | 89.6 | 191.4 | 5 | 1 |
| Max quality | 194.4 | 191.4 | 5 | 1 |

The unit is summed USD per million input-plus-output tokens per role, using catalog metadata. Actual token mix, caching, retries, and whether escalation runs determine real task cost. Efficient remains the default because it keeps reconnaissance and testing on Luna, implementation on Terra, review/planning on Sol, and reserves Astra for Oracle/Judge; the live multi-provider quality experiment could not be performed with one authenticated provider.

## Receipt binding

The controller freezes all resolved routes before fan-out and passes provider/model and thinking separately on every fresh child request. It accepts either canonical `provider/model` or Pi-subagents' exact `provider/model:thinking`, canonicalizes the latter, and validates provider, model, suffix, and thinking independently. A mismatch becomes a durable `protocol_rejected` receipt. Every terminal attempt—including failures and timeouts—gets an immutable receipt with a failure category before the controller records its outcome. Admission rechecks run, task, nonce, execution ID, sequence, role, round, owner, node, status, model, and thinking. `TRANSIENT` transport failures and attested post-launch `STRUCTURED_OUTPUT_MODEL_INVALID` may retry once on the unchanged route, with at most three retry spawns per workflow. Deterministic schema/configuration (`STRUCTURED_OUTPUT_POLICY_ERROR`), policy, resource-limit, auth, unsupported-model, and identity/route failures stop immediately. Route attestation is skipped when the bridge rejected a request before child/provider launch, preserving the original category, absent route fields, and zero model calls.

## Council

`/council TASK` is a protected extension command that routes the task into the existing `secure_coding_workflow` with Oracle, security review, and council escalation enabled. It deliberately shadows the raw upstream pi-subagents prompt of the same name; a runtime precedence test proves the protected handler wins. `/council-status` is read-only.

The three council members receive fresh read-only, non-delegating contexts and equivalent evidence. `completionGuard: false` gives them advisory completion semantics without granting write or shell tools; Worker retains implementation-mutation acceptance semantics. Each invocation uses pi-subagents' native per-request structured-output schema. Missing, prose-only, partial, malformed, extra-field, wrong-role/run/round, or duplicate evidence fails closed. The controller launches the separate read-only Judge only after three valid, receipt-admitted results. Council activates for explicit requests, high-risk work, material reviewer disagreement, or repeated correction failure.

Hard controller constants are concurrency `3`, subagent depth `1`, and correction rounds `2`. These fields, raw workflow scripts, nesting flags, model routes, and worktree disablement are recursively rejected from caller input.

## Daily commands

```text
/models
/model-routing
/model-role list
/model-role worker openai-codex/gpt-5.6-terra:high
/model-role correctness openai-codex/gpt-5.5:high
/model-preset list
/model-preset show
/model-preset preview max-quality
/model-preset efficient
/council-status
/council <task>
```

Reload Pi after a persistent change before invoking `subagent` directly. `secure_coding_workflow` reads the new policy immediately.

# Model routing, presets, and council

The policy is user-owned at `${XDG_CONFIG_HOME:-~/.config}/pi-overdrive/model-policy.json` with mode `0600`. Pi models cannot edit it through a tool. Changes are accepted only from user-invoked slash commands; provider/model/thinking fields are rejected recursively from subagent tool input, and autonomous roles cannot write outside their allocated worktree.

`/models` reads Pi's live registry and returns only public model metadata plus provider IDs, configured booleans, and available-model counts. It never asks for or prints credential values. `/model-routing` shows the resolved map and policy digest. `/model-role ROLE PROVIDER/MODEL[:THINKING]` validates and persists one exact authenticated route. `/model-preset NAME` selects a preset and clears old overrides deterministically; `/model-preset custom` retains the current concrete base plus explicit overrides. `/model-preset preview NAME` resolves without writing either the policy or Pi settings.

At the 2026-09-09 runtime audit, `openai-codex` was the only configured provider. Available IDs were:

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

These are the routes resolved against that live catalog. If a preferred model is absent on another installation, the resolver selects a deterministic authenticated fallback and reports the resulting diversity rather than inventing availability.

| Role | Budget | Efficient (default) | Balanced | Max quality |
|---|---|---|---|---|
| Scout | Luna · low | Luna · low | Luna · low | Terra · medium |
| Planner | Luna · medium | Sol · high | Sol · high | Astra · max |
| Oracle | Luna · medium | Astra · high | Astra · high | Astra · max |
| Worker | Luna · medium | Terra · high | Terra · high | Terra · max |
| Tester | Luna · low | Luna · medium | Luna · medium | Sol · high |
| Correctness | Luna · medium | Sol · high | 5.5 · high | 5.5 · xhigh |
| Security | Luna · medium | Sol · high | 5.4 · high | 5.4 · xhigh |
| Simplicity | Luna · low | Luna · medium | Luna · medium | Sol · high |
| Council 1 | Luna · medium | Sol · high | Sol · high | Sol · max |
| Council 2 | Luna · medium | 5.5 · high | 5.5 · high | 5.5 · xhigh |
| Council 3 | Luna · medium | 5.4 · high | 5.4 · high | 5.4 · xhigh |
| Council judge | Luna · medium | Astra · high | Astra · high | Astra · max |

`Luna`, `Terra`, `Sol`, `Astra`, `5.5`, and `5.4` in the table mean the full `openai-codex/gpt-*` IDs listed above. `custom` has no fixed map: it is one concrete base preset plus an exact override for any or all twelve roles.

The deterministic route-rate benchmark sums Pi's published input-plus-output rates for each invoked role; it is not a task-cost prediction:

| Preset | Normal seven-role path | Additional five high-risk/council roles | Model identities | Providers |
|---|---:|---:|---:|---:|
| Budget | 9.8 | 7.0 | 1 | 1 |
| Efficient | 123.2 | 207.5 | 6 | 1 |
| Balanced | 105.7 | 207.5 | 6 | 1 |
| Max quality | 210.5 | 207.5 | 5 | 1 |

The unit is summed USD per million input-plus-output tokens per role, using catalog metadata. Actual token mix, caching, retries, and whether escalation runs determine real task cost. Efficient remains the default because it keeps reconnaissance and testing on Luna, implementation on Terra, review/planning on Sol, and reserves Astra for Oracle/Judge; the live multi-provider quality experiment could not be performed with one authenticated provider.

## Receipt binding

The controller passes the resolved provider/model and thinking level on every fresh child request. It accepts either the exact canonical `provider/model` form or Pi-subagents' exact `provider/model:thinking` form, canonicalizes the latter, and validates thinking separately. A different model, provider, or suffix becomes a durable `protocol_rejected` receipt. Every terminal attempt—including failures and timeouts—gets an immutable receipt before the controller records its outcome. Admission then rechecks run, task, nonce, execution ID, sequence, role, round, owner, node, status, model, and thinking. The resolved policy and digest are stored in the resumable workflow state, so changed or corrupted routes fail closed on resume.

## Council

`/council TASK` is a protected extension command that routes the task into the existing `secure_coding_workflow` with Oracle, security review, and council escalation enabled. It deliberately shadows the raw upstream pi-subagents prompt of the same name; a runtime precedence test proves the protected handler wins. `/council-status` is read-only.

The three council members receive fresh read-only, non-delegating contexts and equivalent evidence. Their initial reports are unavailable to one another. The controller waits for all three structured results before launching a separate read-only Judge. The Judge must preserve material disagreement rather than majority-voting it away. Council activates for explicit requests, high-risk work, material reviewer disagreement, or repeated correction failure; it is not used for routine tasks.

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

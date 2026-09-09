# Model routing and presets

The policy is user-owned at `${XDG_CONFIG_HOME:-~/.config}/pi-overdrive/model-policy.json` (mode `0600`). Pi models cannot edit this file through a tool: policy changes are slash commands, model/provider/thinking overrides are rejected from `subagent` input at every nesting level, persistent subagent management actions are blocked from model tool calls, and autonomous roles cannot write outside their allocated worktree.

`/models` reads Pi's live registry. It prints public model capability/cost metadata plus each registered provider's configured boolean and available-model count; it never asks the registry for or displays credential values. `/model-routing` prints the resolved role map and a policy digest. `/model-role ROLE PROVIDER/MODEL[:THINKING]` sets an exact authenticated model and validates that the requested thinking level is supported. `/model-preset NAME` selects a preset; switching to a concrete preset clears manual overrides deterministically. `/model-preset custom` preserves the current base preset plus explicit overrides.

At the 2026-09-09 runtime audit only `openai-codex` was authenticated. The live available IDs were `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-6-astra`. Unauthenticated registered providers are reported as `configured: false`; no cross-provider diversity is claimed.

## Efficient default

| Role | Model | Thinking |
|---|---|---:|
| Scout | `openai-codex/gpt-5.6-luna` | low |
| Planner | `openai-codex/gpt-5.6-sol` | high |
| Oracle | `openai-codex/gpt-6-astra` | high |
| Worker | `openai-codex/gpt-5.6-terra` | high |
| Tester | `openai-codex/gpt-5.6-luna` | medium |
| Correctness reviewer | `openai-codex/gpt-5.6-sol` | high |
| Security reviewer | `openai-codex/gpt-5.6-sol` | high |
| Simplicity reviewer | `openai-codex/gpt-5.6-luna` | medium |
| Council 1 / 2 / 3 | Sol / 5.5 / 5.4 | high |
| Council judge | `openai-codex/gpt-6-astra` | high |

## Presets

- `budget`: assigns every role to the lowest weighted input/output cost in Pi's authenticated catalog. It falls back to reviewed preferences only when cost metadata is absent.
- `efficient`: Luna for cheap discovery/testing, Terra for implementation, Sol for planning/review, and Astra only for Oracle/judging.
- `balanced`: keeps the efficient worker path but routes correctness and security through distinct 5.5/5.4 model identities when available.
- `max-quality`: uses maximum supported thinking for planning, implementation, critics, and council; unsupported `max` levels are safely reduced to the strongest level the selected model exposes.
- `custom`: a concrete base preset plus exact per-role overrides. An unavailable model or unsupported thinking level fails closed.

Presets resolve only against `ModelRegistry.getAvailable()`. When a preferred ID is absent, selection falls back deterministically to another authenticated model. With only one authenticated model, every role safely uses that model and diversity is reported as one rather than fabricated.

The secure workflow passes the resolved provider/model and thinking level explicitly on every fresh child request. It rejects a response whose actual route differs, stores both fields in the immutable role receipt, and revalidates both on admission. The persistent policy digest and full resolved map are bound into the resumable workflow state, so a changed/corrupt resumed route fails closed.

## Daily commands

```text
/models
/model-routing
/model-role list
/model-role worker openai-codex/gpt-5.6-terra:high
/model-role correctness openai-codex/gpt-5.5:high
/model-preset list
/model-preset show
/model-preset efficient
```

After a persistent change, reload Pi before using `subagent` directly. `secure_coding_workflow` uses the new policy immediately.

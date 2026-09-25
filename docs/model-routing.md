# Routing presets and quality

Pi Overdrive separates two controls:

- **Preset** is the persistent spending/routing strategy. `normal` is the default; `token-saver` prioritizes tools, small contexts and minimal fan-out.
- **Quality** is a session-only authorization overlay. It starts at `auto` in every new Pi process/session and accepts `auto`, `low`, `medium`, `high`, or `max`.

The precedence is fixed: security and hard correctness, explicit quality, preset, deterministic difficulty/runtime evidence, model availability, then fallback order. `max` permits the strongest useful route; it does not call every role. Deterministic verification remains mandatory at every level.

## Commands

```text
/preset
/preset normal
/preset token-saver
/quality
/quality auto
/quality low
/quality medium
/quality high
/quality max
/ai-tree
/ai-tree --json
/models --capabilities
/models --capabilities openai-codex/gpt-6-sol
```

`/preset` writes the owner-only policy at `${XDG_CONFIG_HOME:-~/.config}/pi-overdrive/model-policy.json`. A version-1 `efficient` policy is read as `normal` without rewriting or dropping overrides; an explicit `/preset` selection writes version 2. The compatibility command `/model-preset` and exact `/model-role ROLE PROVIDER/MODEL[:THINKING]` override remain available.

`/quality` changes only module-local session state and never writes Pi settings. A new session resets it to `auto`. `normal + auto` is the recommended default; `token-saver + auto` minimizes practical quota use; `normal + high` is suitable for important work; `normal + max` authorizes maximum useful escalation; `token-saver + max` retains compact context/fan-out while allowing strong models when justified.

`/ai-tree` is metadata-only. It shows the configured chains, current selected route, exact provider/model/effort, direct versus OmniRoute source, registry/auth/callability state, conditional roles, Council triggers, deterministic verification and context limits. It never invokes a model.

## GPT-6 migration boundary

This worktree stages the GPT-6 policy; the installed Pi 0.85.1 package still points to the stable worktree. Pi's local `models-store.json` lists `gpt-6-luna`, `gpt-6-sol`, and `gpt-6-astra` under `openai-codex`, but the owner-only runtime-callability evidence attests only Astra. Registry presence is not a successful subscription-backed inference. Luna/Sol remain `RUNTIME_UNKNOWN` and are skipped by the resolver until a separate permitted smoke establishes callability. No Pi update, credential change, API key, or paid route is part of this migration.

Luna handles focused high-volume roles and the first Token Saver Worker attempt. Sol is the normal coding/review model. Astra is reserved for Oracle/Judge or exceptional escalation. Legacy GPT-5.6 direct models remain bounded fallbacks so this staged change does not strand the installed runtime. No context or exposed-tool budget increases follow from the larger GPT-6 catalog limits.

## Normal Work

At `quality=auto`, direct OpenAI targets and efforts are:

| Role | Primary | Effort | Ordered fallback |
|---|---|---:|---|
| Scout | `openai-codex/gpt-6-luna` | low | 5.6 Luna → Terra |
| Planner | `openai-codex/gpt-6-sol` | medium | 5.6 Sol high → Astra high |
| Oracle | `openai-codex/gpt-6-astra` | high | Sol high → 5.6 Sol high |
| Worker | `openai-codex/gpt-6-sol` | medium | 5.6 Terra high → 5.6 Sol high |
| Tester AI | `openai-codex/gpt-6-luna` | medium | 5.6 Luna → Terra |
| Correctness | `openai-codex/gpt-6-sol` | medium | 5.6 Sol high → Astra high |
| Security | `openai-codex/gpt-6-sol` | high | 5.6 Sol high → Astra high |
| Simplicity | `openai-codex/gpt-6-luna` | medium | 5.6 Luna → Terra |
| Council 1 | `openai-codex/gpt-6-sol` | high | 5.6 Sol → Astra |
| Council 2 | DeepSeek reasoning only with verified zero-extra-cost evidence | provider-side high ID / Pi effort off | 5.5 high → 5.6 Sol high |
| Council 3 | `openai-codex/gpt-6-luna` | high | 5.6 Luna high |
| Judge | `openai-codex/gpt-6-astra` | high | Sol high → 5.6 Sol high |

Simple work runs Worker → deterministic verification → stop. Hard work adds compact Scout/Planner evidence and the appropriate review. Tester and reviewers are not launched solely because they exist. Critical risk, material reviewer disagreement, an explicit `/council`, or the second bounded correction can authorize Council.

## Token Saver

Token Saver changes route preference and role authorization without weakening verification/security:

| Role | Primary | Ordered fallback |
|---|---|---|
| Scout | GPT-6 Luna low | 5.6 Luna low |
| Planner, normally skipped | GPT-6 Luna medium | GPT-6 Sol low → 5.6 Sol high |
| Oracle, exceptional only | GPT-6 Astra high | GPT-6 Sol high → 5.6 Sol high |
| Worker | GPT-6 Luna medium | GPT-6 Sol medium only when Luna is unavailable or explicitly escalated → 5.6 Terra high |
| Tester AI, conditional | GPT-6 Luna medium | 5.6 Luna medium |
| Correctness, conditional | GPT-6 Luna medium | GPT-6 Sol medium → 5.6 Sol high |
| Security, risk-gated | GPT-6 Sol high | 5.6 Sol high → Astra high |
| Simplicity, conditional | GPT-6 Luna low | 5.6 Luna medium |

Tester AI, correctness and Council are normally disabled on a successful cheap/default path. A deterministic failure activates Tester interpretation and correctness review before a correction; by itself it does not prove Luna lacks model capability or authorize Sol. A separately justified model-capability escalation can use the bounded Sol fallback. Security-sensitive work elevates low/medium policy to effective high and retains the strong direct Security route. The second and final correction can authorize Oracle/Council, but never unbounded fan-out.

## Exact OmniRoute catalog IDs

The following cloud IDs were discovered from the existing local OmniRoute `/v1/models` metadata endpoint on 2026-09-12; no inference request was made:

- DeepSeek reasoning: `deepseek/deepseek-v4-pro-high`
- DeepSeek coding: `deepseek/deepseek-v4-flash`
- Qwen reasoning: `openrouter/qwen/qwen3.8-27b`
- Qwen coding: `openrouter/qwen/qwen3-coder-next`
- fast Qwen on Groq: `groq/qwen/qwen3-32b`
- late automatic routes: `auto/best-fast`, `auto/best-reasoning`, `auto/best-coding`

Pi identities prefix these with the registered gateway provider, for example `omniroute/deepseek/deepseek-v4-pro-high`. DeepSeek/Qwen model IDs use Pi effort `off`; the DeepSeek high variant encodes its provider-side reasoning level in the catalog ID, and no unsupported reasoning-effort field is sent to the OpenAI-compatible gateway.

OmniRoute is registered from the existing `OMNIROUTER_BASE_URL` and `OMNIROUTER_API_KEY` environment references. No credential is stored in this repository and this package does not start or manage OmniRoute.

## Callability and fail-closed behavior

Registry presence, authentication and runtime callability are separate. `/v1/models` proves only catalog presence. A candidate is selectable only when the Pi registry sees it, authentication is available, and the owner-only callability cache says `RUNTIME_CALLABLE`. `RUNTIME_UNKNOWN` and `RUNTIME_REJECTED` candidates are skipped in declared order with a reason. When no candidate remains, resolution returns `BLOCKED_BY_MODEL` before allocation or fan-out.

Because this change made no inference probes, the new GPT-6 Luna/Sol IDs and existing OmniRoute IDs are not falsely seeded as callable. Direct legacy models remain available while GPT-6 runtime status is unknown. Even a fixture-callable OmniRoute route remains unavailable to automatic selection without Provider Capability Registry proof of zero additional cost. The Council-2 diverse candidate stays in the chain but is currently blocked; the safe 5.5 fallback reduces live Council family diversity. This limitation must be resolved by authoritative cost/callability evidence, not a guessed price.

An unsupported/auth/policy response after launch remains fail-closed and is not retried or silently switched. Fallback is a deterministic preflight decision based on current evidence; it is not an unbounded provider-error retry mechanism.

## Quality and governor

`auto` classifies tasks as `simple`, `normal`, `hard`, or `critical` using bounded metadata: task length/lines, file-reference count, explicit high-risk request, and a closed list of complexity/security signals. The task text is never retained in governor metadata. Automatic quality maps those classes to low/medium/high/max. Security-sensitive evidence elevates effective quality to at least high. Explicit `high` raises direct Planner/Worker/Correctness to high and Tester to high while leaving Scout low. `max` uses xhigh for eligible direct roles, not unconditional Astra or extra roles.

The controller owns the resulting role booleans, Council permissions, context caps and model-call ceiling. None is present in the model-callable tool schema. Ceilings range from 12 calls for cheap Token Saver work to 42 for the complete 39-spawn critical path plus the existing global three-retry reserve. Concurrency remains 3, depth 1, corrections 2 and transient/attested-structured retry at most one per delegation and three per workflow.

The `low` effort overlay may reduce ordinary direct roles, but never lowers direct Security, Oracle, Council-member, or Judge reasoning below `high`. OmniRoute reasoning variants keep Pi effort `off` because their provider-side behavior is encoded by the exact model ID.

Normal handoffs are capped at 12,000 characters (10,000 evidence; 8,000 Council). Token Saver uses 7,000/6,000/5,000. Planner returns only constraints, relevant files, steps and acceptance checks; Worker receives only available compact planning evidence; reviewers receive task, verification state and inspect the actual diff; Judge receives the three structured conclusions rather than full transcripts.

## Observability

Workflow evidence and metadata traces record only routing metadata: preset, requested/effective quality, difficulty, security flag, role, provider, exact model, effort, fallback index, call number, retry count, policy digest and model-call limit. Existing role receipts retain provider-reported input/output/cache usage and result/error digests. Prompts, raw model output, file contents, keys, cookies and bearer credentials are never added by the routing layer. Unknown OmniRoute pricing is reported as unavailable rather than zero; only catalog-reported pricing is exposed.

The intended Council remains Sol + an independently reasoned DeepSeek route when its cost and callability are verified + Luna, followed by an Astra Judge. At present Council-2 resolves to GPT-5.5 under the fail-closed cost rule, so the active route is three different OpenAI model identities but one model family/provider. The DeepSeek candidate and its independent read-only/structured contract remain intact; no false heterogeneous-runtime claim is made.

## Harness profiles are post-route

`/models --capabilities` gives a read-only summary of the local Provider Capability Registry; add an exact provider or `provider/model` selector for bounded detail. It combines Pi declarations, receipt-backed callability and harness evidence without fetching a catalog or calling a model. UNKNOWN capability, rate limit, or price remains UNKNOWN; a default zero/zero price is not treated as proof of free usage. This inspection view cannot authorize a route.

Routing chooses the provider/model/thinking tuple first. `lib/model-harness-profile.mjs` then composes that exact identity with Pi registry metadata, the existing callability cache, and `config/model-harness-profiles.json`. It cannot select a model, modify a fallback chain, lower Council/Judge effort, or spend a provider call. The profile can only narrow the Tool Governor surface, choose among already-exposed transactional edit contracts, and supply non-increasing context metadata to the Context Governor. Use `/model-profile [--json]` to inspect the current profile and evidence locally.

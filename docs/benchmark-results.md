# Benchmark and smoke results

Recorded through 2026-09-13 with official Pi 0.85.1. A PASS below is backed by the current filesystem plus a runtime command; the latest authenticated E2E remains a FAIL. Routing and Second Brain activation used only catalog metadata, deterministic local providers, CPU embeddings, and loopback services—no authenticated inference or E2E call.

## Current regression evidence

| Check | Result | Runtime evidence |
|---|---|---|
| Unit/static package | PASS | `npm run check`: 216/216 Node tests, syntax, extension TypeScript, manifest/frontmatter/pin/path validation |
| Local Second Brain services | PASS | `npm run smoke:memory-services`: 17/17 real checks for CPU multilingual embeddings, OpenViking bilingual search plus exact L0/L1/L2, Hindsight temporal retain/recall, Reflect fail-closed, and duplicate suppression; zero model/provider calls |
| Routing/quality policy | PASS | 26/26 focused unit tests: preset migration/persistence, quality session state/precedence, adaptive paths, security/strong-Council override, deterministic fallbacks, fail-closed routes, Council/Judge mappings, call limits and metadata privacy |
| Deterministic evaluator | PASS | `npm run benchmark:suite`: 6/6 task categories, zero paid calls |
| Model preset evaluator | PASS | `npm run benchmark:models`: `normal` and `token-saver`, all twelve roles resolved from current registry/auth/callability metadata, zero model calls; OmniRoute catalog entries remain runtime-unknown and therefore use direct fallbacks |
| Real Pi capability path | PASS | `npm run smoke:runtime`: FFF filename/content, two AST matches, TS diagnostics/definition/four references, and real public `web_fetch`, driven sequentially by a local deterministic provider |
| Real Pi routing commands | PASS | `npm run smoke:models`: 9/9 through Pi RPC; `/preset`, `/quality`, and `/ai-tree` are registered, persistence/alias/session reset/immediate quality effect/JSON tree/secret-free output pass with zero model calls |
| Council surface/policy | PASS | `npm run smoke:council`: 4/4; protected `/council` command wins, heterogeneous target routes render, and all four roles are fresh/read-only/non-delegating with advisory completion semantics |
| Local Council/workflow | PASS | `npm run smoke:council-local`: corrected valid Council 100/100; full zero-paid Scout→Council→Worker→Tester→review→correction→final verification reached PASS; all negative controls failed closed |
| Real spawn bridge/accounting | PASS | `npm run smoke:spawn-budget`: installed `pi-subagents@0.66.0` native-schema event bridge and upstream accounting with a deterministic local provider; 32 delegations, Council-2 invalid at slot 24 then valid at slot 26 on the same route, Council-3 at slot 25, one shared retry-reserve unit used, final PASS, deterministic schema/config rejection before launch, limit-24 zero-call preflight, atomic rejection, cleanup PASS |
| MCP | PASS | `npm run smoke:mcp`: mutation approval denial, allowlist, no side effect, metadata-only MCP trace; prior online Context7 read remains documented separately |
| General LSP | PASS | Current managed runtime and regression suite cover TypeScript, Python, C/C++, Rust, Go and Bash definition/reference/diagnostic paths plus JS/HTML/CSS/JSON/YAML semantic fixtures in read-only no-network isolation |
| Web | PASS/PARTIAL | `npm run smoke:web`: `web_fetch` and DNS-pinned `safe_web_fetch` work; unsafe schemes/private targets fail; Brave and Perplexity search fail explicitly because both credentials are absent |
| Browser | PASS | `npm run smoke:browser`: three actual Chromium calls with assigned profile/session, DOM marker inspection, profile materialization, and close |
| Agent boundaries | PASS | `npm run smoke:agents`: all twelve profiles discovered; Tester/council are read-only, Worker has no shell, autonomous roles have no web tools |
| Guardrails | PASS | `npm run smoke:guardrails`: all 13 direct/symlink/outside/shell/indirection attacks denied with no leak or side effect |
| Verification | PASS | `npm run smoke:verification`: exit 7 and `NO_CHECKS` surface as tool errors and cannot become PASS |
| Notebook/handoff | PASS | `npm run smoke:handoff`: durable marker preserved, editable handoff produced, new session message count zero |
| Bootstrap | PASS | `npm run smoke:bootstrap`: clean temporary HOME, exact packages/runtimes, derived spawn limit 42, all presets/council routes, private policy/backup, no auth created |
| Restore | PASS | `npm run smoke:restore`: original settings restored byte-for-byte; SHA-256 `08288b6b68fad66fa8797adbf8855d8029042b2970edf326d5415bcf22c194cb` |
| Output optimizer | PASS | `npm run benchmark`: 164,450 to 4,836 characters (97.06%); critical diagnostics retained; 17.601 ms mean over 100 runs |
| Trace privacy | PASS | `npm run smoke:trace`: 323 files / 1,543 rows; zero malformed rows, truncated tails, insecure files, forbidden fields, or secret-like values |
| Mission privacy | PASS | `npm run missions:audit`: 18 terminal artifacts, all owner-only, zero detected secret-like values; terminal retention cap 25 |
| Observability | PASS | `npm run observe`: actual current values—0 sources, 0 critical, 0 warnings, 0 bytes; Git changed-path count was 16 at measurement time |

The nested Codex sandbox cannot create localhost listeners, Git subprocesses, or language-server/Bubblewrap namespaces. The required host-context suite passed 216/216; this environmental limitation is not counted as a product pass or failure.

## Preset comparison

`npm run benchmark:models` queried the real Pi registry without inference. Both `openai-codex` and `omniroute` reported authentication present, with eight available models each. Runtime callability remains independent: five selected direct OpenAI models are attested callable; all eight newly catalogued OmniRoute routes are `RUNTIME_UNKNOWN`, so both presets currently resolve to declared direct fallbacks. The route-rate columns sum the registry's published input-plus-output USD-per-million rates for the roles shown; they are not task-cost estimates.

| Preset | Metadata-policy status | Currently selected path rate | Added high-risk/Council rate | Selected models | Selected providers | Live review |
|---|---|---:|---:|---:|---:|---|
| Normal Work (`normal`) | PASS | 123.2 | 191.4 | 5 | 1 | NOT RUN |
| Token Saver (`token-saver`) | PASS | 123.2 | 191.4 | 5 | 1 | NOT RUN |

`normal + auto` is the default. Token Saver's intended Qwen/DeepSeek primaries are present and authenticated through OmniRoute but are not selected until genuine runtime-callability evidence exists; equal current rate figures therefore describe safe fallback state, not equivalent preset policy. Deterministic local providers prove the heterogeneous target mappings and ordered fallback behavior. The `--live` review benchmark was not run because it would consume paid inference, so no cross-provider quality claim is made.

## Context and tool-schema overhead

The last exact provider-reported pre-model/council measurement was:

- no tools: 433 input tokens
- default surface: 4,547 input tokens
- exact default delta: 4,114 tokens
- MCP increment over the pre-MCP measurement: 588 tokens
- WEB increment: 0 default tool schemas
- LSP increment: 0 default tool schemas; `semantic_nav` stays opt-in/lazy

The current zero-cost measurement, `npm run benchmark:context`, runs Pi seven times with a local metadata-only provider and the same tool selections. Pi's actual contexts were inspected without storing their contents:

- no tools: estimated 459 tokens
- default: estimated 5,379 tokens
- estimated delta: 4,920 tokens
- actual default call exposed eight schemas: the configured seven core tools plus Pi's deferred `ask_user_question`
- `secure_coding_workflow` alone: 548 schema characters / estimated 137 schema tokens
- model routing: 0 new default tool schemas (slash commands only)
- council: 0 new default tool schemas (internal to the existing workflow tool)
- structured-output retry fix: 0 new default tools and 0 workflow-schema characters; workflow-only remains 548 characters / estimated 137 tokens
- spawn-budget fix: 0 new tool-schema characters/tokens and 0 additional happy-path model calls; a 100,000/10,000-iteration local microbenchmark measured 0.327 µs for formula+assertion, 6.404 µs for the protected config read, and 6.731 µs combined mean preflight overhead

The estimate uses Pi's documented four-characters-per-token estimator, so it must not be compared numerically as if it were a new provider-billed measurement. The exact seven-call live measurement was not rerun because it would consume additional paid calls. The important structural result is exact: the model/council expansion did not add tools to the default surface.

## Authenticated E2E status

The last fully passing pre-expansion workflow evidence is run `0789657a-a21f-4614-8919-ad88089050b8`; it proves the v4 Worker → Tester → verification → reviewers → correction machinery but not the new model/council receipt integration.

The post-expansion run `c8e1d5ac-4f17-4fd4-a4fa-336de3c0fad9` correctly ended FAIL before Scout admission. Both real Scout child executions completed on `openai-codex/gpt-5.6-luna:low`, but the controller expected `openai-codex/gpt-5.6-luna` plus a separate `low` field and rejected both responses. The run wrote FAIL evidence and cleaned its runtime; it did not become a false positive.

At that stage, the controller was changed to accept the canonical model form or the exact `:thinking` suffix Pi-subagents emits, canonicalize it, store a launch-contract digest, and record every terminal attempt durably. The then-current 77-test suite passed; the present 216-test result is reported in the regression table above.

The explicitly authorized single post-fix run `179bb6f7-414c-4529-baa2-709630b9bac9` nevertheless ended **FAIL**. Scout, Planner, and Oracle completed on the configured `openai-codex/gpt-5.6-luna:low`, `openai-codex/gpt-5.6-sol:high`, and `openai-codex/gpt-6-astra:high` routes. The high-risk council then failed closed before Worker: `gpt-5.4` was rejected by Codex as unsupported with a ChatGPT account; council-1 and the first council-2 attempt were rejected by the child runtime for making no edits even though these are deliberately read-only advisory roles; the second council-2 attempt omitted its required structured-output call. Each council member had two controller-level delegation attempts. Worker, Tester, verification, reviewers, correction, and Judge were therefore not run.

The durable child sessions record 21 provider calls, 47,081 input tokens, 14,080 output tokens, 37,248 cache-read tokens, 10,030 reasoning tokens, 98,409 total reported tokens, and USD 0.7057564. The outer Luna coordinator made two additional calls; its token and cost data were not persisted by the no-session RPC harness. Total model-call count is therefore 23, while the reported token/cost total covers 21 of those calls only. Runtime/worktree/port/process cleanup passed and the temporary repository was removed.

The deterministic defects exposed by that run are now repaired: a three-state callability cache excludes `gpt-5.4` and records the Luna fallback; Council profiles use read-only advisory completion semantics; native per-request schemas plus exact controller/receipt validation fail closed; provider/model/thinking are canonicalized separately; and retry is bounded to transport transients or attested post-launch invalid model output. The local Council path passed 100/100 and the complete planted-correction workflow reached `FINAL` PASS.

A later, separately authorized run `957f5169-5dc6-45f4-a19e-0b15ad77e6f5` progressed through two complete Councils, two Workers, two Testers, two verification PASS results and two review rounds. During escalation of the second blocker, Council-1 and Council-2 of the third Council consumed cumulative session slots 23 and 24. Council-3 needed slot 25, but the static `maxSubagentSpawnsPerSession=24` rejected it before provider launch. The controller then applied route attestation to that non-execution and obscured the original resource-limit error as a route mismatch. The workflow correctly remained FAIL; it was not a validator-only false negative.

The spawn-budget remediation derives 39 base spawns plus a bounded global retry reserve of 3 and configures 42. Authenticated run `ce66f0c2-a157-4017-9ddb-1c5be0dc8d98` then proved that fix in a fresh session: Council-3 completed at slot 25 and two earlier Councils, including two valid Council-2/gpt-5.5 structured results, completed. The E2E still ended **FAIL** because repeated-failure Council-2 at slot 24 was launched on its valid callable route but returned one invalid structured result; the old generic `STRUCTURED_OUTPUT` category did not use the available reserve.

The local fix now separates deterministic pre-launch `STRUCTURED_OUTPUT_POLICY_ERROR` from attested post-launch `STRUCTURED_OUTPUT_MODEL_INVALID`. Only the latter receives one same-route retry, shared with the existing global reserve; a second invalid attempt fails closed. The installed bridge regression proves the invalid→valid path at 32 total spawns and one reserve unit, while double-invalid, malformed-schema, privacy, and 40/41/42/reject-before-fourth controls pass locally. The authenticated result remains **FAIL**. **Post-structured-output-fix authenticated E2E = NOT RUN.**

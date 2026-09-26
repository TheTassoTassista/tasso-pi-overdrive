# Pi 0.87.1 compatibility and GPT-6 runtime evidence

Recorded 2026-09-26 UTC. This is evidence for the reviewed Linux host, not a blanket claim about other accounts or future catalog availability.

## Runtime selection

- Previously active Pi: `@earendil-works/pi-coding-agent@0.85.1` in the owner's Node 22.23.2 user-local prefix.
- Isolated candidate: `@earendil-works/pi-coding-agent@0.87.1`, installed under a temporary root with `--ignore-scripts`. The published changelog explicitly adds GPT-6 Luna/Sol support for OpenAI Codex subscriptions. The package's bundled `pi-ai@0.87.1` catalog contains all three GPT-6 IDs under `openai-codex`.
- The complete Expansion package loaded via isolated Pi RPC after its existing lockfile-pinned MCP runtime was materialized. `get_commands` exposed the Overdrive commands and skills. TypeScript against the candidate and the full `npm run check` gate passed after the host-binary pin refresh.
- Pi 0.87 providers receive normalized transcript context. The production Overdrive provider does not implement a custom stream; deterministic test providers were updated to read prompt/tool declarations from either the old top-level context or the new system-message transcript. The notebook/handoff smoke and Director benchmark pass on Pi 0.87.1 after this test-only adaptation.

## Minimal authenticated calls

Each probe used the isolated Pi executable, `--provider openai-codex`, the existing subscription-backed authentication, one `--print` request, `--no-tools`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-context-files`, and `--no-session`. OpenAI and Azure API-key environment variables were removed for these processes. No API-key route, retry, repository edit, or credential-store edit was requested.

| Model | Pi thinking | Result | Input | Output | Cache read/write | Reasoning tokens | Pi nominal cost field (USD) |
|---|---|---|---:|---:|---:|---:|---:|
| `openai-codex/gpt-6-luna` | low | `stop` | 422 | 5 | 0 / 0 | 0 | 0.0000447 |
| `openai-codex/gpt-6-sol` | medium | `stop` | 422 | 5 | 0 / 0 | 0 | 0.0008940 |
| `openai-codex/gpt-6-astra` | high | `stop` | 422 | 5 | 0 / 0 | 0 | 0.0044700 |

The total of the three Pi nominal cost fields is USD 0.0054087. These fields estimate token price; they are **not evidence of a separate bill** on the Codex subscription route. The calls establish runtime callability for these exact provider/model/effort tuples only. No independent billing-statement check was performed.

## Regressions found and resolved locally

- Five of 519 initial unit tests failed because the host system upgrade changed `/usr/bin/node` from 26.8.1 to 26.8.2 and `/usr/bin/prlimit` from util-linux 2.42.3 to 2.42.4. Persistent Eval correctly failed closed on digest mismatch. The exact canonical binaries, modes, single-link status, versions, and new SHA-256 digests were checked; only the reviewed pins and corresponding validation/docs were changed. The seven focused eval tests then passed, including process-denial and network/file isolation.
- The notebook/handoff smoke failed on Pi 0.87.1 because its deterministic provider looked for `context.tools`. Pi now puts tool declarations on transcript system messages. A shared fixture adapter and two regression tests cover legacy and normalized forms; notebook/handoff and Director subsequently passed. No production route, provider, or permission was loosened.

## Scope limits

The direct call probes did not exercise a full authenticated autonomous workflow or establish OmniRoute billing/callability. Council-2 therefore retains its existing safe direct fallback. Historical Pi 0.85.1 benchmark result files remain historical measurements and were not silently relabeled as 0.87.1 results. Any new system package update may invalidate exact Persistent Eval (and other pinned runtime) digests again, which must fail closed until separately re-attested.

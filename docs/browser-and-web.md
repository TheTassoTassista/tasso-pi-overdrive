# Browser and web workflows

Use `web_search` to discover current sources only after configuring a provider credential, `web_fetch` to read public pages without credentials, and `agent_browser` only when rendered DOM, interaction, screenshots, downloads, authenticated state, or browser-specific behavior matters.

Search routing is explicit and observable through `web_research`: ordinary calls omit `provider` and use Brave; an error or result count below `min_results` triggers the Perplexity fallback. High-stakes research uses `mode: "cross-check"` to query both independently and deduplicate before fetching primary sources. A known URL goes directly to `safe_web_fetch`. An explicit `provider` override never falls back. Every successful routed call reports `requested_provider`, `selected_provider`, `fallback_used`, `search_mode`, and per-provider attempt status without credential data. The package's original `web_search` and `web_fetch` remain available for compatibility and direct-provider diagnostics; no conflicting override hook is installed.

Search credentials are opt-in. No key is stored in this repository. Export `BRAVE_SEARCH_API_KEY` and `PERPLEXITY_API_KEY` in the environment that launches Pi, or use `/web-tools` once for each provider; its owner-only file preserves both keys when switching. Environment values take precedence. Never paste keys into prompts or repository files. The tracked policy is merged without touching `apiKeys`, is reversible, and keeps later user provider choices. `web_fetch` rejects loopback, private-network, metadata, and non-HTTP(S) targets.

Actual precedence in `@juicesharp/rpiv-web-tools@2.9.0` and the Overdrive router is: per-call `provider` for provider selection, then `WEB_SEARCH_PROVIDER`, then user config `provider`, then Brave. For each provider, its environment variable wins over `apiKeys.<provider>`; only Brave then checks the legacy top-level `apiKey`. There is no OS keyring in this package version. `/web-tools` stores provider keys in its owner-only user config, never in the Overdrive repository. `/web-status` reports only configured/missing plus the non-secret source tier.

`safe_web_fetch` is the dedicated controlled network runner. It accepts only credential-free HTTP(S) URLs, resolves and validates every hop, rejects any private/reserved answer, pins the chosen public address into the socket lookup to reduce DNS-rebinding/TOCTOU exposure, follows at most five redirects, blocks HTTPS downgrade, caps time at 20 seconds, headers at 16 KiB, body at 2 MiB, and extracted output at 64 KiB. It requests identity encoding, accepts text/JSON/XML only, strips active HTML blocks, and replaces remote exception bodies with fixed error messages. Search endpoints are fixed by the pinned provider package, time-limited, result-bounded, and globally capped with fetch to two concurrent network operations. Worker and Tester receive none of the four web tools; their command sandbox remains network-disabled.

Run `npm run smoke:web` for both compatibility and hardened public fetches, provider-runtime loading, `/web-status`, SSRF/scheme rejection, and provider-specific missing-key behavior. Deterministic tests cover environment/config precedence, only-one/both/neither credentials, weak-result fallback, explicit override, invalid providers, cross-check concurrency/deduplication, timeout, redirect bounds, oversized and malformed responses, unsupported content, and sanitized errors. After both credentials are configured, `npm run smoke:web -- --credentialed` performs bounded real Brave and Perplexity calls and verifies the reported backend.

Browser default:

1. Open a page in a fresh isolated session.
2. Take an interactive snapshot.
3. Act only on current refs or stable semantic locators.
4. Snapshot after navigation or DOM mutation.
5. Verify requested artifacts exist before claiming success.
6. Close the managed session after the task.

In an Overdrive runtime allocation the safety hook requires the exact assigned `--session` and, on launch, the exact assigned `--profile` with `sessionMode=fresh`. Browser traffic is intentionally not Bubblewrap-network-isolated; profile/state isolation and the browser tool's own URL policy are the applicable boundaries.

Do not select a personal Chrome/Zen profile by default. For signed-in work, ask the user to authorize the profile boundary and assume visible page content can enter model context. The installed Zen browser is Firefox-based and is not used as a Chromium executable.

For local UI tests, start the application on a worktree-unique port, restrict the browser to the expected domains when practical, and save screenshots under the active repository or an explicitly approved artifact directory.

# Φ Phi

An intelligent coding system powered by the Pi runtime. Phi combines efficient GPT-6 routing, governed tools and delegated roles, isolated coding worktrees, verifiable reviews, and a local-first Second Brain.

The product is **Phi**. The command is **`phi`**. Pi is the underlying runtime, not a second application you need to configure independently.

## Current support

The complete coding engine is verified on Linux x86_64. Native Windows portability is being implemented in this same repository; **Windows autonomous execution is currently blocked**, not run unsandboxed. No WSL is required or proposed. See [platform status](docs/phi-platform-matrix.md) and [progress](docs/phi-progress.md) for the exact checkpoint.

Phi 1.0.0 uses pinned Pi 0.87.1 and Node >=22.19.0. It is private/unpublished; this is not a published cross-platform release.

## Start and customize

From the source checkout with the existing verified Linux Pi installation:

```sh
node bin/phi.mjs doctor
node bin/phi.mjs
node bin/phi.mjs --theme aurora
node bin/phi.mjs theme set gold
```

The installer for the short `phi` command is the next migration checkpoint. Until then, the direct Node entry point is equivalent and does not change your existing `pi` command, credentials or routing.

Built-in themes: `aurora`, `cyber`, `gold`, `gothic`, `mono`. Themes are local preferences. `NO_COLOR`, non-interactive output, narrow terminals and ambiguous Unicode consoles have readable fallbacks. RPC/print protocol output never gets a splash injected into it.

## Doctor

`phi doctor` reports platform, source/runtime versions, local configuration, model default, optional service availability and platform limitations. It makes no model calls, never opens authentication stores, and never prints config secrets. A configuration check is not proof of live provider callability or sandbox parity; Doctor explicitly distinguishes these.

## Daily workflow

Start in your project Git checkout. Use `/preset normal` and `/quality auto` for normal work; `/preset token-saver` for quota-sensitive work. `/ai-tree` shows exact role routes without inference. Use the governed `secure_coding_workflow` for substantial autonomous tasks, `verification_gate` for verified completion, `/notebook` for durable task state and `/handoff` for a fresh context.

The ordinary interactive default is subscription-backed GPT-6 Sol with medium thinking. Luna is used for lightweight work, Sol for normal coding/review, and Astra for bounded difficult Oracle/Judge work. Council diversity remains conditional on proven zero-extra-cost callability; Council-2 retains its verified safe fallback. The Phi migration does not alter these routes.

Task, Tool and Context Governors remain authoritative. Worker execution stays sandboxed and worktree-isolated; Tester, Council and reviewers remain read-only. Concurrency 3, depth 1, correction rounds 2 and spawn envelope 42 are unchanged. Trusted in-process plugins are not an OS sandbox.

## What stays private

Git contains product source, policies/templates, deterministic tests, branding and reconstruction scripts. Authentication, OAuth tokens, provider keys, browser profiles, private memory databases, caches and raw runtime logs remain local. No API-key billing is introduced. Optional memory/search/router services are lazy/fail-soft and must not make hidden inference calls.

## Install and recovery status

A full clean-machine Phi bootstrap and native Windows confinement are **not yet validated**. Do not wipe your current machine based on this checkpoint. The verified legacy Linux installation remains intact while tracked portable reconstruction is completed. Recovery instructions and CI evidence will be added as each platform is actually validated; no untracked local dependency will be labelled portable merely because it exists on the development host.

## Contributor checks

```sh
npm run check:phi
PI_OVERDRIVE_LSP_RUNTIME="$PWD/runtime/lsp" npm run check
```

The complete Linux gate remains mandatory, alongside the new portable foundation tests. Historical technical documents retain legacy names where they describe compatibility internals or audit history; the protected user audit is never rewritten by the migration.

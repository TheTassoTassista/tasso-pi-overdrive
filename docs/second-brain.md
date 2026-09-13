# Second Brain

## Scope and invariants

The Second Brain is an additive, fail-soft memory layer. It does not replace Pi sessions, the task notebook, native compaction, the Token Governor, model routing, secure workflow state, or deterministic source inspection. If every memory backend is unavailable, Pi continues as ordinary hardened Pi Overdrive.

No model/provider route, fallback, retry, Council fan-out, spawn limit, LSP, MCP, launcher, usage accounting, or sandbox policy is owned by this subsystem. Memory text is always untrusted evidence. It cannot authorize tools, commands, network access, model changes, or writes.

```text
task
  └─ current-context check
       └─ deterministic Memory Router
            ├─ OpenViking: project context (L0 → L1 → one selected L2)
            ├─ Hindsight: temporal Recall; explicit/conditional Reflect
            └─ ACE: reusable working lessons
                  ↓
          trust/currentness/relevance filter
                  ↓
          one bounded Shared Memory Pack
                  ↓
          existing Token Governor → agents

verified event / explicit user memory / marked Obsidian note
  └─ Curator → local provenance ledger / ACE playbook
                 └─ optional upstream projection by an explicit operator action
```

## Why direct adapters are used

OpenViking’s official Pi integration performs automatic recall before each prompt, captures turns, and can take over compaction. Those defaults conflict with this project’s conditional Router, curated write policy, no-transcript rule, existing handoff/compaction, and one-pack-per-workflow invariant. Pi Overdrive therefore uses OpenViking’s official REST surface directly: `POST /api/v1/search/find`, followed only when requested by one exact `GET /api/v1/content/overview` or `GET /api/v1/content/read`. The reviewed API contract is OpenViking `0.4.19`. See the official [Pi integration](https://docs.openviking.ai/en/agent-integrations/11-pi), [retrieval API](https://github.com/volcengine/OpenViking/blob/main/docs/en/api/06-retrieval.md), and [context layers](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/03-context-layers.md).

Hindsight is likewise accessed through its official REST contract instead of an auto-retain agent plugin. Recall uses `POST /v1/default/banks/{bank}/memories/recall`; Reflect uses `POST /v1/default/banks/{bank}/reflect`. The reviewed [release](https://github.com/vectorize-io/hindsight/releases/tag/v0.9.2) is `0.9.2`; its server API contract remains `0.9.0`. [Recall](https://hindsight.vectorize.io/developer/api/recall) returns evidence through semantic, keyword, graph, and temporal retrieval. [Reflect](https://hindsight.vectorize.io/api-reference) performs additional synthesis and is consequently never the default.

No OpenViking or Hindsight client library is added. This keeps the Pi schema/startup surface small, avoids upstream auto-update behavior, and follows Hindsight’s own demonstrated pattern of a small `fetch` client for coding-agent integration. The adapters are isolated in `lib/memory-backends.mjs` and can be replaced if the reviewed HTTP contracts change.

## Read path

The Router uses deterministic intent signals only:

- exact edit with enough supplied context: no retrieval;
- current project/code/docs/architecture: OpenViking plus the local curated ledger;
- history, old decision, cause/effect, or “why before”: Hindsight Recall plus historical ledger entries;
- working method, lesson, trap, or best practice: ACE;
- a mixed question: only the matching sources.

It does not make an LLM call. Backend requests run in parallel with 750 ms defaults and return `DEGRADED` rather than throwing into Pi.

OpenViking detail levels mean exposure depth, not enablement:

- L0: search result abstract/index. This is the default discovery level.
- L1: the overview of one selected URI.
- selected L2: full content of exactly one selected URI. It is allowed in Token Saver when that exact read avoids broad source loading.

There is no broad automatic L2 fan-out. A role can make a targeted extra retrieval only through the controller’s exact-source interface; normal role prompts do not receive a general memory command executor.

Hindsight Recall is available when temporal intent exists. Reflect additionally requires historical synthesis intent, a policy that permits it, and explicit authorization at the adapter boundary. Token Saver low/medium suppress Reflect. Token Saver high/max keeps only an exceptional capability flag; it still cannot run without explicit authorization.

## Shared Memory Pack

`SharedMemoryPackController` caches by task, project, policy, and requested detail. One immutable pack is produced for the secure workflow and reused by Scout, Planner, Oracle, Worker, Tester, reviewers, Council members, and Judge. Council members receive the same pre-task evidence but never one another’s output; the Judge still starts only after three valid independent results.

Candidates are deduplicated and ranked by relevance, currentness, verification, and trust. The pack is fitted to the effective character budget before model exposure. It includes provenance and a hard trust label. Stored `<` and `>` are escaped, command-shaped text is inert, and the wrapper states that memory cannot override system/user policy, safe-exec, sandboxing, model policy, or workflow controls.

Project scope is derived from the canonical Git common directory, so the main checkout and its linked worktrees share one project identity. Non-Git directories fall back to a canonical-path identity.

The pack itself is not persisted in metadata traces or workflow receipts. Only its digest, route, counts, character size, estimated token size, degradation count, and latency are retained.

## Write path and Curator

Durable writes are narrow:

- `/memory remember TEXT` records an explicit user decision;
- `/memory learn PROCEDURE` records an explicit reusable ACE lesson;
- `/memory sync` reads only Obsidian notes marked `memory: true`;
- reviewed deterministic producers may submit a structured verified event through the Curator API.

Ordinary model turns and workflow task prompts are not retained. Raw transcripts, short scratch fragments, invalid types, and secret-bearing values are rejected. Accepted entries preserve `id`, type, project/scope, timestamps, source/source type, trust, confidence, verification, importance, expiry, tags, reason, canonical hash, and superseding links.

Duplicate hashes prevent retrieve/repeat/write amplification. Superseding marks the old fact non-current and links both directions; it does not destroy history. Current search suppresses superseded or expired records, while historical search can return them. Expiry is retrieval suppression, not deletion.

Trust ranking is `VERIFIED` > `USER` > `PROJECT_DOC` > `INFERRED` > `EXTERNAL`. Verification and currentness add separate ranking weight. A newly generated inference therefore cannot outrank an otherwise comparable current verified fact.

The local JSON ledger is a curation/provenance control plane and offline fallback, not a new semantic vector database. Files are exportable, owner-only JSON written atomically. OpenViking remains primary semantic context and Hindsight remains temporal memory when their optional services are available.

## ACE playbook

ACE is implemented as a small incremental playbook, inspired by the generator/reflector/curator separation in [Agentic Context Engineering](https://github.com/ace-agent/ace). Each entry is a reusable procedure or a failed strategy with its failure reason and applicability conditions. Entries retain project, source, trust, verification, tags, timestamps, and use metadata. Exact duplicates and transcript dumps are rejected; the playbook is capped at 128 entries by default and retrieval returns only a compact relevant subset.

ACE does not run a model to regenerate itself after a task. A new lesson enters only through an explicit user action or future verified deterministic producer. This preserves reproducibility and prevents self-amplifying summaries.

## Token Governor composition

Memory policy consumes the already resolved preset and effective quality. It does not mutate model routing.

| Mode | Cheap candidate search | Final pack | Hindsight Reflect | Detail |
|---|---:|---:|---|---|
| token-saver + low | up to 24 | 900 chars | suppressed | L0/L1/selected L2 |
| token-saver + medium | up to 32 | 1,400 chars | suppressed | L0/L1/selected L2 |
| token-saver + high | up to 44 | 2,200 chars | exceptional + explicit | targeted |
| token-saver + max | up to 56 | 3,000 chars | exceptional + explicit | broader but bounded |
| normal + low | up to 12 | 1,400 chars | suppressed | compact |
| normal + medium/auto | up to 20 | 2,600 chars | suppressed | balanced |
| normal + high | up to 32 | 4,200 chars | conditional + explicit | broader targeted |
| normal + max | up to 44 | 5,600 chars | conditional + explicit | maximum useful, never all memory |

Token Saver deliberately searches more local candidates while exposing fewer characters. Low quality is not “memory off.” Max is not “load everything.” All modes stop when the bounded useful set is sufficient.

Token counts displayed by this feature are labeled estimates using `ceil(characters / 4)`; no tokenizer is claimed. Backend/service usage is separate from model input token accounting. Hindsight may itself use configured inference for retain/recall/reflect; that external usage is unavailable unless the service reports it and is never invented as zero.

## Obsidian

The machine layer works without Obsidian. `npm run setup:memory` creates an owner-only, portable Markdown vault at:

```text
${XDG_DATA_HOME:-~/.local/share}/pi-overdrive/second-brain/vault/SecondBrain
```

The seed contains an Inbox, project Overview/Architecture/Current State notes, the suggested top-level folders, templates for decisions/lessons/research, and minimal `.obsidian/app.json`. Existing notes are never overwritten. No API token is written to Markdown.

`/memory sync` is explicit and mtime-based. It follows no symlinks and imports only frontmatter-marked notes. Human notes become searchable immediately through the local curated ledger with `USER` or `PROJECT_DOC` provenance. Projection into an external OpenViking/Hindsight service is intentionally not automatic because ingestion can invoke embeddings or provider-backed extraction. That projection remains an operator-controlled external step and is a documented limitation.

Obsidian `1.13.7-2` was already installed on the audited host. Pi Overdrive installs no community plugin. The official Hindsight Obsidian plugin is beta/BRAT-installed and defaults require separate configuration, so it is not enabled automatically. The only manual UI step is: in Obsidian, choose “Open folder as vault” and select the path printed by `npm run setup:memory`.

## Security and filesystem guarantees

- Tracked configuration contains endpoints and reviewed API contract versions, never credentials.
- Optional credentials are read only from `OPENVIKING_API_KEY` or `HINDSIGHT_API_KEY` at request time.
- Endpoints must be plain HTTP on `127.0.0.1`, `localhost`, or `::1`; remote/cloud endpoints are rejected by configuration validation.
- Storage paths are canonicalized. Existing/missing path components are checked, symlink ancestors are rejected, and vault walks reject symlinked files/directories.
- Reads use `O_NOFOLLOW`; durable files must be regular, single-link, owner-only files.
- Writes use a random exclusive owner-only temporary file, `fsync`, same-directory rename, directory `fsync`, and a parent realpath recheck to narrow TOCTOU exposure.
- Secret-shaped candidates are rejected before writes. Command output and traces omit paths, URLs, payloads, prompts, memory content, and credentials.
- Retrieved text is JSON encoded inside an explicit untrusted-data boundary; tag-like delimiters are escaped.
- No retrieved string is passed to a shell or executable. Existing safe-exec and sandbox enforcement remain the only autonomous command path.

As with all user-space path checks, a malicious process running concurrently as the same Unix user can race some filesystem operations outside the available Node APIs. The implementation narrows this with no-follow descriptors, single-link checks, atomic rename, and canonical parent rechecks; stronger hostile-same-user isolation requires a different OS account or container.

## Failure behavior

OpenViking down, Hindsight down, ACE/ledger unwritable, Obsidian closed, or all backends down produce empty/partial packs plus metadata-only degradation events. No backend failure blocks Pi startup or the secure coding workflow. Startup creates no service, subprocess, GUI, watcher, or network connection; retrieval is lazy.

The extension does not install or start OpenViking/Hindsight daemons. To enable them, operate reviewed versions separately, bind them to loopback, supply their model/embedding providers explicitly, and keep their data/backups under user control. Their inference/storage requirements are external operational dependencies, not hidden Pi package dependencies.

The reviewed optional service packages are `openviking==0.4.19` and `hindsight-api==0.9.2`. Install them in a dedicated user-owned virtual environment only after choosing their provider/storage configuration; Pi Overdrive deliberately does not guess or copy credentials. Start OpenViking with an explicit `--host 127.0.0.1 --port 1933` override and Hindsight with `--host 127.0.0.1 --port 8888`, then verify each `/health` endpoint. OpenViking requires configured VLM and embedding capabilities; Hindsight retain/reflect can use its configured LLM and may therefore incur provider usage. Neither service is required for the local ledger, ACE, commands, vault, or ordinary Pi startup.

## Commands

```text
/memory
/memory-status
/memory-search project architecture
/memory-recent
/memory-why mem-0123456789abcdef
/memory remember Keep release tags immutable after publication.
/memory learn Run deterministic cross-file LSP checks before AI review.
/memory sync
/ai-tree
```

Status, recent, why, sync, and ordinary search do not call a Pi model. Search can call optional local memory services; Hindsight server operations may use whatever inference that service’s operator configured. `/ai-tree` contains a small Second Brain branch and remains a zero-model-call routing view.

## Observability

The existing metadata trace accepts only scalar memory metadata: router decision, backend/status, retrieval levels/counts, latency, pack characters, approximate tokens, write acceptance, dedupe/superseding flags, Recall/Reflect booleans, ACE count, sync counts, and degradation count. It never records queries, prompts, memory bodies, source paths, endpoint URLs, API keys, or service responses.

## Backup, export, and recovery

Stop Pi before a consistent manual backup, then copy the Second Brain root preserving modes. The canonical human projection is Markdown; curation and ACE are documented JSON. OpenViking and Hindsight data must be exported with their reviewed upstream tools because Pi Overdrive does not own those stores. Restoring the local root restores ledger, ACE, vault, and sync index without touching Pi authentication.

## Verification and benchmark

- `npm run check`: all deterministic project tests, syntax, TypeScript, and package/secret validation.
- `npm run smoke:memory`: actual Pi RPC command registration plus all-backends-down and local-fixture behavior; zero model/provider calls.
- `npm run benchmark:memory`: three deterministic fixture scenarios comparing exact character volume and explicitly estimated token volume.
- `npm run setup:memory`: idempotent owner-only vault setup; no service/model call.

No authenticated inference is required by any Second Brain test.

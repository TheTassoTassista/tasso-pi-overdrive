# MCP integration

Pi Overdrive loads one `mcp` proxy tool through `pi-mcp-adapter` 2.32.1 from audited upstream commit `8243eba3421e301c88c047444f34ab7d5d57163e`. The published 2.32.1 package predates Pi 0.85 compatibility; the pinned upstream commit changes the peer range to `^0.84.1 || ^0.85.0`. The runtime is tracked under `runtime/mcp`, installed from HTTPS by bootstrap, and locked transitively. A Hono 4.13.5 override removes the moderate advisory present in the unmodified dependency tree.

Only the official Upstash Context7 remote server is enabled. It supplies current library documentation that local FFF, ripgrep, ast-grep, Git, browser, and web tools do not provide. Its allowlist is exactly `resolve-library-id` and `query-docs`; both are read-only. Direct MCP tools, resources, script mode, sampling, elicitation, ambient host-config discovery, and automatic OAuth are disabled. The server starts lazily and disconnects after five idle minutes.

Use the compact tool with `tool: "context7_resolve-library-id"` or `tool: "context7_query-docs"` and an `args` object. Discovery/listing remains inside the same proxy schema. There are no MCP credentials for Context7. Future authenticated servers must use the adapter's OS keyring or environment references, never repository JSON.

The global default requires approval. Context7 has a narrow read-only exception. Every future mutating server must keep `approveTools: true`; destructive, publish, deploy, account, database-write, and external-state mutations require an explicit user decision. The autonomous workflow tool surface does not include MCP, so Worker, Tester, and reviewers cannot use it as a sandbox escape.

MCP traces are written to the owner-only `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/mcp-traces/mcp.jsonl`. They contain transport metadata such as method, status, byte count, server, and duration—not arguments, responses, URLs, prompts, file contents, or secrets. Output is bounded to 64 KiB/800 lines and details to 8 KiB.

Verification commands:

```bash
npm run smoke:mcp
npm run smoke:mcp -- --online
npm audit --prefix runtime/mcp --omit=dev
```

The local smoke uses an isolated deterministic MCP server. It denies a mutating call through the real Pi RPC approval channel, proves no side effect occurred, rejects an excluded tool, and scans the trace for raw sentinels/results. Online mode additionally performs a real Context7 TypeScript documentation lookup and observes its lazy connection transition.

Not installed: Notion and Figma require account-scoped OAuth and expose mutation; Linear, Sentry, and databases add broad account-specific schemas and mutation risk; filesystem, Git/GitHub, browser, generic search, and AST MCPs duplicate existing tools. Reconsider a candidate only for a concrete project, audit its exact release, expose a minimal include-list, and measure the resulting context before enabling it.

# Observability and tracing

`pi-observability` is the single agent statistics extension. Its minimal preset keeps the footer quiet while `/obs` exposes the model, context and token usage, cache data, cost and timing when the provider reports them, tool activity, failures, and Git state.

The local metadata tracer complements that dashboard with owner-only JSONL under `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/traces/`. Rows may contain timestamps, event names, model identifiers, tool names, argument key names, durations, success flags, and context counts. They never contain prompt text, argument values, tool output, URLs, environment values, or credentials.

Use `/trace-path` to locate the current log. Preview cleanup with `scripts/cleanup-traces.sh`; use `--apply` only after reviewing the exact retention scope. This is operational evidence, not an automatic memory store.

Future applications should expose concise, project-local evidence: structured application logs, test reports, browser console/network failures, CI artifacts, and small performance summaries. Keep raw payloads out of the permanent agent trace; fetch a narrow relevant range when diagnosing.

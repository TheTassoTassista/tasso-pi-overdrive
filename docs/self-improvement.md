# Bounded self-improvement

Improvements are evidence-driven configuration changes, not autonomous mutation.

After a real task, inspect only metadata and explicit outcomes:

- Which tool outputs were repeatedly compacted?
- Which agent handoffs lacked a required fact?
- Which verification check caught a defect late?
- Did a model tier add value proportional to latency/cost?
- Did context cross 70% or 85%, and why?

Propose one small change with a hypothesis and measurable acceptance criterion. Apply it manually to this package, run the deterministic checks plus a representative smoke, and update the implementation log. Do not mine raw prompts, copy repository content into telemetry, auto-install packages, change model routing, or schedule background work from these observations.

Delete stale metadata only through the dry-run-first cleanup script. Retain no browser/profile or MCP payload logs as performance telemetry.

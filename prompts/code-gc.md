---
description: Find removable code and maintenance debt without changing files
argument-hint: "[scope]"
---
Run a read-only code garbage-collection audit over ${@:-the repository}. Look for dead code, unused dependencies, duplicate utilities, stale TODOs, architecture violations, repeated patterns, oversized files, and weak coverage. Prove each candidate with references, callers, tests, and build metadata. Return safe deletion candidates separately from uncertain follow-ups; do not edit or schedule background work.

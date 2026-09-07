---
description: Audit documentation for staleness and code drift without changing files
argument-hint: "[scope]"
---
Run a read-only documentation garden over ${@:-the repository}. Check broken local links, obsolete commands, stale version claims, code/documentation mismatch, duplicated guidance, and missing ownership or verification notes. Validate claims against current code and config. Return a prioritized report with file/line evidence and the smallest proposed edits; do not edit or schedule background work.

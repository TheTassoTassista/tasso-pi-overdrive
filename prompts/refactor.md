---
description: Perform a behavior-preserving refactor with explicit invariants
argument-hint: "<target and intent>"
---
Refactor: ${@:-describe the target}.

Scout callers and tests. Planner must state preserved behavior and invariants before edits. Establish baseline checks, make the smallest staged refactor, and avoid unrelated cleanup. Use AST preview for structural changes. Run the same checks after the change, then correctness and simplicity reviews. Report proof of behavior preservation and any gap.

---
name: writing-tests
description: Design stable tests that prove behavior and prevent regressions. Use when adding tests, diagnosing gaps, or building verification for a change.
---
# Writing Tests

Test observable contracts and invariants, not incidental implementation. Start with the failure or acceptance criterion the test must prove.

Choose the lowest layer that exercises the real risk. Keep fixtures minimal, deterministic, isolated, and readable. Control time, randomness, network, environment, and global state. Include meaningful negative and boundary cases.

Confirm a regression test fails for the intended reason before the fix when feasible, passes after it, and does not pass because assertions are too weak.

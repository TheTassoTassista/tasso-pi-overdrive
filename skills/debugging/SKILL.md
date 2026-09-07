---
name: debugging
description: Systematically reproduce, localize, and fix software defects. Use for crashes, regressions, flaky tests, wrong output, or unexplained failures.
---
# Debugging

Write down expected versus observed behavior and the smallest reliable reproduction. Capture versions and exact failure evidence.

Trace the failing path from input to effect. Form one falsifiable hypothesis at a time and choose the cheapest observation that distinguishes it. Do not patch symptoms before locating the violated invariant.

Add a regression test or durable check, implement the minimal root-cause fix, rerun the original reproduction, and test adjacent edge cases. Report remaining uncertainty.

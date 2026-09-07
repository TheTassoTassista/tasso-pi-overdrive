---
description: Diagnose and fix a bug with a regression test and verification evidence
argument-hint: "<symptom or issue>"
---
Goal: ${@:-describe the observed bug}.

Reproduce or establish the failure with evidence. Scout the smallest relevant code path, identify root cause rather than symptoms, and record assumptions. For a non-trivial fix, have the planner define acceptance criteria before implementation. Add or update a regression test that fails for the original defect, implement the minimal fix, run targeted checks and the verification gate, then ask the correctness reviewer to try to disprove the fix. Address blocking findings and verify again.

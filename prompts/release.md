---
description: Prepare a release with clean state, changelog, checks, and rollback notes
argument-hint: "[version or release goal]"
---
Release goal: ${@:-prepare the current project for release}.

Read the repository's release instructions first. Confirm version, branch, working-tree state, changelog, generated artifacts, dependency lock state, and CI expectations. Run the prescribed verification without publishing or pushing unless explicitly authorized. Produce a release checklist, real evidence, rollback notes, and any blocker.

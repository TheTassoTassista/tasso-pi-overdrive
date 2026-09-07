---
description: Plan and execute a reversible migration with validation and rollback
argument-hint: "<migration goal>"
---
Migration: ${@:-describe source and target}.

Inventory current format, consumers, compatibility constraints, and data volume. Define preconditions, staged rollout, validation queries/checks, rollback, and backup before mutation. Rehearse on disposable data when possible. Implement idempotently, verify old and new paths, and report what was migrated, what remains, and how to roll back. Never invent migration success.

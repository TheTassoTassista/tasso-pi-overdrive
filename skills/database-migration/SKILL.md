---
name: database-migration
description: Plan, implement, and verify safe database schema or data migrations. Use for migrations, backfills, compatibility windows, or rollback planning.
---
# Database Migration

Inspect the actual schema, migration framework, deployment order, data volume, constraints, and consumers. Define forward and rollback behavior before mutation.

Prefer expand/migrate/contract for live systems. Make steps idempotent where practical, bound locks and batches, preserve old-reader/new-writer compatibility during rollout, and validate data invariants.

Test against disposable data and verify both schema and application behavior. Never run a production migration or destructive rollback without explicit authorization and a backup/recovery path.

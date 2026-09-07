---
name: dependency-upgrade
description: Safely evaluate and perform dependency upgrades. Use for package bumps, vulnerability remediation, lockfile changes, API migrations, or toolchain updates.
---
# Dependency Upgrade

Identify the direct package, current/target versions, package manager, constraints, and why the upgrade is needed. Read official changelog, migration notes, security advisories, and package manifest before installation.

Review lifecycle scripts, provenance, license, native components, transitive changes, and compatibility. Pin exact versions where reproducibility matters. Do not downgrade behavior to satisfy stale types.

Change the smallest manifest/lock scope, run install with repository-approved script policy, inspect the diff, and verify affected behavior plus standard checks.

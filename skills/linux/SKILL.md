---
name: linux
description: Diagnose and automate Linux systems safely. Use for shell, services, packages, permissions, processes, filesystems, desktop integration, or distribution-specific work.
---
# Linux

Detect distribution, package manager, init system, shell, architecture, and privilege boundary before acting. Prefer read-only evidence first and distribution-native tooling.

Quote paths, use explicit targets, avoid recursive/destructive commands, preserve user configuration, and back up files before modifying them. Never read or print secrets to diagnose unrelated behavior.

For services, inspect status and logs before restart. For system packages, explain the exact package set and require normal privilege authorization; never collect an administrator password.

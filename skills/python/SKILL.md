---
name: python
description: Implement, debug, type-check, and test Python projects. Use for Python source, packaging, virtual environments, pytest, typing, or Python performance work.
compatibility: Python 3; follows the repository's existing toolchain.
---
# Python

Read `pyproject.toml`, lockfiles, supported versions, and nearby tests before changing code. Use the existing environment manager; do not create a second one. Preserve public behavior unless the task changes it.

Prefer explicit types at boundaries, context managers for resources, narrow exceptions, and deterministic tests. Avoid mutable defaults, import-time side effects, and blocking work inside async paths.

Verify the smallest relevant subset first, then the repository's configured formatter/linter/typechecker/tests. If no test runner is configured, at least run `python -m compileall` on changed modules and report the limitation.

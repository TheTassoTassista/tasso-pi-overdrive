---
name: typescript
description: Implement and review TypeScript or JavaScript with repository-aware types, package scripts, runtime boundaries, and tests. Use for TS, JS, Node.js, or web packages.
---
# TypeScript and JavaScript

Read `package.json`, lockfile, tsconfig variants, module type, and local patterns. Use the existing package manager. Inspect dependency types instead of guessing APIs.

Keep runtime validation at untrusted boundaries; TypeScript types are not validation. Avoid `any`, unsafe assertions, hidden promise rejection, and unbounded parallelism. Preserve ESM/CJS conventions.

Run targeted tests, typecheck, lint, formatting check, and build scripts that exist. Do not run install or lifecycle scripts merely to silence a type error.

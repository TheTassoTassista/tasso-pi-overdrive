#!/usr/bin/env node
process.stdout.write(`${JSON.stringify({ type: "ready", language: "python", protocol: 1 })}\n`);
process.stdin.once("data", () => process.exit(23));

#!/usr/bin/env node
import { auditRuntimeState, createRuntimeWorktree, findRuntimeAllocation, listRuntimeAllocations, recoverStaleRuntimeAllocations, releaseRuntimeResources } from "../lib/runtime-isolation.mjs";

const [command, target] = process.argv.slice(2);
try {
  if (command === "create" && target) process.stdout.write(`${JSON.stringify(await createRuntimeWorktree(target))}\n`);
  else if (command === "lookup" && target) process.stdout.write(`${JSON.stringify(findRuntimeAllocation(target) ?? null)}\n`);
  else if (command === "list") process.stdout.write(`${JSON.stringify(listRuntimeAllocations())}\n`);
  else if (command === "audit") process.stdout.write(`${JSON.stringify(auditRuntimeState(), null, 2)}\n`);
  else if (command === "recover") process.stdout.write(`${JSON.stringify(recoverStaleRuntimeAllocations(), null, 2)}\n`);
  else if (command === "release-runtime" && target) process.stdout.write(`${JSON.stringify(releaseRuntimeResources(target))}\n`);
  else {
    process.stderr.write("usage: worktree-runtime.mjs create REPO | lookup CWD | list | audit | recover | release-runtime ALLOCATION_ID\n");
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

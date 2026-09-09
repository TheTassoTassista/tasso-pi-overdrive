#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readModelPolicy, validateStoredPolicy, writeModelPolicy } from "../lib/model-policy.mjs";

const [action, targetArg, defaultArg] = process.argv.slice(2);
if (!["initialize", "check"].includes(action) || !targetArg || (action === "initialize" && !defaultArg)) {
  process.stderr.write("usage: model-policy-tool.mjs initialize|check TARGET [DEFAULT]\n");
  process.exit(2);
}
const target = path.resolve(targetArg);
if (action === "initialize" && !fs.existsSync(target)) {
  const defaults = validateStoredPolicy(JSON.parse(fs.readFileSync(path.resolve(defaultArg), "utf8")));
  writeModelPolicy(target, defaults);
  process.stdout.write("Private user-owned model policy initialized.\n");
} else {
  readModelPolicy(target);
  process.stdout.write("Private user-owned model policy: PASS.\n");
}

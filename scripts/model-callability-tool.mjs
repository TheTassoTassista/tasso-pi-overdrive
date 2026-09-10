#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readModelCallability, validateCallabilityCache } from "../lib/model-callability.mjs";
import { writePrivateJsonAtomic } from "../lib/model-policy.mjs";

const [action, targetArg, defaultArg] = process.argv.slice(2);
if (!["initialize", "check"].includes(action) || !targetArg || (action === "initialize" && !defaultArg)) {
  process.stderr.write("usage: model-callability-tool.mjs initialize|check TARGET [DEFAULT]\n");
  process.exit(2);
}
const target = path.resolve(targetArg);
if (action === "initialize" && !fs.existsSync(target)) {
  const defaults = validateCallabilityCache(JSON.parse(fs.readFileSync(path.resolve(defaultArg), "utf8")));
  writePrivateJsonAtomic(target, defaults);
  process.stdout.write("Private secret-free model callability cache initialized.\n");
} else {
  readModelCallability(target);
  process.stdout.write("Private model callability cache: PASS.\n");
}

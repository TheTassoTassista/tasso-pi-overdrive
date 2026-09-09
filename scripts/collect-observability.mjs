#!/usr/bin/env node
import path from "node:path";
import { collectProjectObservability } from "../lib/observability.mjs";

const cwdIndex = process.argv.indexOf("--cwd");
const cwd = path.resolve(cwdIndex >= 0 ? process.argv[cwdIndex + 1] : process.cwd());
try { process.stdout.write(`${JSON.stringify(collectProjectObservability(cwd), null, 2)}\n`); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }

#!/usr/bin/env node
// Certification evidence only: reconcile frozen historical test locations with
// the actual TAP produced by the complete native npm check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

assert.equal(process.argv.length, 4, 'USAGE: e4-preflight-assertions.mjs full-check.log frozen-product-root');
const [, , logPath, productRoot] = process.argv;
const ledger = fs.readFileSync(new URL('../docs/e4-ubuntu-failure-closure-v1.md', import.meta.url), 'utf8');
const entries = [...ledger.matchAll(/^\| (\d+) \| `([^`:]+\.test\.mjs):(\d+)` \|/gmu)]
  .map(([, number, file, line]) => ({ number: Number(number), file, line: Number(line) }));
assert.equal(entries.length, 29, 'HISTORICAL_ROW_COUNT');
assert.ok(entries.every((entry, index) => entry.number === index + 1), 'HISTORICAL_ROW_IDENTITY');

const testName = ({ file, line }) => {
  assert.match(file, /^tests\/[a-z0-9-]+\.test\.mjs$/u, 'TEST_PATH');
  const source = fs.readFileSync(path.join(productRoot, file), 'utf8').split('\n');
  const declaration = source[line - 1]?.match(/^test\((['"])(.*?)\1/u);
  assert.ok(declaration, `TEST_DECLARATION ${file}:${line}`);
  return declaration[2];
};
const names = entries.map(testName);
const rust = { file: 'tests/edit-contract-corpus.test.mjs', line: 5 };
names.push(testName(rust));
assert.equal(new Set(names).size, names.length, 'TEST_NAME_COLLISION');
const size = fs.statSync(logPath).size;
assert.ok(size > 0 && size <= 64 * 1024 * 1024, 'TAP_SIZE');
const tap = fs.readFileSync(logPath, 'utf8');
assert.match(tap, /(?:^|\n)TAP version 13(?:\r?\n)/u, 'TAP_MISSING');
const results = new Map();
for (const line of tap.split(/\r?\n/u)) {
  const match = line.match(/^(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)(?: .*)?)?$/u);
  if (!match) continue;
  const [, status, name, annotation] = match;
  if (!names.includes(name)) continue;
  const seen = results.get(name) ?? [];
  seen.push({ status, annotation: annotation ?? null });
  results.set(name, seen);
}
for (const entry of entries) {
  const name = testName(entry);
  const observed = results.get(name) ?? [];
  assert.deepEqual(observed, [{ status: 'ok', annotation: null }], `HISTORICAL_ROW_${entry.number} ${entry.file}:${entry.line}`);
}
for (const entry of [rust, entries[15]]) {
  const name = testName(entry);
  assert.deepEqual(results.get(name), [{ status: 'ok', annotation: null }], `RUST_HOST ${entry.file}:${entry.line}`);
}
for (const entry of entries) {
  process.stdout.write(`E4_PREFLIGHT_HISTORICAL_ROW_${entry.number}=PASS ${entry.file}:${entry.line}\n`);
}
process.stdout.write('E4_PREFLIGHT_RUST_HOST_ASSERTIONS=PASS count=2\n');
process.stdout.write('E4_PREFLIGHT_HISTORICAL_ASSERTIONS=PASS count=29\n');

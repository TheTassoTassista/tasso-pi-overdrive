#!/usr/bin/env node
// Runner-side transport verification; the image has no writable evidence mount.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { INVENTORY_SCHEMA, MAX_INVENTORY_BYTES } from './e4-executable-inventory.mjs';

export function extractExecutableInventory(rawLog, artifactFile, expectedSha = null) {
  assert.ok(fs.statSync(rawLog).size <= 6 * 1024 * 1024, 'DIAGNOSTIC_TRANSPORT_TOO_LARGE');
  const lines = fs.readFileSync(rawLog, 'utf8').trimEnd().split('\n');
  const one = (prefix) => {
    const found = lines.filter((line) => line.startsWith(prefix));
    assert.equal(found.length, 1, `expected exactly one ${prefix}`);
    return found[0].slice(prefix.length);
  };
  const receipt = JSON.parse(one('E4_EXECUTABLE_INVENTORY_RECEIPT='));
  const encoded = one('E4_EXECUTABLE_INVENTORY_ARTIFACT_BASE64=');
  assert.match(encoded, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
  const bytes = Buffer.from(encoded, 'base64');
  assert.equal(bytes.toString('base64'), encoded, 'noncanonical artifact encoding');
  assert.ok(bytes.length <= MAX_INVENTORY_BYTES, 'DIAGNOSTIC_ARTIFACT_TOO_LARGE');
  assert.equal(bytes.length, receipt.artifact.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.artifact.sha256);
  const body = JSON.parse(bytes.toString('utf8'));
  assert.equal(body.schema, INVENTORY_SCHEMA);
  assert.equal(body.mode, 'COMPLETE_EXECUTABLE_INVENTORY');
  assert.equal(body.qualifying, false);
  assert.equal(receipt.qualifying, false);
  assert.equal(body.candidateSha, receipt.candidateSha);
  assert.ok(body.candidateSha === null || /^[a-f0-9]{40}$/u.test(body.candidateSha));
  if (expectedSha !== null) {
    assert.match(expectedSha, /^[a-f0-9]{40}$/u);
    assert.equal(body.candidateSha, expectedSha, 'diagnostic candidate SHA mismatch');
  }
  assert.equal(receipt.toolCount, body.toolCount);
  assert.equal(receipt.assetCount, body.assetCount);
  assert.equal(receipt.passCount, body.passCount);
  assert.equal(receipt.failureCount, body.failures.length);
  if (receipt.complete) {
    assert.equal(body.tools.length, body.toolCount, 'complete tool count mismatch');
    assert.equal(body.assets.length, body.assetCount, 'complete asset count mismatch');
    assert.equal(body.expectedToolCount, body.toolCount, 'mandatory tool enumeration mismatch');
    assert.equal(body.expectedAssetCount, body.assetCount, 'mandatory asset enumeration mismatch');
  }
  assert.equal(receipt.complete, !body.originalBytes && ![...body.tools, ...body.dependent].some((item) =>
    item.startup?.capture?.complete === false || item.dependencyClosure?.capture?.complete === false ||
    item.elfInspection?.programHeaders?.complete === false || item.elfInspection?.dynamic?.complete === false ||
    item.capture?.complete === false));
  assert.equal(path.basename(artifactFile), 'executable-inventory.json');
  fs.writeFileSync(artifactFile, bytes, { flag: 'wx', mode: 0o600 });
  fs.rmSync(rawLog);
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const receipt = extractExecutableInventory(process.argv[2], process.argv[3], process.argv[4] ?? null);
    console.log(`E4_EXECUTABLE_INVENTORY_RECEIPT=${JSON.stringify(receipt)}`);
    console.log(`E4_EXECUTABLE_INVENTORY_DIAGNOSTIC=${receipt.complete ? 'COMPLETE' : 'INCOMPLETE'}`);
  } catch (error) {
    console.error(`E4_EXECUTABLE_INVENTORY_EXTRACTION=FAIL reason=${String(error.message).slice(0, 180)}`);
    process.exitCode = 1;
  }
}

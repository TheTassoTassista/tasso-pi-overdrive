#!/usr/bin/env node
// Runner-side extraction; no additional mount or privilege inside the image.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function extractLinkerEvidence(rawLog, artifactFile) {
  // JSON escaping and base64 expand the already-enforced 256 KiB raw stream.
  assert.ok(fs.statSync(rawLog).size <= 4 * 1024 * 1024, 'DIAGNOSTIC_TRANSPORT_TOO_LARGE');
  const lines = fs.readFileSync(rawLog, 'utf8').trimEnd().split('\n');
  const prefixed = (prefix) => lines.filter((line) => line.startsWith(prefix));
  const receiptLines = prefixed('E4_RUST_LINKER_RECEIPT=');
  const artifactLines = prefixed('E4_RUST_LINKER_ARTIFACT_BASE64=');
  assert.equal(receiptLines.length, 1, 'expected exactly one compact diagnostic receipt');
  assert.equal(artifactLines.length, 1, 'expected exactly one bounded diagnostic artifact');
  const receipt = JSON.parse(receiptLines[0].slice('E4_RUST_LINKER_RECEIPT='.length));
  const encoded = artifactLines[0].slice('E4_RUST_LINKER_ARTIFACT_BASE64='.length);
  assert.match(encoded, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
  const bytes = Buffer.from(encoded, 'base64');
  assert.equal(bytes.toString('base64'), encoded, 'noncanonical diagnostic artifact encoding');
  assert.equal(bytes.length, receipt.artifact.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.artifact.sha256);
  const body = JSON.parse(bytes.toString('utf8'));
  assert.equal(body.schema, 'phi-e4-linker-diagnostic-v1');
  assert.equal(body.streamLimitBytes, 256 * 1024);
  assert.ok(body.streamBytesRetained <= body.streamLimitBytes);
  assert.equal(body.complete, receipt.artifact.complete);
  if (receipt.status === 'PASS') assert.equal(body.complete, true, 'PASS requires complete compilation evidence');
  if (body.complete) {
    assert.equal(body.metadata?.compile?.spawnStatus, 'SPAWNED_WITH_EXIT_RESULT');
    assert.equal(Number.isInteger(body.metadata.compile.exitCode), true);
    assert.equal(body.metadata.compile.complete, true);
  }
  assert.equal(path.basename(artifactFile), 'rust-linker-diagnostic.json');
  fs.writeFileSync(artifactFile, bytes, { flag: 'wx', mode: 0o600 });
  fs.rmSync(rawLog);
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const receipt = extractLinkerEvidence(process.argv[2], process.argv[3]);
    console.log(`E4_RUST_LINKER_RECEIPT=${JSON.stringify(receipt)}`);
    console.log(`E4_RUST_LINKER_DIAGNOSTIC=${receipt.status}`);
  } catch (error) {
    console.error(`E4_RUST_LINKER_EXTRACTION=FAIL reason=${String(error.message).slice(0, 180)}`);
    process.exitCode = 1;
  }
}

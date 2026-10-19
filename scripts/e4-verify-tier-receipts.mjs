#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { e4JointQualification } from './e4-tier-contract.mjs';

assert.equal(process.argv.length, 5, 'USAGE: e4-verify-tier-receipts tier-a.log tier-b.log candidate-sha');
const [aPath, bPath, candidateSha] = process.argv.slice(2);
assert.match(candidateSha, /^[a-f0-9]{40}$/u, 'INVALID_CANDIDATE_SHA');
function receipt(file, tier) {
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024, `TIER_${tier}_LOG_BOUND`);
  const log = bytes.toString('utf8');
  const records = [...log.matchAll(/^E4_TIER_RECEIPT=(\{[^\n]+\})$/gmu)];
  assert.equal(records.length, 1, `TIER_${tier}_RECEIPT_COUNT`);
  assert.match(log, new RegExp(`^E4_IMAGE_TIER_${tier}=PASS$`, 'mu'), `TIER_${tier}_PASS_MARKER`);
  if (tier === 'B') assert.match(log, /^E4_RUST_SMOKE_WORKSPACE_CLEANUP=PASS$/mu, 'RUST_WORKSPACE_CLEANUP');
  const record = JSON.parse(records[0][1]);
  assert.equal(record.candidateSha, candidateSha, `TIER_${tier}_CANDIDATE_MISMATCH`);
  return record;
}
const result = e4JointQualification(receipt(aPath, 'A'), receipt(bPath, 'B'));
assert.equal(result.candidateSha, candidateSha);
process.stdout.write(`E4_JOINT_QUALIFICATION=${JSON.stringify(result)}\n`);
process.stdout.write('E4_CERTIFICATION_IMAGE_QUALIFIED=YES\n');

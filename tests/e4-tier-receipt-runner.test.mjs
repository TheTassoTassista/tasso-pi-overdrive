import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { E4_TIER_CHECKS, e4TierReceipt } from '../scripts/e4-tier-contract.mjs';

const candidate = 'a'.repeat(40);
const manifest = 'b'.repeat(64);
const inventory = [
  ...Array.from({ length: 38 }, (_, index) => `tool:fixture-${index}`),
  ...Array.from({ length: 14 }, (_, index) => `asset:fixture-${index}`),
  ...Array.from({ length: 12 }, (_, index) => `dependent:fixture-${index}`),
].map((id) => ({ id, tier: 'A', status: 'PASS', inputSha256: manifest }));
const runner = new URL('../scripts/e4-verify-tier-receipts.mjs', import.meta.url).pathname;
const receipt = (tier, status = 'PASS') => e4TierReceipt(tier,
  Object.fromEntries(E4_TIER_CHECKS.filter((check) => check.tier === tier)
    .map((check) => [check.id, { status, inputSha256: manifest }])), candidate, manifest,
  tier === 'A' ? inventory : []);

test('runner requires two complete same-candidate PASS receipts and Rust cleanup', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-tier-receipts-'));
  const aPath = path.join(folder, 'a.log');
  const bPath = path.join(folder, 'b.log');
  const run = () => spawnSync(process.execPath, [runner, aPath, bPath, candidate], { encoding: 'utf8' });
  try {
    fs.writeFileSync(aPath, `E4_TIER_RECEIPT=${JSON.stringify(receipt('A'))}\nE4_IMAGE_TIER_A=PASS\n`);
    fs.writeFileSync(bPath, `E4_RUST_SMOKE_WORKSPACE_CLEANUP=PASS\nE4_TIER_RECEIPT=${JSON.stringify(receipt('B'))}\nE4_IMAGE_TIER_B=PASS\n`);
    const valid = run();
    assert.equal(valid.status, 0);
    assert.match(valid.stdout, /E4_TIER_JOINT=PASS/u);
    assert.doesNotMatch(valid.stdout, /E4_CERTIFICATION_IMAGE_QUALIFIED=YES/u);
    fs.writeFileSync(bPath, `E4_TIER_RECEIPT=${JSON.stringify(receipt('B'))}\nE4_IMAGE_TIER_B=PASS\n`);
    assert.notEqual(run().status, 0, 'missing cleanup cannot qualify');
    fs.writeFileSync(bPath, `E4_RUST_SMOKE_WORKSPACE_CLEANUP=PASS\nE4_TIER_RECEIPT=${JSON.stringify(receipt('B', 'FAIL'))}\nE4_IMAGE_TIER_B=PASS\n`);
    assert.notEqual(run().status, 0, 'failed mandatory check cannot qualify');
    fs.writeFileSync(bPath, `E4_RUST_SMOKE_WORKSPACE_CLEANUP=PASS\nE4_TIER_RECEIPT=${JSON.stringify(receipt('B'))}\n`);
    assert.notEqual(run().status, 0, 'missing tier marker cannot qualify');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

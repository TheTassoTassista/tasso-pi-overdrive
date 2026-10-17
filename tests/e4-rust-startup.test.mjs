import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { classifyRustStartup, rustStartupEvidence } from '../scripts/e4-rust-startup.mjs';

test('bounded Rust startup diagnostics classify the exact missing SONAME', () => {
  assert.deepEqual(classifyRustStartup(
    '/usr/bin/rustc: error while loading shared libraries: libLLVM.so.22.1: cannot open shared object file: No such file or directory', true),
  { category: 'MISSING_SHARED_LIBRARY', missingLibraries: ['libLLVM.so.22.1'] });
  assert.deepEqual(classifyRustStartup('', false), { category: 'MISSING_ELF_INTERPRETER', missingLibraries: [] });
  assert.deepEqual(classifyRustStartup('unclassified status 127', true), { category: 'UNKNOWN', missingLibraries: [] });
});

test('Rust startup probe retains bounded executable identity and actual nonzero exit', () => {
  const binary = fs.realpathSync('/usr/bin/false');
  const sha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const result = rustStartupEvidence(binary, sha256);
  assert.equal(result.pass, false);
  assert.equal(result.evidence.path, binary);
  assert.equal(result.evidence.realpath, binary);
  assert.equal(result.evidence.sha256, sha256);
  assert.equal(result.evidence.exitCode, 1);
  assert.equal(result.evidence.interpreterExists, true);
  assert.equal(result.evidence.category, 'UNKNOWN');
  assert.ok(result.evidence.stderr.length <= 320);
});

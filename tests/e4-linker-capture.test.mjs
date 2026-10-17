import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LinkerDiagnosticCapture, MAX_DIAGNOSTIC_STREAM_BYTES, keyErrorLines } from '../scripts/e4-linker-capture.mjs';

test('linker diagnostic retains complete stdout/stderr in one hashed artifact with bounded receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-linker-capture-'));
  try {
    const capture = new LinkerDiagnosticCapture();
    const result = capture.run(process.execPath, ['-e',
      'process.stdout.write("ordinary output\\n"); process.stderr.write("ld: fatal: cannot find Scrt1.o\\n")']);
    assert.equal(result.exitCode, 0);
    assert.equal(result.complete, true);
    assert.match(result.stderr, /cannot find Scrt1\.o/u);
    const artifact = capture.artifact({ fixed: 'identity' }, path.join(root, 'evidence.json'));
    const bytes = fs.readFileSync(artifact.path);
    assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(artifact.complete, true);
    assert.ok(artifact.streamBytes < MAX_DIAGNOSTIC_STREAM_BYTES);
    assert.equal(JSON.parse(bytes).records[0].stderr, 'ld: fatal: cannot find Scrt1.o\n');
    assert.deepEqual(keyErrorLines(result.stderr), ['ld: fatal: cannot find Scrt1.o']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('combined 256 KiB ceiling fails explicitly and labels artifact incomplete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-linker-capture-'));
  try {
    const capture = new LinkerDiagnosticCapture(256);
    assert.throws(() => capture.run(process.execPath, ['-e',
      'process.stdout.write("x".repeat(180)); process.stderr.write("FATAL".repeat(40))']),
    /DIAGNOSTIC_OUTPUT_TOO_LARGE/u);
    const artifact = capture.artifact({}, path.join(root, 'evidence.json'));
    assert.equal(artifact.complete, false);
    assert.equal(artifact.streamBytes, 256);
    assert.equal(JSON.parse(fs.readFileSync(artifact.path, 'utf8')).complete, false);
    assert.match(capture.records[0].stderr, /FATAL/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture uses a fixed minimal environment and does not record ambient secrets', () => {
  const capture = new LinkerDiagnosticCapture();
  process.env.PHI_E4_TEST_SECRET = 'not-for-diagnostic';
  try {
    const result = capture.run(process.execPath, ['-e',
      'process.stdout.write(process.env.PHI_E4_TEST_SECRET ?? "absent")']);
    assert.equal(result.stdout, 'absent');
    assert.doesNotMatch(JSON.stringify(capture.records), /not-for-diagnostic/u);
  } finally {
    delete process.env.PHI_E4_TEST_SECRET;
  }
});

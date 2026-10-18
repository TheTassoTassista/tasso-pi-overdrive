import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LinkerDiagnosticCapture, MAX_DIAGNOSTIC_STREAM_BYTES, keyErrorLines } from '../scripts/e4-linker-capture.mjs';
import { extractLinkerEvidence } from '../scripts/e4-extract-linker-evidence.mjs';

test('linker diagnostic retains complete stdout/stderr in one hashed artifact with bounded receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-linker-capture-'));
  try {
    const capture = new LinkerDiagnosticCapture();
    const result = capture.run(process.execPath, ['-e',
      'process.stdout.write("ordinary output\\n"); process.stderr.write("ld: fatal: cannot find Scrt1.o\\n")']);
    assert.equal(result.exitCode, 0);
    assert.equal(result.complete, true);
    assert.match(result.stderr, /cannot find Scrt1\.o/u);
    const artifact = capture.artifact({ fixed: 'identity', compile: {
      spawnStatus: result.spawnStatus, exitCode: result.exitCode, complete: result.complete,
    } }, path.join(root, 'evidence.json'));
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

test('real capture wrapper passes UTF-8 string stdin and preserves a numeric nonzero child exit', () => {
  const capture = new LinkerDiagnosticCapture();
  const result = capture.run(process.execPath, ['-e',
    'let s=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", x => s += x); process.stdin.on("end", () => { process.stdout.write(s); process.stderr.write("compiler diagnostic\\n"); process.exitCode = 7; });'],
  { input: 'fn main() { println!("φ"); }\n' });
  assert.equal(result.spawnStatus, 'SPAWNED_WITH_EXIT_RESULT');
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'fn main() { println!("φ"); }\n');
  assert.equal(result.stderr, 'compiler diagnostic\n');
  assert.equal(result.stdoutComplete, true);
  assert.equal(result.stderrComplete, true);
  const serialized = capture.serialize({ compile: { spawnStatus: result.spawnStatus,
    exitCode: result.exitCode, complete: result.complete } });
  assert.equal(serialized.complete, true);
  assert.equal(JSON.parse(serialized.bytes).metadata.compile.exitCode, 7);
});

test('real capture wrapper fails closed on spawn error and absent compiler result', () => {
  const capture = new LinkerDiagnosticCapture();
  const result = capture.run('/definitely-not-a-phi-executable', []);
  assert.equal(result.spawnStatus, 'SPAWN_ERROR');
  assert.equal(result.errorCode, 'ENOENT');
  assert.equal(result.exitCode, null);
  assert.equal(result.complete, false);
  assert.equal(capture.serialize({ compile: null }).complete, false);
  const neverStarted = new LinkerDiagnosticCapture();
  assert.equal(neverStarted.serialize({ compile: null }).complete, false);
});

test('real capture wrapper preserves combined output under the bound', () => {
  const capture = new LinkerDiagnosticCapture(256);
  const result = capture.run(process.execPath, ['-e',
    'process.stdout.write("a".repeat(100)); process.stderr.write("b".repeat(100))']);
  assert.equal(result.spawnStatus, 'SPAWNED_WITH_EXIT_RESULT');
  assert.equal(result.stdout.length, 100);
  assert.equal(result.stderr.length, 100);
  assert.equal(capture.serialize({ compile: { spawnStatus: result.spawnStatus,
    exitCode: result.exitCode, complete: result.complete } }).streamBytes, 200);
});

test('real capture wrapper marks per-stream maxBuffer and signal termination incomplete', () => {
  const overflowing = new LinkerDiagnosticCapture(64);
  assert.throws(() => overflowing.run(process.execPath, ['-e',
    'process.stdout.write("x".repeat(10000))']), /DIAGNOSTIC_OUTPUT_TOO_LARGE/u);
  assert.equal(overflowing.records[0].spawnStatus, 'DIAGNOSTIC_OUTPUT_TOO_LARGE');
  assert.equal(overflowing.records[0].errorCode, 'ENOBUFS');
  assert.equal(overflowing.records[0].complete, false);
  assert.equal(overflowing.serialize({ compile: null }).complete, false);

  if (process.platform !== 'win32') {
    const signalled = new LinkerDiagnosticCapture();
    const result = signalled.run(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']);
    assert.equal(result.spawnStatus, 'CAPTURE_INCOMPLETE');
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(result.exitCode, null);
    assert.equal(signalled.serialize({ compile: null }).complete, false);
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

test('runner extracts and hashes the complete artifact without an image bind mount', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-linker-transport-'));
  try {
    const capture = new LinkerDiagnosticCapture();
    const result = capture.run(process.execPath, ['-e', 'process.stderr.write("ld: cannot find Scrt1.o\\n")']);
    const serialized = capture.serialize({ rust: 'pinned', compile: {
      spawnStatus: result.spawnStatus, exitCode: result.exitCode, complete: result.complete } });
    const receipt = { status: 'FAIL', artifact: { sha256: serialized.sha256,
      bytes: serialized.bytes.length, complete: true } };
    const raw = path.join(root, 'raw.log');
    const output = path.join(root, 'rust-linker-diagnostic.json');
    fs.writeFileSync(raw, `E4_RUST_LINKER_RECEIPT=${JSON.stringify(receipt)}\nE4_RUST_LINKER_ARTIFACT_BASE64=${serialized.bytes.toString('base64')}\n`);
    assert.deepEqual(extractLinkerEvidence(raw, output), receipt);
    assert.deepEqual(fs.readFileSync(output), serialized.bytes);
    assert.equal(fs.existsSync(raw), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner refuses a falsely complete artifact without terminal compiler evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-linker-transport-'));
  try {
    const capture = new LinkerDiagnosticCapture();
    const serialized = capture.serialize({ rust: 'pinned' });
    assert.equal(serialized.complete, false);
    const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(serialized.bytes), complete: true }));
    const receipt = { artifact: { sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length, complete: true } };
    const raw = path.join(root, 'raw.log');
    fs.writeFileSync(raw, `E4_RUST_LINKER_RECEIPT=${JSON.stringify(receipt)}\nE4_RUST_LINKER_ARTIFACT_BASE64=${bytes.toString('base64')}\n`);
    assert.throws(() => extractLinkerEvidence(raw, path.join(root, 'rust-linker-diagnostic.json')),
      /Expected values to be strictly equal/u);
    assert.equal(fs.existsSync(raw), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner rejects a mismatched artifact digest and retains the raw evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-linker-transport-'));
  try {
    const capture = new LinkerDiagnosticCapture();
    const serialized = capture.serialize({});
    const raw = path.join(root, 'raw.log');
    const output = path.join(root, 'rust-linker-diagnostic.json');
    fs.writeFileSync(raw, `E4_RUST_LINKER_RECEIPT=${JSON.stringify({ artifact: {
      sha256: '0'.repeat(64), bytes: serialized.bytes.length, complete: true } })}\nE4_RUST_LINKER_ARTIFACT_BASE64=${serialized.bytes.toString('base64')}\n`);
    assert.throws(() => extractLinkerEvidence(raw, output), /Expected values to be strictly equal/u);
    assert.equal(fs.existsSync(output), false);
    assert.equal(fs.existsSync(raw), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

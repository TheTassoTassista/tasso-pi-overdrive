#!/usr/bin/env node
// Non-certifying observation of the unchanged E4 Rust link failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LinkerDiagnosticCapture, keyErrorLines } from './e4-linker-capture.mjs';
import { rustStartupEvidence } from './e4-rust-startup.mjs';

const capture = new LinkerDiagnosticCapture();
const metadata = { rust: null, gcc: null, linker: null, startfiles: [], compile: null };
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const identity = (file) => {
  const realpath = fs.realpathSync(file);
  assert.equal(fs.statSync(realpath).isFile(), true, `Not a regular tool: ${file}`);
  return { path: file, realpath, sha256: hash(realpath), bytes: fs.statSync(realpath).size };
};
const checked = (binary, args, options) => {
  const record = capture.run(binary, args, options);
  assert.equal(record.complete, true, `${binary} capture incomplete: ${record.spawnStatus}`);
  assert.equal(record.exitCode, 0, `${binary} exit=${record.exitCode} error=${record.errorCode ?? 'none'}`);
  return record.stdout.trim();
};
const resolveTool = (name) => {
  const choices = path.isAbsolute(name) ? [name] : ['/usr/bin', '/bin'].map((dir) => path.join(dir, name));
  const file = choices.find((candidate) => fs.existsSync(candidate));
  assert.ok(file, `Selected tool unavailable: ${name}`);
  fs.accessSync(file, fs.constants.X_OK);
  return file;
};
const compileEvidence = (record) => ({ command: record.command, spawnStatus: record.spawnStatus,
  exitCode: record.exitCode, signal: record.signal, errorCode: record.errorCode,
  stdoutComplete: record.stdoutComplete, stderrComplete: record.stderrComplete,
  complete: record.complete });

let failure = null;
let compileRecord = null;
let probe = null;
try {
  const manifest = JSON.parse(fs.readFileSync('/opt/phi/config/e4-toolchain-seeds.json', 'utf8'));
  const rust = manifest.assets.find((asset) => asset.logicalName === 'rust-1.98.1-toolchain');
  const runtime = manifest.assets.find((asset) => asset.logicalName === 'llvm-libs-22.1.8-rust-runtime')?.runtimeDependency;
  assert.equal(runtime?.soname, 'libLLVM.so.22.1');
  const startup = rustStartupEvidence('/usr/bin/rustc', rust.extracted[0].sha256);
  assert.equal(startup.pass, true, `Rust startup ${startup.evidence.category}`);
  assert.equal(hash(runtime.path), runtime.sha256);
  metadata.rust = { ...identity('/usr/bin/rustc'), startup: startup.evidence,
    verboseVersion: checked('/usr/bin/rustc', ['--version', '--verbose']),
    sysroot: checked('/usr/bin/rustc', ['--print', 'sysroot']),
    targetLibdir: checked('/usr/bin/rustc', ['--print', 'target-libdir']) };
  assert.equal(metadata.rust.sysroot, rust.toolchain.sysrootPath);
  assert.equal(hash(rust.toolchain.stdLibraryPath), rust.toolchain.stdLibrarySha256);
  const host = /^host:\s*(\S+)$/mu.exec(metadata.rust.verboseVersion)?.[1];
  assert.ok(host, 'Rust verbose version lacks host target');
  metadata.rust.target = host;
  assert.equal(fs.statSync(metadata.rust.targetLibdir).isDirectory(), true);
  const loaded = checked('/lib64/ld-linux-x86-64.so.2', ['--list', '/usr/bin/rustc']);
  assert.match(loaded, /libLLVM\.so\.22\.1 => \/usr\/lib\/libLLVM\.so\.22\.1/u);
  assert.doesNotMatch(loaded, /not found/u);

  const gccPath = resolveTool('x86_64-linux-gnu-gcc');
  metadata.gcc = { ...identity(gccPath), version: checked(gccPath, ['--version']),
    target: checked(gccPath, ['-dumpmachine']),
    searchDirs: checked(gccPath, ['-print-search-dirs']),
    selectedLd: checked(gccPath, ['-print-prog-name=ld']) };
  const linkerPath = resolveTool(metadata.gcc.selectedLd);
  metadata.linker = { ...identity(linkerPath), version: checked(linkerPath, ['--version']) };
  for (const name of ['crt1.o', 'Scrt1.o', 'crti.o', 'crtn.o', 'libgcc.a', 'libgcc_s.so', 'libc.so']) {
    const result = checked(gccPath, [`-print-file-name=${name}`]);
    const found = path.isAbsolute(result) && fs.existsSync(result);
    metadata.startfiles.push({ requestedName: name, resolvedResult: result,
      exists: found, ...(found ? identity(result) : {}) });
  }

  // Exact source, flags, target selection, environment and /tmp semantics of
  // CI39016323973. Only the output capture mechanism differs.
  probe = fs.mkdtempSync('/tmp/phi-e4-rust-diagnostic-');
  const executable = path.join(probe, 'smoke');
  compileRecord = capture.run('/usr/bin/rustc', ['--edition=2021', '-', '-o', executable], {
    input: Buffer.from('fn main() { println!("phi-rust-ok"); }\n', 'utf8'), cwd: probe,
  });
  metadata.compile = compileEvidence(compileRecord);
  metadata.compile.result = compileRecord.complete && compileRecord.exitCode === 0 ? 'PASS' : 'FAIL';
  if (!compileRecord.complete) {
    failure = `RUST_COMPILE_CAPTURE_INCOMPLETE status=${compileRecord.spawnStatus}`;
  } else if (compileRecord.exitCode === 0) {
    const executableResult = capture.run(executable, []);
    assert.equal(executableResult.complete, true, 'Rust executable capture incomplete');
    assert.equal(executableResult.exitCode, 0);
    assert.equal(executableResult.stdout.trim(), 'phi-rust-ok');
  }
} catch (error) {
  if (!compileRecord) {
    compileRecord = capture.records.findLast((record) => record.command[0] === '/usr/bin/rustc'
      && record.command.includes('--edition=2021')) ?? null;
    if (compileRecord) metadata.compile = compileEvidence(compileRecord);
  }
  capture.incomplete = true;
  failure = error.message === 'DIAGNOSTIC_OUTPUT_TOO_LARGE'
    ? 'DIAGNOSTIC_OUTPUT_TOO_LARGE' : `DIAGNOSTIC_PROBE_FAILED ${String(error.message).slice(0, 180)}`;
} finally {
  if (probe) fs.rmSync(probe, { recursive: true, force: true });
}

try {
  const serialized = capture.serialize(metadata);
  const artifact = { sha256: serialized.sha256, bytes: serialized.bytes.length,
    complete: serialized.complete, streamBytes: serialized.streamBytes };
  const receipt = { status: failure ? 'FAIL' : 'PASS', classification: serialized.complete ? 'PENDING_POST_RUN' : 'UNKNOWN',
    reason: failure, spawnStatus: compileRecord?.spawnStatus ?? 'CAPTURE_INCOMPLETE',
    spawnError: compileRecord?.errorCode ?? null, compileExitCode: compileRecord?.exitCode ?? null,
    rustCompileResult: metadata.compile?.result ?? 'NOT_REACHED',
    compileSignal: compileRecord?.signal ?? null, captureComplete: serialized.complete,
    combinedOutputBytes: serialized.streamBytes,
    outputOverflow: capture.records.some((record) => record.spawnStatus === 'DIAGNOSTIC_OUTPUT_TOO_LARGE'),
    stdoutComplete: compileRecord?.stdoutComplete ?? false,
    stderrComplete: compileRecord?.stderrComplete ?? false,
    keyErrorLines: keyErrorLines(compileRecord?.stderr), rustPath: metadata.rust?.path ?? null,
    rustSha256: metadata.rust?.sha256 ?? null, gccPath: metadata.gcc?.path ?? null,
    gccSha256: metadata.gcc?.sha256 ?? null, linkerPath: metadata.linker?.path ?? null,
    linkerSha256: metadata.linker?.sha256 ?? null, artifact, tempDiagnosticFiles: 'REMOVED',
  };
  console.log(`E4_RUST_LINKER_RECEIPT=${JSON.stringify(receipt)}`);
  console.log(`E4_RUST_LINKER_ARTIFACT_BASE64=${serialized.bytes.toString('base64')}`);
  console.log(`E4_RUST_LINKER_DIAGNOSTIC=${failure ? 'FAIL' : 'PASS'}`);
  if (failure) process.exitCode = 1;
} catch (error) {
  console.error(`E4_RUST_LINKER_DIAGNOSTIC=FAIL reason=ARTIFACT_EMISSION_FAILED ${String(error.message).slice(0, 180)}`);
  process.exitCode = 1;
}

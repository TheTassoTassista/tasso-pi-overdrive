#!/usr/bin/env node
// Non-certifying, no-network Rust closure probe inside the exact candidate image.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rustStartupEvidence } from './e4-rust-startup.mjs';

const manifest = JSON.parse(fs.readFileSync('/opt/phi/config/e4-toolchain-seeds.json', 'utf8'));
const rust = manifest.assets.find((asset) => asset.logicalName === 'rust-1.98.1-toolchain');
const runtime = manifest.assets.find((asset) => asset.logicalName === 'llvm-libs-22.1.8-rust-runtime')?.runtimeDependency;
const env = { PATH: '/usr/bin:/bin', HOME: '/tmp' };
const bounded = (value) => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, ' ').slice(0, 320);
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 4096, env, ...options });
  assert.equal(result.status, 0, `${binary} exit=${result.status} error=${result.error?.code ?? 'none'} stderr=${bounded(result.stderr)}`);
  return String(result.stdout ?? '');
}

try {
  assert.equal(runtime?.soname, 'libLLVM.so.22.1');
  const startup = rustStartupEvidence('/usr/bin/rustc', rust.extracted[0].sha256);
  console.log(`E4_RUST_DIAGNOSTIC_STARTUP=${JSON.stringify(startup.evidence)}`);
  assert.equal(startup.pass, true, `Rust startup ${startup.evidence.category}`);
  assert.equal(fs.statSync(runtime.path).size, runtime.size);
  assert.equal(sha256(runtime.path), runtime.sha256);
  assert.equal(runtime.requiredBy, rust.toolchain.driverPath);
  assert.equal(runtime.requiredBySha256, rust.toolchain.driverSha256);
  assert.equal(sha256(runtime.requiredBy), runtime.requiredBySha256);
  const needed = run('/usr/bin/readelf', ['-d', runtime.requiredBy]);
  assert.match(needed, /Shared library: \[libLLVM\.so\.22\.1\]/u);
  const libraries = run('/lib64/ld-linux-x86-64.so.2', ['--list', '/usr/bin/rustc']);
  assert.match(libraries, /libLLVM\.so\.22\.1 => \/usr\/lib\/libLLVM\.so\.22\.1/u);
  assert.doesNotMatch(libraries, /not found/u);
  for (const match of libraries.matchAll(/=> (\/[^\s]+)/gu)) assert.match(match[1], /^\/usr\/lib\//u);
  console.log('E4_RUST_DIAGNOSTIC_LIBRARY_CLOSURE=PASS');
  const sysroot = run('/usr/bin/rustc', ['--print', 'sysroot']).trim();
  assert.equal(sysroot, rust.toolchain.sysrootPath);
  assert.equal(sha256(rust.toolchain.stdLibraryPath), rust.toolchain.stdLibrarySha256);
  console.log(`E4_RUST_DIAGNOSTIC_SYSROOT=${sysroot}`);
  const probe = fs.mkdtempSync('/tmp/phi-e4-rust-diagnostic-');
  try {
    const executable = path.join(probe, 'smoke');
    run('/usr/bin/rustc', ['--edition=2021', '-', '-o', executable], {
      input: 'fn main() { println!("phi-rust-ok"); }\n', cwd: probe,
    });
    assert.equal(run(executable, []).trim(), 'phi-rust-ok');
    console.log('E4_RUST_DIAGNOSTIC_COMPILE_RUN=PASS');
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
  assert.match(run('/usr/bin/cargo', ['--version']), /^cargo 1\.98\.1/mu);
  console.log('E4_RUST_DIAGNOSTIC_CARGO=PASS');
  console.log('E4_RUST_DIAGNOSTIC=PASS');
} catch (error) {
  console.error(`E4_RUST_DIAGNOSTIC=FAIL reason=${bounded(error.message)}`);
  process.exitCode = 1;
}

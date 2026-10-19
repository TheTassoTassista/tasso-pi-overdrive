#!/usr/bin/env node
// Runs inside the frozen E4 image without network or provider credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { RUST_EXECVE_SCHEMA, RUST_SMOKE_SOURCE, RUST_SMOKE_SOURCE_SHA256,
  rustStartupEvidence, rustSmokeExecEvidence, serializeRustForensic } from './e4-rust-startup.mjs';
import { inventoryCertificationDecision, runExecutableInventory } from './e4-executable-inventory.mjs';
import { E4_TIER_CHECKS, e4TierReceipt, verifyE4NestedUsernsDenied, verifyE4TierMount } from './e4-tier-contract.mjs';
import { runE4TrustedRustSmoke } from './e4-trusted-rust-smoke.mjs';

const root = '/opt/phi';
const rustForensicMode = process.argv.slice(2).includes('--rust-execve-forensic');
const trustedSmokeMode = process.argv.slice(2).includes('--trusted-generated-smoke');
const tierAImageMode = process.argv.slice(2).includes('--tier-a-image');
const candidateSha = process.env.PHI_E4_CANDIDATE_SHA ?? '';
const tierAProgress = Object.fromEntries(E4_TIER_CHECKS.filter((check) => check.tier === 'A')
  .map((check) => [check.id, 'NOT_EXECUTED']));
let activeTierACheck = 'A_EXECUTABLE_INVENTORY';
let inventoryChecks = [];
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'config', name), 'utf8'));
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function command(binary, args, expected) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/tmp', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '/opt/phi/runtime/dap/python' } });
  assert.equal(result.status, 0, `${binary} failed: ${result.error?.code ?? result.status}`);
  assert.match(result.stdout + result.stderr, expected, `${binary} version/identity mismatch`);
  return result.stdout + result.stderr;
}
function fileIdentity(file, expected) {
  assert.match(expected, /^[a-f0-9]{64}$/u);
  assert.equal(fs.lstatSync(file).isFile(), true, `${file} is not a regular file`);
  assert.equal(hash(file), expected, `${file} digest mismatch`);
}
function packageVersion(name, expected) {
  const folder = path.join(root, 'pi', 'npm', 'node_modules', ...name.split('/'));
  const actual = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  assert.equal(actual.version, expected, `${name} version mismatch`);
  return folder;
}
function treeIdentity(folder, expected) {
  const files = [];
  function walk(base, relative = '') {
    for (const name of fs.readdirSync(base).sort()) {
      const file = path.join(base, name);
      const child = path.posix.join(relative, name);
      const stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, `symlink in ${folder}`);
      if (stat.isDirectory()) walk(file, child);
      else if (stat.isFile()) files.push([child, file]);
      else assert.fail(`special file in ${folder}`);
    }
  }
  walk(folder);
  const outer = createHash('sha256');
  for (const [relative, file] of files.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    outer.update(`${hash(file)}  ${path.posix.join('debugpy', relative)}\n`);
  }
  assert.equal(outer.digest('hex'), expected, 'debugpy tree mismatch');
}

if (trustedSmokeMode) {
  try {
    assert.deepEqual(process.argv.slice(2), ['--trusted-generated-smoke'], 'TRUSTED_SMOKE_ARGV');
    const smoke = runE4TrustedRustSmoke();
    assert.equal(smoke.cleanup, 'PASS', 'RUST_SMOKE_CLEANUP');
    const manifestSha = hash(path.join(root, 'config', 'e4-toolchain-seeds.json'));
    const receipt = e4TierReceipt('B', { B_RUST_GENERATED_EXEC: { status: 'PASS',
      inputSha256: createHash('sha256').update(`${smoke.rustcSha256}:${smoke.sourceSha256}`).digest('hex') } },
    candidateSha, manifestSha);
    process.stdout.write(`E4_RUST_TRUSTED_SMOKE=${JSON.stringify(smoke)}\n`);
    process.stdout.write(`E4_TIER_RECEIPT=${JSON.stringify(receipt)}\n`);
    process.stdout.write('E4_IMAGE_TIER_B=PASS\n');
  } catch (error) {
    console.error(`E4_IMAGE_TIER_B=FAIL reason=${String(error.message).slice(0, 300)}`);
    if (error.evidence) process.stdout.write(`E4_RUST_TRUSTED_FAILURE=${JSON.stringify(error.evidence)}\n`);
    if (/^[a-f0-9]{40}$/u.test(candidateSha)) {
      try {
        const manifestSha = hash(path.join(root, 'config', 'e4-toolchain-seeds.json'));
        const inputSha256 = createHash('sha256').update(`${manifestSha}:${RUST_SMOKE_SOURCE_SHA256}`).digest('hex');
        process.stdout.write(`E4_TIER_RECEIPT=${JSON.stringify(e4TierReceipt('B', {
          B_RUST_GENERATED_EXEC: { status: 'FAIL', inputSha256 },
        }, candidateSha, manifestSha))}\n`);
      } catch { console.error('E4_TIER_B_RECEIPT=INCOMPLETE'); }
    }
    process.exitCode = 1;
  }
} else if (process.argv.slice(2).includes('--complete-executable-inventory')) {
  try {
    const diagnostic = runExecutableInventory();
    process.stdout.write(`E4_EXECUTABLE_INVENTORY_RECEIPT=${JSON.stringify(diagnostic.receipt)}\n`);
    process.stdout.write(`E4_EXECUTABLE_INVENTORY_ARTIFACT_BASE64=${diagnostic.bytes.toString('base64')}\n`);
    if (!diagnostic.receipt.complete || diagnostic.receipt.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    console.error(`E4_EXECUTABLE_INVENTORY=FAIL reason=${String(error.message).slice(0, 180)}`);
    process.exitCode = 1;
  }
} else try {
  if (tierAImageMode) {
    assert.deepEqual(process.argv.slice(2), ['--tier-a-image'], 'TIER_A_ARGV');
    assert.match(candidateSha, /^[a-f0-9]{40}$/u, 'TIER_A_CANDIDATE_ID');
    verifyE4TierMount('A');
    verifyE4NestedUsernsDenied();
  }
  const executableInventory = runExecutableInventory();
  const inventoryManifestSha = hash(path.join(root, 'config', 'e4-toolchain-seeds.json'));
  inventoryChecks = [
    ...executableInventory.body.tools.map((entry) => ({ id: `tool:${entry.id}`, tier: 'A',
      status: entry.status, inputSha256: entry.expectedSha256 ?? inventoryManifestSha })),
    ...executableInventory.body.assets.map((entry) => ({ id: `asset:${entry.id}`, tier: 'A',
      status: entry.status, inputSha256: entry.expectedSha256 ?? inventoryManifestSha })),
    ...executableInventory.body.dependent.map((entry) => ({ id: `dependent:${entry.id}`, tier: 'A',
      status: entry.status, inputSha256: inventoryManifestSha })),
  ];
  assert.equal(inventoryCertificationDecision(executableInventory), true,
    `mandatory executable inventory failed: ${JSON.stringify(executableInventory.body.failures)}`);
  tierAProgress.A_EXECUTABLE_INVENTORY = 'PASS';
  activeTierACheck = 'A_TOOLCHAIN_IDENTITIES';
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  const manifest = read('e4-toolchain-seeds.json');
  const llvm = read('e4-llvm-toolchain.json');
  assert.equal(llvm.releaseTag, 'llvmorg-22.1.8');
  assert.equal(llvm.assetId, 449438700);
  assert.equal(llvm.archiveName, 'LLVM-22.1.8-Linux-X64.tar.xz');
  assert.equal(llvm.archiveSize, 1938859476);
  assert.equal(llvm.archiveSha256, 'df0e1ecf16caf3489a272a5eea4eec9b0d82878f6477fa309504f918a0006384');
  assert.equal(llvm.clangdPath, '/usr/local/lib/phi/llvm/22.1.8/bin/clangd');
  assert.equal(llvm.clangdVersion, '22.1.8');
  assert.equal(llvm.clangdSize, 106012688);
  assert.equal(llvm.clangdSha256, 'aacb4651e1886b98c5413369fc1789f4ca2d4fa5b94fdf0de4f48c98a52d4324');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.release.id, 411800345);
  assert.equal(manifest.assets.length, 14);
  const byName = new Map(manifest.assets.map((item) => [item.logicalName, item]));
  for (const asset of manifest.assets) {
    for (const item of asset.extracted) fileIdentity(item.installedPath, item.sha256);
  }
  const nodeSeed = byName.get('nodejs-26.8.2');
  const simdjson = byName.get('simdjson-4.6.11-node-runtime')?.runtimeDependency;
  const rustSeed = byName.get('rust-1.98.1-toolchain');
  const rustRuntime = byName.get('llvm-libs-22.1.8-rust-runtime')?.runtimeDependency;
  const rustLinker = byName.get('lld-22.1.8-rust-linker');
  const libgit2 = byName.get('libgit2-1.9.7-cargo-runtime')?.runtimeDependency;
  const llhttp = byName.get('llhttp-9.3.1-libgit2-runtime')?.runtimeDependency;
  assert.equal(rustLinker.extracted[0].installedPath, '/usr/bin/ld.lld');
  command('/usr/bin/ld.lld', ['--version'], /^LLD 22\.1\.8 /u);
  const linkerLibraries = command('/lib64/ld-linux-x86-64.so.2', ['--list', '/usr/bin/ld.lld'], /liblldELF\.so\.22\.1 => \/usr\/lib\/liblldELF\.so\.22\.1/u);
  assert.doesNotMatch(linkerLibraries, /not found/u, 'Rust linker has an unresolved rootfs library');
  assert.equal(rustRuntime?.soname, 'libLLVM.so.22.1');
  assert.equal(rustRuntime.path, '/usr/lib/libLLVM.so.22.1');
  assert.equal(rustRuntime.sha256, byName.get('llvm-libs-22.1.8-rust-runtime').extracted[0].sha256);
  assert.equal(fs.statSync(rustRuntime.path).size, rustRuntime.size);
  fileIdentity(rustRuntime.path, rustRuntime.sha256);
  assert.equal(rustRuntime.requiredBy, '/usr/lib/librustc_driver-6486d279b43c5e4c.so');
  assert.equal(rustRuntime.requiredBy, rustSeed.toolchain.driverPath);
  assert.equal(rustRuntime.requiredBySha256, rustSeed.toolchain.driverSha256);
  fileIdentity(rustRuntime.requiredBy, rustRuntime.requiredBySha256);
  assert.equal(rustSeed.extracted[0].installedPath, rustSeed.toolchain.rustcPath);
  assert.equal(rustSeed.extracted[1].installedPath, rustSeed.toolchain.cargoPath);
  assert.equal(rustSeed.toolchain.version, '1.98.1');
  fileIdentity(rustSeed.toolchain.stdLibraryPath, rustSeed.toolchain.stdLibrarySha256);
  assert.equal(simdjson?.requiredBy, '/usr/bin/node');
  assert.equal(simdjson.requiredBySha256, nodeSeed.extracted[0].sha256);
  assert.equal(simdjson.soname, 'libsimdjson.so.33');
  assert.equal(simdjson.linkPath, '/usr/lib/libsimdjson.so.33');
  assert.equal(simdjson.linkTarget, 'libsimdjson.so.33.0.0');
  assert.equal(simdjson.path, '/usr/lib/libsimdjson.so.33.0.0');
  assert.equal(fs.lstatSync(simdjson.linkPath).isSymbolicLink(), true, 'simdjson SONAME is not a symlink');
  assert.equal(fs.readlinkSync(simdjson.linkPath), simdjson.linkTarget, 'simdjson SONAME target mismatch');
  assert.equal(fs.realpathSync(simdjson.linkPath), simdjson.path, 'simdjson SONAME escapes exact library');
  assert.equal(fs.statSync(simdjson.path).size, simdjson.size, 'simdjson library size mismatch');
  fileIdentity(simdjson.path, simdjson.sha256);
  command('/usr/bin/readelf', ['-d', simdjson.requiredBy], /Shared library: \[libsimdjson\.so\.33\]/u);
  const resolution = command('/lib64/ld-linux-x86-64.so.2', ['--list', simdjson.requiredBy], /libsimdjson\.so\.33 => \/usr\/lib\/libsimdjson\.so\.33/u);
  assert.doesNotMatch(resolution, /not found/u, 'Node has an unresolved rootfs library');
  const git = read('git-resources.json');
  const dap = read('dap-engine.json');
  const evalPolicy = read('eval-engine.json');
  const ast = read('ast-edit.json');
  assert.equal(byName.get('git-2.55.0').extracted[0].sha256, git.binarySha256);
  assert.equal(byName.get('gdb-17.2').extracted[0].sha256, dap.adapter.binarySha256);
  assert.equal(byName.get('python-3.14.7').extracted[0].sha256, evalPolicy.runtimes.python.binarySha256);
  assert.equal(byName.get('nodejs-26.8.2').extracted[0].sha256, evalPolicy.runtimes.javascript.binarySha256);
  assert.equal(byName.get('util-linux-2.42.4').extracted[0].sha256, evalPolicy.processLimiter.binarySha256);
  command(git.binaryPath, ['--version'], /^git version 2\.55\.0/mu);
  command(dap.adapter.binaryPath, ['--version'], /GNU gdb \(GDB\) 17\.2/u);
  command('/usr/bin/gdb', ['-q', '-nx', '-nh', '-batch', '-ex', 'python import gdb.dap; print("E4_GDB_DAP_READY")'], /E4_GDB_DAP_READY/u);
  command(evalPolicy.runtimes.python.binaryPath, ['--version'], /^Python 3\.14\.7/mu);
  command(evalPolicy.runtimes.javascript.binaryPath, ['--version'], /^v26\.8\.2/mu);
  command(evalPolicy.processLimiter.binaryPath, ['--version'], /prlimit from util-linux 2\.42\.4/u);
  command('/usr/bin/cmp', ['--version'], /diffutils\) 3\.12/u);
  assert.equal(fs.existsSync('/usr/bin/clangd'), false, 'distro clangd must not be image authority');
  assert.equal(fs.realpathSync(llvm.clangdPath), llvm.clangdPath, 'managed clangd path is not canonical');
  assert.equal(fs.statSync(llvm.clangdPath).size, llvm.clangdSize, 'managed clangd size mismatch');
  fileIdentity(llvm.clangdPath, llvm.clangdSha256);
  command(llvm.clangdPath, ['--version'], /^clangd version 22\.1\.8/mu);
  const { lspRuntimeStatus } = await import(pathToFileURL(path.join(root, 'project', 'lib', 'lsp-manager.mjs')).href);
  assert.equal(lspRuntimeStatus().languages.clangd.binaryPath, llvm.clangdPath, 'Phi resolved a non-managed clangd');
  const clangdDynamic = command('/usr/bin/readelf', ['-d', llvm.clangdPath], /Shared library:/u);
  assert.doesNotMatch(clangdDynamic, /libLLVM|libclang-cpp/u, 'clangd depends on an unowned LLVM library');
  const clangdLibraries = command('/lib64/ld-linux-x86-64.so.2', ['--list', llvm.clangdPath], /libstdc\+\+\.so\.6/u);
  assert.doesNotMatch(clangdLibraries, /not found/u, 'clangd has an unresolved library');
  for (const match of clangdLibraries.matchAll(/=> (\/[^\s]+)/gu)) {
    assert.match(match[1], /^\/usr\/lib\//u, `clangd library outside immutable rootfs: ${match[1]}`);
  }
  process.stdout.write(`E4_LLVM_PROVENANCE=PASS tag=${llvm.releaseTag} asset_id=${llvm.assetId}\n`);
  process.stdout.write(`E4_LLVM_ARCHIVE_SHA256=${llvm.archiveSha256}\n`);
  process.stdout.write(`E4_MANAGED_CLANGD_PATH=${llvm.clangdPath}\n`);
  process.stdout.write(`E4_CLANGD_VERSION=${llvm.clangdVersion}\n`);
  process.stdout.write(`E4_CLANGD_SHA256=${llvm.clangdSha256}\n`);
  process.stdout.write('E4_CLANGD_SHARED_LIBRARY_CLOSURE=PASS\n');
  process.stdout.write('E4_NO_ACCIDENTAL_23X_RESOLUTION=PASS\n');
  command('/usr/bin/node', [path.join(root, 'e4-clangd-lsp-smoke.mjs'), llvm.clangdPath], /^E4_CPP_LSP_SMOKE=PASS$/mu);
  const rustStartup = rustStartupEvidence('/usr/bin/rustc', rustSeed.extracted[0].sha256);
  process.stdout.write(`E4_RUST_STARTUP_EVIDENCE=${JSON.stringify(rustStartup.evidence)}\n`);
  assert.equal(rustStartup.pass, true, `Rust startup failed: ${rustStartup.evidence.category}`);
  command('/usr/bin/readelf', ['-d', rustRuntime.requiredBy], /Shared library: \[libLLVM\.so\.22\.1\]/u);
  command('/usr/bin/readelf', ['-d', rustRuntime.path], /Library soname: \[libLLVM\.so\.22\.1\]/u);
  const rustLibraries = command('/lib64/ld-linux-x86-64.so.2', ['--list', '/usr/bin/rustc'], /libLLVM\.so\.22\.1 => \/usr\/lib\/libLLVM\.so\.22\.1/u);
  assert.doesNotMatch(rustLibraries, /not found/u, 'Rust has an unresolved rootfs library');
  for (const match of rustLibraries.matchAll(/=> (\/[^\s]+)/gu)) {
    assert.match(match[1], /^\/usr\/lib\//u, `Rust library outside immutable rootfs: ${match[1]}`);
  }
  process.stdout.write('E4_RUST_SHARED_LIBRARY_CLOSURE=PASS\n');
  assert.equal(libgit2?.requiredBy, '/usr/bin/cargo');
  assert.equal(libgit2.requiredBySha256, rustSeed.extracted[1].sha256);
  assert.equal(llhttp?.requiredBy, libgit2.path);
  assert.equal(llhttp.requiredBySha256, libgit2.sha256);
  for (const runtime of [libgit2, llhttp]) {
    assert.equal(fs.lstatSync(runtime.linkPath).isSymbolicLink(), true, `${runtime.soname} link missing`);
    assert.equal(fs.readlinkSync(runtime.linkPath), runtime.linkTarget, `${runtime.soname} target mismatch`);
    assert.equal(fs.realpathSync(runtime.linkPath), runtime.path, `${runtime.soname} escapes exact library`);
    assert.equal(fs.statSync(runtime.path).size, runtime.size, `${runtime.soname} size mismatch`);
    fileIdentity(runtime.path, runtime.sha256);
    const dynamic = command('/usr/bin/readelf', ['-d', runtime.path], /Library soname:/u);
    assert.match(dynamic, new RegExp(`Library soname: \\[${runtime.soname.replaceAll('.', '\\.')}\\]`, 'u'));
    for (const needed of runtime.needed)
      assert.match(dynamic, new RegExp(`Shared library: \\[${needed.replaceAll('.', '\\.')}\\]`, 'u'));
  }
  command('/usr/bin/readelf', ['-d', '/usr/bin/cargo'], /Shared library: \[libgit2\.so\.1\.9\]/u);
  const cargoLibraries = command('/lib64/ld-linux-x86-64.so.2', ['--list', '/usr/bin/cargo'],
    /libgit2\.so\.1\.9 => \/usr\/lib\/libgit2\.so\.1\.9/u);
  assert.match(cargoLibraries, /libllhttp\.so\.9\.3 => \/usr\/lib\/libllhttp\.so\.9\.3/u);
  assert.doesNotMatch(cargoLibraries, /not found/u, 'Cargo has an unresolved rootfs library');
  for (const match of cargoLibraries.matchAll(/=> (\/[^\s]+)/gu)) {
    assert.match(match[1], /^\/usr\/lib\//u, `Cargo library outside immutable rootfs: ${match[1]}`);
  }
  process.stdout.write('E4_CARGO_LIBGIT2_CLOSURE=PASS\n');
  command('/usr/bin/cargo', ['--version'], /^cargo 1\.98\.1/mu);
  assert.equal(executableInventory.body.dependent.find((entry) => entry.id === 'cargo-offline-compile')?.status,
    'PASS', 'offline Cargo compilation was not verified');
  process.stdout.write('E4_CARGO_OFFLINE_COMPILE=PASS\n');
  assert.equal(command('/usr/bin/rustc', ['--print', 'sysroot'], /^\/usr\n?$/u).trim(), rustSeed.toolchain.sysrootPath);
  tierAProgress.A_TOOLCHAIN_IDENTITIES = 'PASS';
  activeTierACheck = 'A_RUNTIME_SMOKES';
  if (rustForensicMode) {
  const rustProbe = fs.mkdtempSync('/tmp/phi-e4-rust-');
  const forensic = rustForensicMode ? {
    schema: RUST_EXECVE_SCHEMA, qualifying: false,
    candidateSha: process.env.PHI_E4_CANDIDATE_SHA ?? null,
    historicalSha: 'b914cfe53779244fdfac093ba29539b6d4ff12c8',
    seedManifestSha256: hash(path.join(root, 'config', 'e4-toolchain-seeds.json')),
    rustcSha256: rustSeed.extracted[0].sha256,
    compile: null, beforeExec: null, executionInvocation: null, execution: null,
    cleanup: 'UNKNOWN', error: null,
  } : null;
  try {
    const executable = path.join(rustProbe, 'smoke');
    const compiled = spawnSync('/usr/bin/rustc', ['--edition=2021', '-', '-o', executable], {
      input: RUST_SMOKE_SOURCE, encoding: 'utf8',
      timeout: 15000, maxBuffer: 1024 * 1024, cwd: rustProbe,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
    });
    if (forensic) forensic.compile = {
      binary: '/usr/bin/rustc', args: ['--edition=2021', '-', '-o', executable],
      cwd: rustProbe, sourceSha256: RUST_SMOKE_SOURCE_SHA256,
      outputPath: executable, inputMethod: 'stdin', timeoutMs: 15000, maxBufferBytes: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
      exitCode: compiled.status, errorCode: compiled.error?.code ?? null, signal: compiled.signal ?? null,
      stdout: String(compiled.stdout ?? '').slice(0, 2048), stderr: String(compiled.stderr ?? '').slice(0, 2048),
      stdoutComplete: Buffer.byteLength(compiled.stdout ?? '') <= 2048,
      stderrComplete: Buffer.byteLength(compiled.stderr ?? '') <= 2048,
    };
    assert.equal(compiled.status, 0, `seeded Rust/sysroot compile failed: ${compiled.stderr}`);
    if (forensic) forensic.beforeExec = rustSmokeExecEvidence(executable, null);
    if (forensic) forensic.executionInvocation = {
      method: 'spawnSync', binary: executable, args: [], cwd: process.cwd(),
      timeoutMs: 15000, maxBufferBytes: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp', PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: '/opt/phi/runtime/dap/python' },
    };
    const smoke = spawnSync(executable, [], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '/opt/phi/runtime/dap/python' } });
    if (forensic) forensic.execution = rustSmokeExecEvidence(executable, smoke);
    if (smoke.status !== 0 || smoke.error) {
      if (!forensic) console.error(`E4_RUST_SMOKE_EXEC_EVIDENCE=${JSON.stringify(rustSmokeExecEvidence(executable, smoke))}`);
    }
    if (!forensic) {
      assert.equal(smoke.status, 0, `${executable} failed: ${smoke.error?.code ?? smoke.status}`);
      assert.match(smoke.stdout + smoke.stderr, /^E4_RUST_SYSROOT_READY$/mu);
    }
  } catch (error) {
    if (!forensic) throw error;
    forensic.error = String(error.message).slice(0, 180);
  } finally {
    try {
      fs.rmSync(rustProbe, { recursive: true, force: true });
      assert.equal(fs.existsSync(rustProbe), false);
      if (forensic) forensic.cleanup = 'PASS';
      console.log('E4_RUST_SMOKE_WORKSPACE_CLEANUP=PASS');
    } catch (error) {
      if (!forensic) throw error;
      forensic.cleanup = 'FAIL';
      forensic.error ??= `CLEANUP_${String(error.message).slice(0, 120)}`;
    }
  }
  if (forensic) {
    const { bytes, receipt } = serializeRustForensic(forensic);
    console.log(`E4_RUST_EXECVE_FORENSIC_RECEIPT=${JSON.stringify(receipt)}`);
    console.log(`E4_RUST_EXECVE_FORENSIC_ARTIFACT_BASE64=${bytes.toString('base64')}`);
    if (!forensic.complete) process.exitCode = 1;
  }
  }
  if (!rustForensicMode) {
  command('/opt/phi/browser/agent-browser-0.36.0/agent-browser', ['--version'], /agent-browser 0\.36\.0/u);
  command('/opt/phi/browser/chrome-152.0.7977.82/chrome', ['--version'], /Chrome for Testing 152\.0\.7977\.82/u);

  const pi = packageVersion('@earendil-works/pi-coding-agent', '0.87.1');
  const subagents = packageVersion('pi-subagents', '0.66.0');
  const jiti = packageVersion('jiti', '2.7.0');
  const lock = read('pi-package-lock.json');
  for (const [name, folder, version] of [
    ['@earendil-works/pi-coding-agent', pi, '0.87.1'],
    ['pi-subagents', subagents, '0.66.0'],
    ['jiti', jiti, '2.7.0'],
  ]) {
    const relative = path.relative(path.join(root, 'pi', 'npm'), folder).replaceAll(path.sep, '/');
    assert.equal(lock.packages[relative].version, version, `${name} lock mismatch`);
  }
  const requireFromSubagents = createRequire(path.join(subagents, 'package.json'));
  assert.equal(requireFromSubagents.resolve('jiti').startsWith(jiti), true, 'jiti not resolved from pi-subagents');
  const { createJiti } = await import(requireFromSubagents.resolve('jiti'));
  const bridge = await createJiti(import.meta.url).import(path.join(subagents, 'src', 'slash', 'prompt-template-bridge.ts'));
  assert.equal(typeof bridge, 'object', 'Pi subagents TypeScript bridge unavailable');
  command('/usr/bin/node', [path.join(pi, 'dist', 'bundle', 'cli.js'), '--version'], /0\.87\.1/u);

  // npm blocks lifecycle scripts in this image. The cli package then retains
  // its JS fallback shim; attest and invoke the pinned native optional binary.
  const astPackage = 'node_modules/@ast-grep/cli-linux-x64-gnu';
  assert.equal(lock.packages[astPackage]?.version, '0.45.3');
  const astBin = path.join(root, 'pi', 'npm', astPackage, 'ast-grep');
  fileIdentity(astBin, ast.binarySha256);
  command(astBin, ['--version'], /ast-grep 0\.45\.3/u);
  fileIdentity(path.join(root, 'runtime', 'lsp', 'node_modules', 'typescript', 'lib', 'typescript.js'), evalPolicy.runtimes.javascript.typescriptCompiler.sha256);
  command('/usr/bin/node', [path.join(root, 'scripts', 'install-managed-lsp.mjs'), '--runtime', path.join(root, 'runtime', 'lsp'), '--check'], /"status": "PASS"/u);
  const debugpy = path.join(root, 'runtime', 'dap', 'python', 'debugpy');
  treeIdentity(debugpy, dap.secondaryAdapters[0].moduleSha256);
  command('/usr/bin/python3.14', ['-c', 'import debugpy; print(debugpy.__version__)'], /^1\.8\.22/mu);

  assert.equal(fs.lstatSync('/phi').isDirectory(), true);
  assert.equal(fs.readdirSync('/phi').length, 0, '/phi is not an empty structural mountpoint');
  for (const destination of ['/evidence', '/proc', '/dev', '/tmp', '/run']) assert.equal(fs.lstatSync(destination).isDirectory(), true);
  tierAProgress.A_RUNTIME_SMOKES = 'PASS';
  activeTierACheck = 'A_FOCUSED_TESTS';
  const focused = spawnSync('/usr/bin/node', ['--test', '--test-reporter=tap',
    '/opt/phi/project/tests/agent-hub-control-bridge.test.mjs',
    '/opt/phi/project/tests/ast-edit-engine.test.mjs'], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp',
      PI_CODING_AGENT_DIR: '/opt/phi/pi', PI_OVERDRIVE_AST_GREP_BIN: astBin },
  });
  const failedNames = [...(focused.stdout ?? '').matchAll(/^not ok \d+ - ([^\n]{1,120})$/gmu)].map((match) => match[1]);
  assert.equal(focused.status, 0, `focused Agent Hub/AST tests failed: ${focused.error?.code ?? focused.status}; cases=${JSON.stringify(failedNames)}`);
  assert.match(focused.stdout, /^# fail 0$/mu);
  assert.match(focused.stdout, /^# pass [1-9][0-9]*$/mu);
  tierAProgress.A_FOCUSED_TESTS = 'PASS';
  if (tierAImageMode) {
    const manifestSha = hash(path.join(root, 'config', 'e4-toolchain-seeds.json'));
    const results = Object.fromEntries(Object.entries(tierAProgress).map(([id, status]) =>
      [id, { status, inputSha256: manifestSha }]));
    process.stdout.write(`E4_TIER_RECEIPT=${JSON.stringify(e4TierReceipt('A', results, candidateSha, manifestSha, inventoryChecks))}\n`);
  }
  console.log('E4_IMAGE_SELFCHECK=PASS');
  if (tierAImageMode) console.log('E4_IMAGE_TIER_A=PASS');
  console.log('E4_IMAGE_TOOL_IDENTITIES=PASS');
  console.log('E4_IMAGE_NODE_ELF_CLOSURE=PASS');
  console.log('E4_IMAGE_PI_SUBAGENTS_JITI=PASS');
  console.log('E4_IMAGE_PHI_MOUNTPOINT=PASS');
  console.log('E4_IMAGE_FOCUSED_TESTS=PASS');
  }
} catch (error) {
  console.error(`E4_IMAGE_SELFCHECK=FAIL reason=${String(error.message).slice(0, 300)}`);
  if (tierAImageMode && /^[a-f0-9]{40}$/u.test(candidateSha)) {
    tierAProgress[activeTierACheck] = 'FAIL';
    try {
      const manifestSha = hash(path.join(root, 'config', 'e4-toolchain-seeds.json'));
      const results = Object.fromEntries(Object.entries(tierAProgress).map(([id, status]) =>
        [id, { status, inputSha256: manifestSha }]));
      process.stdout.write(`E4_TIER_RECEIPT=${JSON.stringify(e4TierReceipt('A', results, candidateSha, manifestSha, inventoryChecks))}\n`);
    } catch { console.error('E4_TIER_A_RECEIPT=INCOMPLETE'); }
  }
  process.exitCode = 1;
}

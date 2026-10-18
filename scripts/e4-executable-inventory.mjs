// Non-certifying E4 executable inventory. Runs only inside the candidate image.
// The ordinary image self-check remains the separate fail-closed qualification gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LinkerDiagnosticCapture } from './e4-linker-capture.mjs';

export const INVENTORY_SCHEMA = 'phi-e4-executable-inventory-v1';
export const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_BYTES = 32 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (root, relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
function fileEvidence(file) {
  const fd = fs.openSync(file, 'r');
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let prefix = Buffer.alloc(0);
  try {
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      if (prefix.length < 256) prefix = Buffer.concat([prefix, chunk.subarray(0, Math.min(count, 256 - prefix.length))]);
      digest.update(chunk.subarray(0, count));
    }
    return { sha256: digest.digest('hex'), prefix };
  } finally { fs.closeSync(fd); }
}

// Entries are derived from E4's installed seeds, managed LSP/DAP contracts,
// Dockerfile utilities and the native preflight's compile/runtime path. An
// unsupported language server is intentionally absent; the pinned servers are
// all explicit here, including their executable entrypoints.
export function requiredExecutableInventory(root = '/') {
  const seeds = readJson(root, 'opt/phi/config/e4-toolchain-seeds.json');
  const llvm = readJson(root, 'opt/phi/config/e4-llvm-toolchain.json');
  const managed = readJson(root, 'opt/phi/config/managed-lsp.json');
  const ast = readJson(root, 'opt/phi/config/ast-edit.json');
  const seed = (name, index = 0) => {
    const item = seeds.assets.find((asset) => asset.logicalName === name)?.extracted[index];
    assert.ok(item, `missing seed ${name}[${index}]`);
    return item;
  };
  const entries = [
    ['git', seed('git-2.55.0').installedPath, ['--version'], 'Git transactions and tests', seed('git-2.55.0').sha256],
    ['gdb', seed('gdb-17.2').installedPath, ['--version'], 'DAP primary adapter', seed('gdb-17.2').sha256],
    ['python', seed('python-3.14.7').installedPath, ['--version'], 'debugpy/DAP and Python eval', seed('python-3.14.7').sha256],
    ['node', seed('nodejs-26.8.2').installedPath, ['--version'], 'Pi, tests and Node LSP runtime', seed('nodejs-26.8.2').sha256],
    ['prlimit', seed('util-linux-2.42.4').installedPath, ['--version'], 'bounded process execution', seed('util-linux-2.42.4').sha256],
    ['cmp', seed('diffutils-3.12-cmp').installedPath, ['--version'], 'native content verification', seed('diffutils-3.12-cmp').sha256],
    ['rustc', seed('rust-1.98.1-toolchain', 0).installedPath, ['--version'], 'Rust build and source tests', seed('rust-1.98.1-toolchain', 0).sha256],
    ['cargo', seed('rust-1.98.1-toolchain', 1).installedPath, ['--version'], 'Rust build and source tests', seed('rust-1.98.1-toolchain', 1).sha256],
    ['ld.lld', seed('lld-22.1.8-rust-linker').installedPath, ['--version'], 'selected Rust linker', seed('lld-22.1.8-rust-linker').sha256],
    ['clangd', llvm.clangdPath, ['--version'], 'C/C++ semantic LSP', llvm.clangdSha256],
    ['agent-browser', seed('browser-runtime-0.36.0-chrome-152.0.7977.82', 0).installedPath, ['--version'], 'browser automation', seed('browser-runtime-0.36.0-chrome-152.0.7977.82', 0).sha256],
    ['chrome', seed('browser-runtime-0.36.0-chrome-152.0.7977.82', 1).installedPath, ['--version'], 'browser runtime', seed('browser-runtime-0.36.0-chrome-152.0.7977.82', 1).sha256],
    ['rust-analyzer', '/opt/phi/runtime/lsp/managed/bin/rust-analyzer', ['--version'], 'Rust semantic LSP', managed.rustAnalyzer.binarySha256],
    ['gopls', '/opt/phi/runtime/lsp/managed/bin/gopls', ['version'], 'Go semantic LSP', managed.gopls.binarySha256],
    ['go', '/opt/phi/runtime/lsp/managed/go/bin/go', ['version'], 'Go LSP toolchain', managed.go.binarySha256],
    ['gcc', '/usr/bin/gcc', ['--version'], 'native C/Rust link and tests'],
    ['target-gcc', '/usr/bin/x86_64-linux-gnu-gcc', ['--version'], 'Rust selected host linker'],
    ['ld', '/usr/bin/ld', ['--version'], 'binutils native linker'],
    ['as', '/usr/bin/as', ['--version'], 'binutils assembler'],
    ['readelf', '/usr/bin/readelf', ['--version'], 'ELF dependency inspection'],
    ['elf-loader', '/lib64/ld-linux-x86-64.so.2', ['--help'], 'ELF interpreter and dependency resolution'],
    ['bash', '/usr/bin/bash', ['--version'], 'preflight and production shell'],
    ['env', '/usr/bin/env', ['--version'], 'Node LSP shebang interpreter'],
    ['bwrap', '/usr/bin/bwrap', ['--version'], 'Linux sandbox isolation'],
    ['make', '/usr/bin/make', ['--version'], 'native build tests'],
    ['cmake', '/usr/bin/cmake', ['--version'], 'C/C++ build tests'],
    ['npm', '/usr/bin/npm', ['--version'], 'Pi and managed-runtime package validation'],
    ['tar', '/usr/bin/tar', ['--version'], 'fixture and package extraction'],
    ['pi-cli', '/opt/phi/pi/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      ['--version'], 'Pi 0.87.1 ordinary agent runtime'],
    ['ast-grep', '/opt/phi/pi/npm/node_modules/@ast-grep/cli-linux-x64-gnu/ast-grep',
      ['--version'], 'agent AST edit and search', ast.binarySha256],
    ['tsc', '/opt/phi/runtime/lsp/node_modules/.bin/tsc', ['--version'],
      'TypeScript compiler and language runtime'],
  ];
  const lsp = [
    ['vtsls', '@vtsls/language-server'],
    ['pyright-langserver', 'pyright'],
    ['vscode-html-language-server', 'vscode-langservers-extracted'],
    ['vscode-css-language-server', 'vscode-langservers-extracted'],
    ['vscode-json-language-server', 'vscode-langservers-extracted'],
    ['yaml-language-server', 'yaml-language-server'],
    ['bash-language-server', 'bash-language-server'],
  ];
  const lock = readJson(root, 'opt/phi/runtime/lsp/package-lock.json');
  for (const [name, packageName] of lsp) {
    const version = lock.packages[`node_modules/${packageName}`]?.version;
    assert.ok(version, `missing LSP lock identity ${packageName}`);
    entries.push([name, `/opt/phi/runtime/lsp/node_modules/.bin/${name}`, null,
      `pinned ${packageName}@${version} semantic LSP`]);
  }
  const versions = { git: '2.55.0', gdb: '17.2', python: '3.14.7', node: '26.8.2',
    prlimit: '2.42.4', cmp: '3.12', rustc: '1.98.1', cargo: '1.98.1',
    'ld.lld': '22.1.8', clangd: '22.1.8', 'agent-browser': '0.36.0',
    chrome: '152.0.7977.82', 'rust-analyzer': managed.rustAnalyzer.version,
    gopls: managed.gopls.version, go: managed.go.version, 'pi-cli': '0.87.1',
    'ast-grep': '0.45.3', tsc: '6.0.3' };
  return entries.map(([id, binary, versionArgs, reason, expectedSha256]) => ({
    id, path: binary, expectedPath: binary, versionArgs, reason,
    expectedSha256: expectedSha256 ?? null,
    expectedVersion: versions[id] ?? (versionArgs === null ? reason.match(/@([\d.]+) /u)?.[1] ?? null : null),
    expectedIdentity: expectedSha256 ? 'PINNED_SHA256' : versionArgs === null ? 'PINNED_NPM_LOCK' : 'IMAGE_ROOTFS_OBSERVED',
    dependencies: id === 'cargo' ? ['rustc', 'ld.lld'] : [],
  }));
}

export function requiredRuntimeAssets(root = '/') {
  const seeds = readJson(root, 'opt/phi/config/e4-toolchain-seeds.json');
  const executablePaths = new Set(requiredExecutableInventory(root).map((item) => item.path));
  const assets = seeds.assets.flatMap((asset) => asset.extracted
    .filter((item) => !executablePaths.has(item.installedPath))
    .map((item) => ({ id: `${asset.logicalName}:${item.installedPath}`,
      path: item.installedPath, expectedSha256: item.sha256, reason: `selected immutable seed ${asset.logicalName}` })));
  const rust = seeds.assets.find((item) => item.logicalName === 'rust-1.98.1-toolchain')?.toolchain;
  assert.ok(rust, 'missing pinned Rust toolchain layout');
  assets.push({ id: 'rust-driver', path: rust.driverPath, expectedSha256: rust.driverSha256,
    reason: 'rustc dynamic driver' });
  assets.push({ id: 'rust-stdlib', path: rust.stdLibraryPath, expectedSha256: rust.stdLibrarySha256,
    reason: 'Rust sysroot standard library' });
  assets.push({ id: 'glibc', path: '/usr/lib/libc.so.6', expectedSha256: null,
    reason: 'C runtime for GCC/linker and dynamically linked tools' });
  return assets;
}

// Resolve symlinks as rootfs paths, never as host paths. This also makes broken
// absolute symlinks observable in a staged rootfs fixture without host leakage.
export function resolveRootfsPath(root, requested) {
  assert.equal(path.isAbsolute(root) && path.isAbsolute(requested), true);
  const base = path.resolve(root);
  let logical = path.posix.normalize(requested);
  const chain = [];
  for (let hops = 0; hops < 32; hops += 1) {
    const segments = logical.split('/').filter(Boolean);
    let changed = false;
    let prefix = '';
    for (let index = 0; index < segments.length; index += 1) {
      prefix += `/${segments[index]}`;
      const physical = path.join(base, prefix.slice(1));
      const stat = fs.lstatSync(physical);
      if (!stat.isSymbolicLink()) continue;
      const target = fs.readlinkSync(physical);
      chain.push({ path: prefix, target });
      const suffix = segments.slice(index + 1).join('/');
      logical = path.posix.normalize(path.posix.join(
        path.posix.isAbsolute(target) ? target : path.posix.join(path.posix.dirname(prefix), target), suffix));
      changed = true;
      break;
    }
    if (!changed) {
      const physical = path.join(base, logical.slice(1));
      assert.equal(physical === base || physical.startsWith(`${base}${path.sep}`), true, 'ROOTFS_ESCAPE');
      return { realpath: logical, physical, symlinks: chain };
    }
  }
  throw new Error('SYMLINK_LOOP');
}

export function captureInventoryCommand(binary, args, options = {}) {
  const capture = new LinkerDiagnosticCapture(MAX_COMMAND_BYTES);
  try { return capture.run(binary, args, options); } catch (error) {
    return capture.records.at(-1) ?? { command: [binary, ...args], spawnStatus: 'CAPTURE_INCOMPLETE',
      exitCode: null, stdout: '', stderr: '', complete: false, errorCode: error.code ?? null };
  }
}

function commandOutcome(record) {
  if (!record?.complete) return { status: 'UNKNOWN', reason: record?.spawnStatus ?? 'NO_CAPTURE' };
  if (record.exitCode !== 0) return { status: 'FAIL', reason: `PROCESS_EXIT_${record.exitCode}` };
  return { status: 'PASS', reason: null };
}

function inspectAsset(root, definition) {
  const item = { ...definition, realpath: null, symlinks: [], fileType: null,
    sha256: null, status: 'UNKNOWN', reason: null };
  try {
    const resolved = resolveRootfsPath(root, definition.path);
    item.realpath = resolved.realpath;
    item.symlinks = resolved.symlinks;
    const stat = fs.statSync(resolved.physical);
    if (!stat.isFile()) throw new Error('NOT_REGULAR_FILE');
    item.fileType = 'regular-file';
    item.sha256 = fileEvidence(resolved.physical).sha256;
    if (definition.expectedSha256 && item.sha256 !== definition.expectedSha256) throw new Error('DIGEST_MISMATCH');
    item.status = 'PASS';
  } catch (error) { item.status = 'FAIL'; item.reason = `ASSET_${error.code ?? error.message}`; }
  return item;
}

function inspectOne(root, definition, run) {
  const item = { ...definition, realpath: null, symlinks: [], fileType: null,
    sha256: null, elfInterpreter: null, shebang: null, needed: [],
    dependencyClosure: null, version: null, startup: null, functional: null,
    startupEnvironment: { PATH: '/usr/bin:/bin', HOME: '/tmp' }, dependentChecks: [],
    status: 'UNKNOWN', reason: null };
  let resolved;
  try {
    resolved = resolveRootfsPath(root, definition.path);
    item.realpath = resolved.realpath;
    item.symlinks = resolved.symlinks;
    const stat = fs.statSync(resolved.physical);
    item.fileType = stat.isFile() ? 'regular-file' : stat.isDirectory() ? 'directory' : 'special';
    if (!stat.isFile()) throw new Error('NOT_REGULAR_FILE');
    item.executable = Boolean(stat.mode & 0o111);
    if (!item.executable) throw new Error('NOT_EXECUTABLE');
    const { sha256: digest, prefix: bytes } = fileEvidence(resolved.physical);
    item.sha256 = digest;
    if (definition.expectedSha256 && item.sha256 !== definition.expectedSha256) throw new Error('DIGEST_MISMATCH');
    item.fileType = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ? 'ELF' :
      bytes.subarray(0, 2).toString() === '#!' ? 'script' : 'unknown';
    if (item.fileType === 'unknown') throw new Error('UNRECOGNIZED_EXECUTABLE_FORMAT');
    if (item.fileType === 'script') {
      item.shebang = bytes.subarray(0, Math.min(bytes.length, 256)).toString('utf8').split('\n')[0].slice(2).trim();
      const interpreter = item.shebang.split(/\s+/u)[0];
      if (!interpreter.startsWith('/')) throw new Error('NON_ABSOLUTE_SHEBANG');
      item.interpreterIdentity = resolveRootfsPath(root, interpreter).realpath;
      item.dependencyClosure = { status: 'PASS', kind: 'shebang', interpreter: item.interpreterIdentity };
    } else {
      const readelf = run('/usr/bin/readelf', ['-l', resolved.realpath]);
      const dynamic = run('/usr/bin/readelf', ['-d', resolved.realpath]);
      item.elfInspection = { programHeaders: readelf, dynamic };
      if (!readelf.complete || !dynamic.complete) throw new Error('ELF_INSPECTION_INCOMPLETE');
      if (readelf.exitCode !== 0 || dynamic.exitCode !== 0) throw new Error('ELF_INSPECTION_FAILED');
      item.elfInterpreter = /Requesting program interpreter:\s*([^\]\s]+)/u.exec(readelf.stdout)?.[1] ?? null;
      item.needed = [...dynamic.stdout.matchAll(/Shared library: \[([^\]]+)\]/gu)].map((match) => match[1]);
      item.rpath = [...dynamic.stdout.matchAll(/\((?:RPATH|RUNPATH)\).*?\[([^\]]+)\]/gu)]
        .map((match) => match[1]);
      if (item.elfInterpreter) resolveRootfsPath(root, item.elfInterpreter);
      if (!item.elfInterpreter && item.needed.length === 0) {
        item.dependencyClosure = { status: 'PASS', kind: 'static-ELF', capture: null };
      } else {
        const closure = run('/lib64/ld-linux-x86-64.so.2', ['--list', resolved.realpath]);
        item.dependencyClosure = { ...commandOutcome(closure), capture: closure };
        if (/not found|error while loading shared libraries/iu.test(closure.stdout + closure.stderr)) {
          item.dependencyClosure.status = 'FAIL';
          item.dependencyClosure.reason = 'UNRESOLVED_SHARED_LIBRARY';
        }
        const libraries = [...closure.stdout.matchAll(/=> (\/[^\s]+)/gu)].map((match) => match[1]);
        item.dependencyClosure.resolvedLibraries = libraries;
        for (const library of libraries) {
          if (!/^\/(?:usr\/lib|lib64|opt\/phi\/browser)(?:\/|$)/u.test(library)) {
            item.dependencyClosure.status = 'FAIL';
            item.dependencyClosure.reason = 'LIBRARY_OUTSIDE_OWNED_ROOTFS';
            continue;
          }
          try { resolveRootfsPath(root, library); } catch {
            item.dependencyClosure.status = 'FAIL';
            item.dependencyClosure.reason = 'RESOLVED_LIBRARY_MISSING_IN_ROOTFS';
          }
        }
      }
    }
  } catch (error) {
    item.status = 'FAIL';
    item.reason = `IDENTITY_OR_CLOSURE_${error.code ?? error.message}`;
    return item;
  }
  if (definition.versionArgs === null) {
    // These entrypoints have pinned package identities but no stable --version
    // CLI. Probe the real LSP initialize/shutdown path instead.
    item.version = definition.reason.match(/@([\d.]+) /u)?.[1] ?? null;
    const startup = run('/usr/bin/node', ['/opt/phi/e4-lsp-startup-smoke.mjs', definition.id, definition.path]);
    item.startup = { ...commandOutcome(startup), capture: startup };
    if (item.startup.status === 'PASS' && !startup.stdout.includes(`E4_LSP_STARTUP=PASS id=${definition.id}`)) {
      item.startup.status = 'FAIL'; item.startup.reason = 'LSP_PROTOCOL_SMOKE_MISMATCH';
    }
    item.functional = { status: item.startup.status, reason: item.startup.reason,
      kind: 'LSP_INITIALIZE_SHUTDOWN' };
  } else {
    const startup = run(definition.path, definition.versionArgs);
    item.startup = { ...commandOutcome(startup), capture: startup };
    item.version = startup.complete ? (startup.stdout + startup.stderr).trim().split('\n')[0]?.slice(0, 300) : null;
  }
  if (item.startup.status === 'PASS' && definition.expectedVersion &&
      !item.version?.includes(definition.expectedVersion)) {
    item.startup.status = 'FAIL'; item.startup.reason = 'VERSION_MISMATCH';
  }
  // A version invocation is the mandatory startup smoke for these entries.
  // Deeper functional checks are separate required dependent entries below.
  item.functional = { status: item.startup.status, reason: item.startup.reason,
    kind: definition.versionArgs === null ? 'LSP_INITIALIZE_SHUTDOWN' : 'VERSION_STARTUP' };
  const closure = item.dependencyClosure?.status;
  item.status = closure === 'FAIL' || item.startup.status === 'FAIL' ? 'FAIL' :
    closure !== 'PASS' || item.startup.status !== 'PASS' ? 'UNKNOWN' : 'PASS';
  item.reason = item.status === 'PASS' ? null : item.dependencyClosure?.reason ?? item.startup?.reason;
  return item;
}

export function runExecutableInventory({ root = '/', definitions = requiredExecutableInventory(root),
  runtimeAssets = root === '/' ? requiredRuntimeAssets(root) : [], run = captureInventoryCommand } = {}) {
  const tools = definitions.map((entry) => inspectOne(root, entry, run));
  const assets = runtimeAssets.map((entry) => inspectAsset(root, entry));
  const byId = new Map(tools.map((entry) => [entry.id, entry]));
  const dependent = [];
  const addDependent = (id, requires, binary, args, expected) => {
    const blocked = requires.filter((name) => byId.get(name)?.status !== 'PASS');
    if (blocked.length) {
      dependent.push({ id, requires, status: 'NOT_EXECUTED', reason: `PREREQUISITE_NOT_PASS:${blocked.join(',')}` });
      return;
    }
    const capture = run(binary, args);
    const outcome = commandOutcome(capture);
    dependent.push({ id, requires, ...outcome, capture,
      expectedMatched: outcome.status === 'PASS' ? expected.test(capture.stdout + capture.stderr) : false });
    if (dependent.at(-1).status === 'PASS' && !dependent.at(-1).expectedMatched) {
      dependent.at(-1).status = 'FAIL'; dependent.at(-1).reason = 'UNEXPECTED_FUNCTIONAL_OUTPUT';
    }
  };
  addDependent('gdb-dap-import', ['gdb', 'python'], '/usr/bin/gdb',
    ['-q', '-nx', '-nh', '-batch', '-ex', 'python import gdb.dap; print("E4_GDB_DAP_READY")'], /E4_GDB_DAP_READY/u);
  addDependent('debugpy-import', ['python'], '/usr/bin/python3.14',
    ['-c', 'import sys; sys.path.insert(0, "/opt/phi/runtime/dap/python"); import debugpy; print(debugpy.__version__)'], /^1\.8\.22/mu);
  addDependent('rust-sysroot', ['rustc', 'ld.lld', 'gcc', 'target-gcc', 'ld', 'as'],
    '/usr/bin/rustc', ['--print', 'sysroot'], /^\/usr\s*$/u);
  addDependent('clangd-lsp', ['clangd', 'node'], '/usr/bin/node',
    ['/opt/phi/e4-clangd-lsp-smoke.mjs', '/usr/local/lib/phi/llvm/22.1.8/bin/clangd'], /^E4_CPP_LSP_SMOKE=PASS$/mu);
  const blockedCargo = ['cargo', 'rustc', 'ld.lld', 'gcc', 'target-gcc', 'as']
    .filter((name) => byId.get(name)?.status !== 'PASS');
  if (blockedCargo.length) dependent.push({ id: 'cargo-offline-compile',
    requires: ['cargo', 'rustc', 'ld.lld', 'gcc', 'target-gcc', 'as'],
    status: 'NOT_EXECUTED', reason: `PREREQUISITE_NOT_PASS:${blockedCargo.join(',')}` });
  else {
    let fixture;
    try {
      fixture = fs.mkdtempSync('/tmp/phi-e4-cargo-inventory-');
      fs.mkdirSync(path.join(fixture, 'src'));
      fs.writeFileSync(path.join(fixture, 'Cargo.toml'), '[package]\nname = "phi_e4_probe"\nversion = "0.1.0"\nedition = "2021"\n');
      fs.writeFileSync(path.join(fixture, 'src', 'main.rs'), 'fn main() { println!("E4_CARGO_READY"); }\n');
      const result = run('/usr/bin/cargo', ['build', '--offline', '--manifest-path', path.join(fixture, 'Cargo.toml'),
        '--target-dir', path.join(fixture, 'target')]);
      dependent.push({ id: 'cargo-offline-compile', requires: ['cargo', 'rustc', 'ld.lld', 'gcc', 'target-gcc', 'as'],
        ...commandOutcome(result), capture: result });
    } catch (error) {
      dependent.push({ id: 'cargo-offline-compile', requires: ['cargo', 'rustc', 'ld.lld', 'gcc', 'target-gcc', 'as'],
        status: 'FAIL', reason: `FIXTURE_${error.code ?? error.message}` });
    } finally {
      if (fixture) {
        try { fs.rmSync(fixture, { recursive: true, force: true }); }
        catch (error) {
          dependent.push({ id: 'cargo-fixture-cleanup', requires: [], status: 'FAIL',
            reason: `CLEANUP_${error.code ?? error.message}` });
        }
      }
    }
  }
  for (const name of ['crt1.o', 'Scrt1.o', 'crti.o', 'crtn.o', 'libgcc.a', 'libgcc_s.so', 'libc.so']) {
    if (byId.get('gcc')?.status !== 'PASS') {
      dependent.push({ id: `gcc-startfile:${name}`, requires: ['gcc'], status: 'NOT_EXECUTED',
        reason: 'PREREQUISITE_NOT_PASS:gcc' });
      continue;
    }
    const result = run('/usr/bin/gcc', [`-print-file-name=${name}`]);
    const outcome = commandOutcome(result);
    const selected = result.stdout?.trim() ?? '';
    const entry = { id: `gcc-startfile:${name}`, requires: ['gcc'], ...outcome,
      capture: result, selectedPath: selected, realpath: null, sha256: null };
    if (outcome.status === 'PASS') {
      try {
        if (!selected.startsWith('/')) throw new Error('NO_ABSOLUTE_SELECTION');
        const resolved = resolveRootfsPath(root, selected);
        if (!fs.statSync(resolved.physical).isFile()) throw new Error('NOT_REGULAR_FILE');
        entry.realpath = resolved.realpath;
        entry.sha256 = fileEvidence(resolved.physical).sha256;
      } catch (error) { entry.status = 'FAIL'; entry.reason = `STARTFILE_${error.code ?? error.message}`; }
    }
    dependent.push(entry);
  }
  for (const check of dependent) for (const prerequisite of check.requires) {
    const tool = byId.get(prerequisite);
    if (tool) tool.dependentChecks.push({ id: check.id, status: check.status });
  }
  const failures = [...tools, ...assets, ...dependent].filter((entry) => entry.status !== 'PASS')
    .map((entry) => ({ id: entry.id, status: entry.status, reason: entry.reason ?? 'UNRESOLVED' }));
  const body = { schema: INVENTORY_SCHEMA, mode: 'COMPLETE_EXECUTABLE_INVENTORY',
    candidateSha: /^[a-f0-9]{40}$/u.test(process.env.PHI_E4_CANDIDATE_SHA ?? '')
      ? process.env.PHI_E4_CANDIDATE_SHA : null,
    qualifying: false, rootfs: root === '/' ? 'CONTAINER_ROOT' : 'TEST_ROOTFS',
    tools, assets, dependent, failures, expectedToolCount: definitions.length,
    expectedAssetCount: runtimeAssets.length, assetCount: assets.length,
    toolCount: tools.length, passCount: tools.filter((item) => item.status === 'PASS').length };
  let bytes = Buffer.from(`${JSON.stringify(body)}\n`);
  const complete = bytes.length <= MAX_INVENTORY_BYTES && ![...tools, ...dependent].some((item) =>
    item.startup?.capture?.complete === false || item.dependencyClosure?.capture?.complete === false ||
    item.elfInspection?.programHeaders?.complete === false || item.elfInspection?.dynamic?.complete === false ||
    item.capture?.complete === false);
  if (bytes.length > MAX_INVENTORY_BYTES) {
    // Do not emit a silently shortened artifact; emit an explicit, bounded
    // acquisition failure with its original byte count instead.
    body.tools = []; body.assets = []; body.dependent = []; body.failures = [{ id: 'artifact', status: 'UNKNOWN', reason: 'DIAGNOSTIC_OUTPUT_TOO_LARGE' }];
    body.originalBytes = bytes.length;
    bytes = Buffer.from(`${JSON.stringify(body)}\n`);
  }
  return { body, bytes, receipt: { mode: body.mode, candidateSha: body.candidateSha,
    status: complete && failures.length === 0 ? 'PASS' : 'FAIL',
    qualifying: false, complete, artifact: { sha256: sha256(bytes), bytes: bytes.length },
    toolCount: body.toolCount, assetCount: body.assetCount,
    passCount: body.passCount, failureCount: body.failures.length } };
}

export function inventoryCertificationDecision(result) {
  const { body, receipt } = result;
  return receipt.complete === true && body.expectedToolCount === body.toolCount &&
    body.expectedAssetCount === body.assetCount && body.tools.length === body.toolCount &&
    body.assets.length === body.assetCount && body.failures.length === 0 &&
    body.tools.every((item) => item.status === 'PASS') &&
    body.tools.every((item) => item.functional?.status === 'PASS') &&
    body.assets.every((item) => item.status === 'PASS') &&
    body.dependent.every((item) => item.status === 'PASS');
}

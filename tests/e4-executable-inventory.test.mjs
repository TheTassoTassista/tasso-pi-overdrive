import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractExecutableInventory } from '../scripts/e4-extract-executable-inventory.mjs';
import { captureInventoryCommand, inventoryCertificationDecision, requiredExecutableInventory,
  resolveRootfsPath, runExecutableInventory } from '../scripts/e4-executable-inventory.mjs';

const repository = new URL('../', import.meta.url).pathname;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const good = (stdout = 'version 1\n') => ({ spawnStatus: 'SPAWNED_WITH_EXIT_RESULT',
  exitCode: 0, signal: null, errorCode: null, stdout, stderr: '', complete: true,
  stdoutComplete: true, stderrComplete: true });
const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('fixture')]);
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-inventory-'));
  const install = (logical, bytes = elf) => {
    const file = path.join(root, logical.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode: 0o755 });
    return file;
  };
  return { root, install, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
};
const fakeRun = (binary, args) => {
  if (binary === '/usr/bin/readelf') return good(args[0] === '-l'
    ? 'Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]\n'
    : 'Shared library: [libc.so.6]\n');
  if (binary === '/lib64/ld-linux-x86-64.so.2') return good('libc.so.6 => /usr/lib/libc.so.6\n');
  if (args[0] === '/opt/phi/e4-lsp-startup-smoke.mjs') return good(`E4_LSP_STARTUP=PASS id=${args[1]}\n`);
  if (args.some((arg) => String(arg).includes('gdb.dap'))) return good('E4_GDB_DAP_READY\n');
  if (args.some((arg) => String(arg).includes('debugpy'))) return good('1.8.22\n');
  if (args.includes('--print')) return good('/usr\n');
  if (args.includes('/opt/phi/e4-clangd-lsp-smoke.mjs')) return good('E4_CPP_LSP_SMOKE=PASS\n');
  return good();
};

test('actual inventory enumerates all seed, image, LSP and DAP executables without silent omission', () => {
  const f = fixture();
  try {
    for (const name of ['e4-toolchain-seeds.json', 'e4-llvm-toolchain.json', 'managed-lsp.json', 'ast-edit.json']) {
      const target = path.join(f.root, 'opt/phi/config', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repository, 'config', name), target);
    }
    const lock = path.join(f.root, 'opt/phi/runtime/lsp/package-lock.json');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.copyFileSync(path.join(repository, 'runtime/lsp/package-lock.json'), lock);
    const definitions = requiredExecutableInventory(f.root);
    assert.equal(definitions.length, 38);
    assert.equal(new Set(definitions.map((entry) => entry.id)).size, 38);
    for (const id of ['cargo', 'rustc', 'ld.lld', 'clangd', 'rust-analyzer', 'gopls',
      'gdb', 'python', 'node', 'gcc', 'target-gcc', 'readelf', 'elf-loader', 'chrome',
      'agent-browser', 'cmp', 'pi-cli', 'ast-grep', 'tsc', 'vtsls',
      'pyright-langserver', 'bash-language-server']) {
      assert.ok(definitions.some((entry) => entry.id === id), id);
    }
  } finally { f.cleanup(); }
});

test('complete 38-tool inventory still reaches the final independent server after Cargo fails', () => {
  const f = fixture();
  try {
    for (const name of ['e4-toolchain-seeds.json', 'e4-llvm-toolchain.json', 'managed-lsp.json', 'ast-edit.json']) {
      const target = path.join(f.root, 'opt/phi/config', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repository, 'config', name), target);
    }
    const lock = path.join(f.root, 'opt/phi/runtime/lsp/package-lock.json');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.copyFileSync(path.join(repository, 'runtime/lsp/package-lock.json'), lock);
    const definitions = requiredExecutableInventory(f.root).map((item) => ({
      ...item, expectedSha256: null, expectedVersion: null,
    }));
    for (const item of definitions) f.install(item.path);
    f.install('/usr/lib/libc.so.6');
    const calls = [];
    const run = (binary, args) => {
      calls.push([binary, ...args]);
      if (binary === '/usr/bin/cargo' && args[0] === '--version') return { ...good(''), exitCode: 127,
        stderr: 'cargo failed in fixture\n' };
      if (binary === '/usr/bin/gcc' && args[0]?.startsWith('-print-file-name=')) return good('/usr/lib/libc.so.6\n');
      return fakeRun(binary, args);
    };
    const result = runExecutableInventory({ root: f.root, definitions, run });
    assert.equal(result.body.expectedToolCount, 38);
    assert.equal(result.body.toolCount, 38);
    assert.equal(result.body.tools.at(-1).id, 'bash-language-server');
    assert.equal(result.body.tools.at(-1).status, 'PASS');
    assert.ok(calls.some(([binary, script, id]) => binary === '/usr/bin/node'
      && script === '/opt/phi/e4-lsp-startup-smoke.mjs' && id === 'bash-language-server'));
    assert.equal(result.body.tools.find((entry) => entry.id === 'cargo').status, 'FAIL');
    assert.equal(result.body.dependent.find((entry) => entry.id === 'cargo-offline-compile').status, 'NOT_EXECUTED');
    assert.equal(result.body.failures.some((entry) => entry.id === 'cargo'), true);
    assert.equal(inventoryCertificationDecision(result), false);
  } finally { f.cleanup(); }
});

test('real inventory continues independent tools after Cargo exit 127; dependent work is explicit', () => {
  const f = fixture();
  try {
    for (const binary of ['/usr/bin/cargo', '/usr/bin/node', '/usr/bin/python3.14',
      '/usr/bin/readelf', '/usr/bin/rustc', '/usr/bin/gdb', '/lib64/ld-linux-x86-64.so.2',
      '/usr/lib/libc.so.6']) f.install(binary);
    const definitions = ['cargo', 'node', 'python', 'rustc', 'gdb'].map((id) => ({
      id, path: { cargo: '/usr/bin/cargo', node: '/usr/bin/node', python: '/usr/bin/python3.14',
        rustc: '/usr/bin/rustc', gdb: '/usr/bin/gdb' }[id], reason: 'fixture',
      expectedSha256: hash(elf), versionArgs: ['--version'], dependencies: [],
    }));
    const run = (binary, args) => binary === '/usr/bin/cargo' && args[0] === '--version'
      ? { ...good(''), exitCode: 127, stderr: 'cargo: error while loading shared libraries: libgit2.so.1.9: cannot open\n' }
      : fakeRun(binary, args);
    const result = runExecutableInventory({ root: f.root, definitions, run });
    assert.equal(result.body.toolCount, 5);
    assert.equal(result.body.tools.find((entry) => entry.id === 'cargo').status, 'FAIL');
    assert.equal(result.body.tools.find((entry) => entry.id === 'cargo').startup.reason, 'PROCESS_EXIT_127');
    assert.equal(result.body.tools.find((entry) => entry.id === 'cargo').startup.capture.exitCode, 127);
    assert.equal(result.body.tools.find((entry) => entry.id === 'node').status, 'PASS');
    assert.equal(result.body.tools.find((entry) => entry.id === 'python').status, 'PASS');
    assert.equal(result.body.dependent.find((entry) => entry.id === 'clangd-lsp').status, 'NOT_EXECUTED');
    assert.equal(result.receipt.complete, true);
    assert.equal(inventoryCertificationDecision(result), false);
  } finally { f.cleanup(); }
});

test('spawn failure has no invented exit code and differs from actual process exit 127', () => {
  const f = fixture();
  try {
    for (const binary of ['/usr/bin/cargo', '/usr/bin/readelf', '/lib64/ld-linux-x86-64.so.2',
      '/usr/lib/libc.so.6']) f.install(binary);
    const definitions = [{ id: 'cargo', path: '/usr/bin/cargo', reason: 'fixture',
      expectedSha256: hash(elf), versionArgs: ['--version'] }];
    const spawnFailure = runExecutableInventory({ root: f.root, definitions,
      run: (binary, args) => binary === '/usr/bin/cargo' && args[0] === '--version'
        ? { ...good(''), spawnStatus: 'SPAWN_ERROR', exitCode: null, complete: false, errorCode: 'ENOENT' }
        : fakeRun(binary, args) });
    const cargo = spawnFailure.body.tools[0];
    assert.equal(cargo.startup.reason, 'SPAWN_ERROR');
    assert.equal(cargo.startup.capture.exitCode, null);
    assert.equal(spawnFailure.receipt.complete, false);
    assert.equal(inventoryCertificationDecision(spawnFailure), false);
  } finally { f.cleanup(); }
});

test('real inventory capture preserves both streams or explicitly marks overflow/incompleteness', () => {
  const complete = captureInventoryCommand(process.execPath, ['-e',
    'process.stdout.write("out\\n"); process.stderr.write("err\\n");']);
  assert.equal(complete.complete, true);
  assert.equal(complete.stdout, 'out\n');
  assert.equal(complete.stderr, 'err\n');
  assert.equal(complete.exitCode, 0);
  const overflow = captureInventoryCommand(process.execPath, ['-e',
    'process.stdout.write("x".repeat(40*1024));']);
  assert.equal(overflow.complete, false);
  assert.equal(overflow.spawnStatus, 'DIAGNOSTIC_OUTPUT_TOO_LARGE');
  assert.equal(overflow.stdoutComplete, false);
  const absent = captureInventoryCommand('/nonexistent/phi-e4-executable', []);
  assert.equal(absent.spawnStatus, 'SPAWN_ERROR');
  assert.equal(absent.exitCode, null);
});

test('broken rootfs symlink and missing ELF interpreter fail without host fallback', () => {
  const f = fixture();
  try {
    const target = path.join(f.root, 'usr/bin/cargo');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync('/missing/cargo', target);
    assert.throws(() => resolveRootfsPath(f.root, '/usr/bin/cargo'), { code: 'ENOENT' });
    let result = runExecutableInventory({ root: f.root, definitions: [{ id: 'cargo', path: '/usr/bin/cargo',
      reason: 'fixture', versionArgs: ['--version'] }], run: fakeRun });
    assert.equal(result.body.tools[0].status, 'FAIL');
    fs.rmSync(target);
    f.install('/usr/bin/cargo');
    f.install('/usr/bin/readelf');
    result = runExecutableInventory({ root: f.root, definitions: [{ id: 'cargo', path: '/usr/bin/cargo',
      reason: 'fixture', versionArgs: ['--version'] }], run: fakeRun });
    assert.equal(result.body.tools[0].status, 'FAIL');
    assert.match(result.body.tools[0].reason, /IDENTITY_OR_CLOSURE_ENOENT/u);
  } finally { f.cleanup(); }
});

test('missing library and path outside intended rootfs are recorded as closure failures', () => {
  const f = fixture();
  try {
    for (const binary of ['/usr/bin/cargo', '/usr/bin/readelf', '/lib64/ld-linux-x86-64.so.2']) f.install(binary);
    const definitions = [{ id: 'cargo', path: '/usr/bin/cargo', reason: 'fixture', versionArgs: ['--version'] }];
    const missing = runExecutableInventory({ root: f.root, definitions,
      run: (binary, args) => binary === '/lib64/ld-linux-x86-64.so.2' && args[0] === '--list'
        ? { ...good('libgit2.so.1.9 => not found\n'), exitCode: 127 } : fakeRun(binary, args) });
    assert.equal(missing.body.tools[0].dependencyClosure.reason, 'UNRESOLVED_SHARED_LIBRARY');
    const leaked = runExecutableInventory({ root: f.root, definitions,
      run: (binary, args) => binary === '/lib64/ld-linux-x86-64.so.2' && args[0] === '--list'
        ? good('libfoo.so => /home/host/libfoo.so\n') : fakeRun(binary, args) });
    assert.equal(leaked.body.tools[0].dependencyClosure.reason, 'LIBRARY_OUTSIDE_OWNED_ROOTFS');
    assert.equal(leaked.body.tools[0].status, 'FAIL');
  } finally { f.cleanup(); }
});

test('artifact transport verifies exact digest, count and non-qualification', () => {
  const f = fixture();
  try {
    f.install('/usr/bin/cargo'); f.install('/usr/bin/readelf');
    f.install('/lib64/ld-linux-x86-64.so.2'); f.install('/usr/lib/libc.so.6');
    const result = runExecutableInventory({ root: f.root, definitions: [{ id: 'cargo', path: '/usr/bin/cargo',
      reason: 'fixture', versionArgs: ['--version'] }], run: fakeRun });
    const raw = path.join(f.root, 'raw.log');
    const artifact = path.join(f.root, 'executable-inventory.json');
    fs.writeFileSync(raw, `E4_EXECUTABLE_INVENTORY_RECEIPT=${JSON.stringify(result.receipt)}\n` +
      `E4_EXECUTABLE_INVENTORY_ARTIFACT_BASE64=${result.bytes.toString('base64')}\n`);
    assert.deepEqual(extractExecutableInventory(raw, artifact), result.receipt);
    assert.equal(hash(fs.readFileSync(artifact)), result.receipt.artifact.sha256);
    assert.equal(result.body.qualifying, false);
  } finally { f.cleanup(); }
});

test('runner rejects a tampered inventory digest and a wrong candidate SHA', () => {
  const f = fixture();
  try {
    const raw = path.join(f.root, 'raw.log');
    const artifact = path.join(f.root, 'executable-inventory.json');
    const body = { schema: 'phi-e4-executable-inventory-v1', mode: 'COMPLETE_EXECUTABLE_INVENTORY',
      candidateSha: 'a'.repeat(40), qualifying: false, tools: [], assets: [], dependent: [],
      failures: [], expectedToolCount: 0, toolCount: 0, expectedAssetCount: 0, assetCount: 0, passCount: 0 };
    const bytes = Buffer.from(`${JSON.stringify(body)}\n`);
    const receipt = { qualifying: false, candidateSha: body.candidateSha, complete: true,
      artifact: { bytes: bytes.length, sha256: hash(bytes) }, toolCount: 0,
      assetCount: 0, passCount: 0, failureCount: 0 };
    const writeRaw = (entry) => fs.writeFileSync(raw,
      `E4_EXECUTABLE_INVENTORY_RECEIPT=${JSON.stringify(entry)}\n` +
      `E4_EXECUTABLE_INVENTORY_ARTIFACT_BASE64=${bytes.toString('base64')}\n`);
    writeRaw({ ...receipt, artifact: { ...receipt.artifact, sha256: '0'.repeat(64) } });
    assert.throws(() => extractExecutableInventory(raw, artifact, body.candidateSha));
    assert.equal(fs.existsSync(raw), true);
    assert.equal(fs.existsSync(artifact), false);
    writeRaw(receipt);
    assert.throws(() => extractExecutableInventory(raw, artifact, 'b'.repeat(40)), /candidate SHA mismatch/u);
    assert.equal(fs.existsSync(artifact), false);
  } finally { f.cleanup(); }
});

test('certification rejects every unresolved mandatory status and incomplete capture', () => {
  for (const status of ['FAIL', 'UNKNOWN', 'NOT_EXECUTED']) {
    const result = { receipt: { complete: true }, body: { expectedToolCount: 1, toolCount: 1,
      expectedAssetCount: 0, assetCount: 0, assets: [], tools: [{ status }], dependent: [], failures: [{ id: 'one', status }] } };
    assert.equal(inventoryCertificationDecision(result), false, status);
  }
  assert.equal(inventoryCertificationDecision({ receipt: { complete: false }, body: {
    expectedToolCount: 1, toolCount: 1, tools: [{ status: 'PASS' }], dependent: [], failures: [],
    expectedAssetCount: 0, assetCount: 0, assets: [],
  } }), false);
  const resolved = { receipt: { complete: true }, body: { expectedToolCount: 1, toolCount: 1,
    expectedAssetCount: 0, assetCount: 0, assets: [],
    tools: [{ status: 'PASS', functional: { status: 'PASS', kind: 'VERSION_STARTUP' } }],
    dependent: [], failures: [] } };
  assert.equal(inventoryCertificationDecision(resolved), true);
  resolved.body.tools[0].functional.status = 'NOT_EXECUTED';
  assert.equal(inventoryCertificationDecision(resolved), false);
});

test('fixture command failure is recorded without abandoning independent inventory', () => {
  const f = fixture();
  try {
    for (const binary of ['/usr/bin/cargo', '/usr/bin/rustc', '/usr/bin/ld.lld',
      '/usr/bin/gcc', '/usr/bin/x86_64-linux-gnu-gcc', '/usr/bin/as',
      '/usr/bin/readelf', '/lib64/ld-linux-x86-64.so.2', '/usr/lib/libc.so.6']) f.install(binary);
    const definitions = ['cargo', 'rustc', 'ld.lld', 'gcc', 'target-gcc', 'as'].map((id) => ({
      id, path: { cargo: '/usr/bin/cargo', rustc: '/usr/bin/rustc', 'ld.lld': '/usr/bin/ld.lld',
        gcc: '/usr/bin/gcc', 'target-gcc': '/usr/bin/x86_64-linux-gnu-gcc', as: '/usr/bin/as' }[id],
      versionArgs: ['--version'], reason: 'fixture', expectedVersion: null,
    }));
    const run = (binary, args) => {
      if (binary === '/usr/bin/cargo' && args[0] === 'build') throw new Error('fixture command failed');
      if (binary === '/usr/bin/gcc' && args[0]?.startsWith('-print-file-name=')) return good('/usr/lib/libc.so.6\n');
      return fakeRun(binary, args);
    };
    const result = runExecutableInventory({ root: f.root, definitions, run });
    assert.equal(result.body.dependent.find((entry) => entry.id === 'cargo-offline-compile').status, 'FAIL');
    assert.match(result.body.dependent.find((entry) => entry.id === 'cargo-offline-compile').reason, /^FIXTURE_/u);
    assert.equal(result.body.dependent.find((entry) => entry.id === 'gcc-startfile:libc.so').status, 'PASS');
    assert.equal(result.body.tools.length, definitions.length);
  } finally { f.cleanup(); }
});

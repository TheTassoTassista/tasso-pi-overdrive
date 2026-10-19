import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractExecutableInventory } from '../scripts/e4-extract-executable-inventory.mjs';
import { captureInventoryCommand, inventoryCertificationDecision, requiredExecutableInventory, requiredRuntimeAssets,
  inventoryHarnessSelfTest, resolveRootfsPath, runExecutableInventory } from '../scripts/e4-executable-inventory.mjs';

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
    const assets = requiredRuntimeAssets(f.root);
    for (const [name, installedPath] of [
      ['libgit2-1.9.7-cargo-runtime', '/usr/lib/libgit2.so.1.9.7'],
      ['llhttp-9.3.1-libgit2-runtime', '/usr/lib/libllhttp.so.9.3.1'],
    ]) {
      const asset = assets.find((entry) => entry.id === `${name}:${installedPath}`);
      assert.ok(asset, `${name} must be a mandatory asset`);
      assert.match(asset.expectedSha256, /^[a-f0-9]{64}$/u);
    }
  } finally { f.cleanup(); }
});

test('root slash resolves an existing executable, while host inventory fails before manifest reads', () => {
  if (process.platform !== 'linux') return;
  const resolved = resolveRootfsPath('/', '/usr/bin/true');
  assert.equal(resolved.physical, '/usr/bin/true');
  assert.equal(fs.statSync(resolved.physical).isFile(), true);
  assert.equal(resolveRootfsPath('/', '/usr/./bin/true').realpath, resolved.realpath);
  const forbidden = runExecutableInventory();
  assert.equal(forbidden.receipt.harnessStatus, 'DIAGNOSTIC_HARNESS_INVALID');
  assert.equal(forbidden.receipt.complete, false);
  assert.equal(forbidden.body.tools.length, 0);
  assert.equal(forbidden.body.assets.length, 0);
  assert.match(forbidden.body.failures[0].reason, /^DIAGNOSTIC_HARNESS_INVALID:/u);
  const raw = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-invalid-harness-')), 'raw.log');
  try {
    const artifact = path.join(path.dirname(raw), 'executable-inventory.json');
    fs.writeFileSync(raw, `E4_EXECUTABLE_INVENTORY_RECEIPT=${JSON.stringify(forbidden.receipt)}\n` +
      `E4_EXECUTABLE_INVENTORY_ARTIFACT_BASE64=${forbidden.bytes.toString('base64')}\n`);
    assert.equal(extractExecutableInventory(raw, artifact).harnessStatus, 'DIAGNOSTIC_HARNESS_INVALID');
    assert.equal(JSON.parse(fs.readFileSync(artifact, 'utf8')).tools.length, 0);
  } finally { fs.rmSync(path.dirname(raw), { recursive: true, force: true }); }
});

test('nonroot containment rejects traversal and host symlink escape but retains internal links', () => {
  const f = fixture();
  const sibling = `${f.root}-other`;
  try {
    f.install('/usr/bin/tool');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'outside'), 'host-only');
    fs.symlinkSync('../bin/tool', path.join(f.root, 'usr/bin/tool-link'));
    assert.equal(resolveRootfsPath(f.root, '/usr/bin/tool-link').realpath, '/usr/bin/tool');
    fs.symlinkSync('/usr/bin/tool', path.join(f.root, 'usr/bin/absolute-link'));
    assert.equal(resolveRootfsPath(f.root, '/usr/bin/absolute-link').realpath, '/usr/bin/tool');
    fs.symlinkSync(path.join(sibling, 'outside'), path.join(f.root, 'usr/bin/external'));
    assert.throws(() => resolveRootfsPath(f.root, '/usr/bin/external'), { code: 'ENOENT' });
    fs.symlinkSync('../../../../outside', path.join(f.root, 'usr/bin/traversal'));
    assert.throws(() => resolveRootfsPath(f.root, '/usr/bin/traversal'), /ROOTFS_ESCAPE/u);
    assert.throws(() => resolveRootfsPath(f.root, '/../usr/bin/tool'), /ROOTFS_TRAVERSAL/u);
    assert.throws(() => resolveRootfsPath(f.root, '/usr/../usr/bin/tool'), /ROOTFS_TRAVERSAL/u);
    for (const invalid of ['', 'usr/bin/tool', '//usr/bin/tool', '/usr/bin/\0tool', '/usr\\bin\\tool']) {
      assert.throws(() => resolveRootfsPath(f.root, invalid), /INVALID_ROOTFS_PATH/u);
    }
    assert.throws(() => resolveRootfsPath(sibling, '/usr/bin/tool'), { code: 'ENOENT' });
    const alias = `${f.root}-alias`;
    fs.symlinkSync(f.root, alias);
    try { assert.throws(() => resolveRootfsPath(alias, '/usr/bin/tool'), /ALIASED_ROOTFS_ROOT/u); }
    finally { fs.rmSync(alias); }
  } finally { f.cleanup(); fs.rmSync(sibling, { recursive: true, force: true }); }
});

test('image root identity hashes are bound to current pinned manifests', () => {
  const source = fs.readFileSync(path.join(repository, 'scripts/e4-executable-inventory.mjs'), 'utf8');
  for (const [name, constant] of [['e4-toolchain-seeds.json', 'E4_SEED_MANIFEST_SHA256'],
    ['e4-llvm-toolchain.json', 'E4_LLVM_MANIFEST_SHA256']]) {
    const actual = hash(fs.readFileSync(path.join(repository, 'config', name)));
    assert.match(source, new RegExp(`const ${constant} = '${actual}'`, 'u'));
  }
});

test('genuine fixture identities, dependent call, negative result and receipt reconcile', () => {
  const f = fixture();
  try {
    const manifest = Buffer.from('{"fixture":true}\n');
    f.install('/usr/bin/true');
    f.install('/opt/phi/config/e4-toolchain-seeds.json', manifest);
    f.install('/usr/bin/gdb'); f.install('/usr/bin/python3.14');
    f.install('/usr/bin/readelf'); f.install('/lib64/ld-linux-x86-64.so.2');
    f.install('/usr/lib/libc.so.6');
    assert.equal(inventoryHarnessSelfTest(f.root, hash(manifest)).status, 'PASS');
    const definitions = [
      { id: 'gdb', path: '/usr/bin/gdb', versionArgs: ['--version'], expectedSha256: hash(elf) },
      { id: 'python', path: '/usr/bin/python3.14', versionArgs: ['--version'], expectedSha256: hash(elf) },
      { id: 'missing', path: '/usr/bin/missing', versionArgs: ['--version'] },
    ];
    const calls = [];
    const run = (binary, args) => { calls.push([binary, ...args]); return fakeRun(binary, args); };
    const result = runExecutableInventory({ root: f.root, definitions, runtimeAssets: [{
      id: 'fixture-asset', path: '/opt/phi/config/e4-toolchain-seeds.json',
      expectedSha256: hash(manifest),
    }], run });
    assert.equal(result.body.tools.find((item) => item.id === 'gdb').status, 'PASS');
    assert.equal(result.body.tools.find((item) => item.id === 'gdb').sha256, hash(elf));
    assert.equal(result.body.assets[0].status, 'PASS');
    assert.equal(result.body.assets[0].sha256, hash(manifest));
    assert.equal(result.body.tools.find((item) => item.id === 'missing').status, 'FAIL');
    assert.equal(result.body.dependent.find((item) => item.id === 'gdb-dap-import').status, 'PASS');
    assert.ok(calls.some((args) => args.join(' ').includes('python import gdb.dap')));
    assert.equal(result.body.expectedToolCount, 3);
    assert.equal(result.body.toolCount, 3);
    assert.equal(result.body.expectedAssetCount, 1);
    assert.equal(result.body.assetCount, 1);
    assert.equal(result.receipt.failureCount, result.body.failures.length);
    assert.equal(result.receipt.artifact.sha256, hash(result.bytes));
    assert.equal(result.receipt.status, 'FAIL');
    assert.equal(result.receipt.harnessStatus, 'PASS');
    assert.equal(inventoryCertificationDecision(result), false);
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
      if (binary === '/usr/bin/gcc' && args[0]?.startsWith('-print-file-name='))
        return { ...good('/usr/lib/libc.so.6\n'), command: [binary, ...args] };
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
  const resolved = { receipt: { complete: true }, body: { harness: { status: 'PASS' },
    expectedToolCount: 1, toolCount: 1,
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
      if (binary === '/usr/bin/gcc' && args[0]?.startsWith('-print-file-name='))
        return { ...good('/usr/lib/libc.so.6\n'), command: [binary, ...args] };
      return fakeRun(binary, args);
    };
    const result = runExecutableInventory({ root: f.root, definitions, run });
    assert.equal(result.body.dependent.find((entry) => entry.id === 'cargo-offline-compile').status, 'FAIL');
    assert.match(result.body.dependent.find((entry) => entry.id === 'cargo-offline-compile').reason, /^FIXTURE_/u);
    assert.equal(result.body.dependent.find((entry) => entry.id === 'gcc-startfile:libc.so').status, 'PASS');
    assert.equal(result.body.tools.length, definitions.length);
  } finally { f.cleanup(); }
});

test('approved GCC startfile captures canonicalize all five historical parent paths with physical evidence', () => {
  const f = fixture();
  try {
    for (const binary of ['/usr/bin/gcc', '/usr/bin/readelf', '/lib64/ld-linux-x86-64.so.2',
      '/usr/lib/libc.so.6']) f.install(binary);
    const names = ['crt1.o', 'Scrt1.o', 'crti.o', 'crtn.o', 'libc.so'];
    for (const name of names) f.install(`/usr/lib/${name}`, Buffer.from(`verified-${name}\n`));
    for (const name of ['libgcc.a', 'libgcc_s.so']) f.install(`/usr/lib/${name}`);
    const definitions = [{ id: 'gcc', path: '/usr/bin/gcc', reason: 'fixture',
      expectedSha256: hash(elf), versionArgs: ['--version'] }];
    const run = (binary, args) => binary === '/usr/bin/gcc' && args[0]?.startsWith('-print-file-name=')
      ? { ...good(`/usr/lib/gcc/x86_64-pc-linux-gnu/16/../../../../lib/${args[0].split('=')[1]}\n`),
        command: [binary, ...args] } : fakeRun(binary, args);
    fs.mkdirSync(path.join(f.root, 'usr/lib/gcc/x86_64-pc-linux-gnu/16'), { recursive: true });
    const result = runExecutableInventory({ root: f.root, definitions, run });
    for (const name of names) {
      const entry = result.body.dependent.find((item) => item.id === `gcc-startfile:${name}`);
      assert.equal(entry.status, 'PASS', `${name}: ${entry.reason}`);
      assert.equal(entry.realpath, `/usr/lib/${name}`);
      assert.equal(entry.sha256, hash(Buffer.from(`verified-${name}\n`)));
      assert.equal(entry.provenance.kind, 'CAPTURED_APPROVED_GCC');
      assert.deepEqual(entry.provenance.command, ['/usr/bin/gcc', `-print-file-name=${name}`]);
      assert.equal(entry.provenance.producerSha256, hash(elf));
      assert.equal(entry.selectedPath, `/usr/lib/gcc/x86_64-pc-linux-gnu/16/../../../../lib/${name}`);
    }
    assert.throws(() => resolveRootfsPath(f.root, '/usr/lib/gcc/x86_64-pc-linux-gnu/16/../../../../lib/crt1.o'),
      /ROOTFS_TRAVERSAL/u);
  } finally { f.cleanup(); }
});

test('GCC parent-path exception rejects command spoofing, incomplete capture, escape and missing physical file', () => {
  const f = fixture();
  try {
    for (const binary of ['/usr/bin/gcc', '/usr/bin/readelf', '/lib64/ld-linux-x86-64.so.2',
      '/usr/lib/libc.so.6']) f.install(binary);
    f.install('/usr/lib/crt1.o');
    const definitions = [{ id: 'gcc', path: '/usr/bin/gcc', reason: 'fixture',
      expectedSha256: hash(elf), versionArgs: ['--version'] }];
    const probe = (capture) => runExecutableInventory({ root: f.root, definitions,
      run: (binary, args) => binary === '/usr/bin/gcc' && args[0] === '-print-file-name=crt1.o'
        ? capture : fakeRun(binary, args) }).body.dependent.find((item) => item.id === 'gcc-startfile:crt1.o');
    const base = { ...good('/usr/lib/crt1.o\n'), command: ['/usr/bin/gcc', '-print-file-name=crt1.o'] };
    assert.match(probe({ ...base, command: ['/usr/bin/gcc', '-print-file-name=libc.so'] }).reason,
      /STARTFILE_GCC_OUTPUT_PROVENANCE/u);
    assert.match(probe({ ...base, stdoutComplete: false }).reason, /STARTFILE_GCC_OUTPUT_INCOMPLETE/u);
    assert.match(probe({ ...base, stdout: '/../../usr/lib/crt1.o\n' }).reason, /STARTFILE_ROOTFS_ESCAPE/u);
    assert.match(probe({ ...base, stdout: '/usr/lib/missing.o\n' }).reason, /STARTFILE_ENOENT/u);
    assert.match(probe({ ...base, stdout: '/usr/lib/crt1.o\n/usr/lib/other.o\n' }).reason,
      /STARTFILE_GCC_OUTPUT_INVALID/u);
    assert.equal(probe(base).status, 'PASS');
  } finally { f.cleanup(); }
});

test('captured GCC paths resolve physical symlinks before parent components and reject symlink escape', () => {
  const f = fixture();
  try {
    for (const binary of ['/usr/bin/gcc', '/usr/bin/readelf', '/lib64/ld-linux-x86-64.so.2',
      '/usr/lib/libc.so.6']) f.install(binary);
    f.install('/usr/lib/crt1.o', Buffer.from('physical-startfile'));
    fs.mkdirSync(path.join(f.root, 'usr/lib/gcc'), { recursive: true });
    fs.symlinkSync('/usr/lib', path.join(f.root, 'usr/lib/gcc/inside'));
    const definitions = [{ id: 'gcc', path: '/usr/bin/gcc', reason: 'fixture',
      expectedSha256: hash(elf), versionArgs: ['--version'] }];
    const probe = (selected) => runExecutableInventory({ root: f.root, definitions,
      run: (binary, args) => binary === '/usr/bin/gcc' && args[0] === '-print-file-name=crt1.o'
        ? { ...good(`${selected}\n`), command: [binary, ...args] } : fakeRun(binary, args) })
      .body.dependent.find((item) => item.id === 'gcc-startfile:crt1.o');
    const inside = probe('/usr/lib/gcc/inside/../lib/crt1.o');
    assert.equal(inside.status, 'PASS');
    assert.equal(inside.realpath, '/usr/lib/crt1.o');
    assert.equal(inside.sha256, hash(Buffer.from('physical-startfile')));
    assert.deepEqual(inside.symlinks, [{ path: '/usr/lib/gcc/inside', target: '/usr/lib' }]);
    fs.symlinkSync('../../../../outside', path.join(f.root, 'usr/lib/gcc/escape'));
    assert.match(probe('/usr/lib/gcc/escape/../lib/crt1.o').reason, /STARTFILE_ROOTFS_ESCAPE/u);
  } finally { f.cleanup(); }
});

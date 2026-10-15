import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('config/e4-llvm-toolchain.json'));

test('E4 LLVM contract binds one official release, archive, managed clangd and no compiler migration', () => {
  assert.equal(manifest.releaseTag, 'llvmorg-22.1.8');
  assert.equal(manifest.assetId, 449438700);
  assert.equal(manifest.archiveName, 'LLVM-22.1.8-Linux-X64.tar.xz');
  assert.equal(manifest.archiveSize, 1938859476);
  assert.equal(manifest.archiveSha256, 'df0e1ecf16caf3489a272a5eea4eec9b0d82878f6477fa309504f918a0006384');
  assert.equal(manifest.archiveMember, 'LLVM-22.1.8-Linux-X64/bin/clangd');
  assert.equal(manifest.clangdPath, '/usr/local/lib/phi/llvm/22.1.8/bin/clangd');
  assert.equal(manifest.clangdVersion, '22.1.8');
  assert.equal(manifest.clangdSize, 106012688);
  assert.equal(manifest.clangdSha256, 'aacb4651e1886b98c5413369fc1789f4ca2d4fa5b94fdf0de4f48c98a52d4324');
  const dockerfile = read('certification/Dockerfile.e4');
  assert.ok(dockerfile.includes(manifest.archiveUrl));
  assert.ok(dockerfile.includes(manifest.archiveSha256));
  assert.ok(dockerfile.includes(manifest.clangdSha256));
  assert.doesNotMatch(dockerfile, /\bgcc clang make\b|pacman[^\n]*\bclang\b/u);
  assert.match(dockerfile, /--strip-components=1 -C \/usr\/local\/lib\/phi\/llvm\/22\.1\.8/u);
});

test('C/C++ LSP resolves an absolute binary, never a PATH-injected clangd 23', () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-clangd23-'));
  try {
    fs.writeFileSync(path.join(fake, 'clangd'), '#!/bin/sh\necho "clangd version 23.1.1"\n', { mode: 0o755 });
    const probe = `import { lspRuntimeStatus } from ${JSON.stringify(path.join(root, 'lib/lsp-manager.mjs'))}; console.log(JSON.stringify(lspRuntimeStatus().languages.clangd));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8', env: { ...process.env, PATH: `${fake}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 0, result.stderr);
    const policy = JSON.parse(result.stdout);
    assert.equal(policy.version, 'clangd@22.1.8');
    assert.notEqual(policy.binaryPath, path.join(fake, 'clangd'));
    assert.ok(['/usr/bin/clangd', manifest.clangdPath].includes(policy.binaryPath));
    const selfcheck = read('scripts/e4-image-selfcheck.mjs');
    assert.match(selfcheck, /fs\.existsSync\('\/usr\/bin\/clangd'\), false/u);
    assert.match(selfcheck, /lspRuntimeStatus\(\)\.languages\.clangd\.binaryPath, llvm\.clangdPath/u);
    assert.match(selfcheck, /fileIdentity\(llvm\.clangdPath, llvm\.clangdSha256\)/u);
    assert.match(selfcheck, /\^clangd version 22\\\.1\\\.8/u);
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

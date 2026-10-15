#!/usr/bin/env node
// Runs inside the frozen E4 image without network or provider credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = '/opt/phi';
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

try {
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
  assert.equal(manifest.assets.length, 10);
  const byName = new Map(manifest.assets.map((item) => [item.logicalName, item]));
  for (const asset of manifest.assets) {
    for (const item of asset.extracted) fileIdentity(item.installedPath, item.sha256);
  }
  const nodeSeed = byName.get('nodejs-26.8.2');
  const simdjson = byName.get('simdjson-4.6.11-node-runtime')?.runtimeDependency;
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
  command('/usr/bin/rustc', ['--version'], /^rustc 1\.98\.1/mu);
  command('/usr/bin/cargo', ['--version'], /^cargo 1\.98\.1/mu);
  assert.equal(command('/usr/bin/rustc', ['--print', 'sysroot'], /^\/usr\n?$/u).trim(), '/usr');
  const rustProbe = fs.mkdtempSync('/tmp/phi-e4-rust-');
  try {
    const executable = path.join(rustProbe, 'smoke');
    const compiled = spawnSync('/usr/bin/rustc', ['--edition=2021', '-', '-o', executable], {
      input: 'fn main() { println!("E4_RUST_SYSROOT_READY"); }\n', encoding: 'utf8',
      timeout: 15000, maxBuffer: 1024 * 1024, cwd: rustProbe,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
    });
    assert.equal(compiled.status, 0, `seeded Rust/sysroot compile failed: ${compiled.stderr}`);
    command(executable, [], /^E4_RUST_SYSROOT_READY$/mu);
  } finally {
    fs.rmSync(rustProbe, { recursive: true, force: true });
  }
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
  console.log('E4_IMAGE_SELFCHECK=PASS');
  console.log('E4_IMAGE_TOOL_IDENTITIES=PASS');
  console.log('E4_IMAGE_NODE_ELF_CLOSURE=PASS');
  console.log('E4_IMAGE_PI_SUBAGENTS_JITI=PASS');
  console.log('E4_IMAGE_PHI_MOUNTPOINT=PASS');
  console.log('E4_IMAGE_FOCUSED_TESTS=PASS');
} catch (error) {
  console.error(`E4_IMAGE_SELFCHECK=FAIL reason=${String(error.message).slice(0, 300)}`);
  process.exitCode = 1;
}

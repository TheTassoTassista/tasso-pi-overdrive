import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = (suffix) => { throw new Error(`PHI_WINDOWS_BUILD_${suffix}`); };
export function buildWindowsProcess() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('PLATFORM_UNSUPPORTED');
  const system = process.env.SystemRoot;
  if (typeof system !== 'string' || !/^[A-Za-z]:[\\/]/u.test(system) || system.includes('\0')) fail('COMPILER_MISSING');
  const framework = path.join(system, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const compiler = path.join(framework, 'csc.exe');
  const references = ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'].map((name) => path.join(framework, name));
  for (const file of [compiler, ...references]) if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fail('COMPILER_MISSING');
  const source = path.join(root, 'platform', 'windows', 'native', 'OwnedProcess.cs');
  const confinementSource = path.join(root, 'platform', 'windows', 'native', 'AppContainerScope.cs');
  const recoverySource = path.join(root, 'platform', 'windows', 'native', 'ScopeRecovery.cs');
  const recoveryFilesystemSource = path.join(root, 'platform', 'windows', 'native', 'RecoveryFilesystem.cs');
  const anchoredFileSource = path.join(root, 'platform', 'windows', 'native', 'AnchoredFile.cs');
  const brokerSource = path.join(root, 'platform', 'windows', 'native', 'ExecutionBroker.cs');
  for (const file of [recoverySource, recoveryFilesystemSource, anchoredFileSource, brokerSource]) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_PATH');
  }
  const sourceStat = fs.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat?.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) fail('UNSAFE_PATH');
  const confinementStat = fs.lstatSync(confinementSource, { throwIfNoEntry: false });
  if (!confinementStat?.isFile() || confinementStat.isSymbolicLink() || confinementStat.nlink !== 1) fail('UNSAFE_PATH');
  const cache = path.join(root, '.phi-cache'), platform = path.join(cache, 'windows'), build = path.join(platform, 'process');
  for (const directory of [root, cache, platform, build]) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('UNSAFE_PATH');
    if (!stat) fs.mkdirSync(directory);
  }
  const binary = path.join(build, 'phi-owned-process.exe'), manifest = path.join(build, 'manifest.json');
  for (const file of [binary, manifest]) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024)) fail('UNSAFE_PATH');
  }
  if (fs.existsSync(binary)) {
    if (!fs.existsSync(manifest)) fail('STATE_INVALID');
    let record;
    try { record = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/u, '')); } catch { fail('STATE_INVALID'); }
    if (record.schemaVersion !== 1 || record.abi !== 1 || record.sourceSha256 !== hash(source) || record.confinementSourceSha256 !== hash(confinementSource) || record.recoverySourceSha256 !== hash(recoverySource) || record.recoveryFilesystemSourceSha256 !== hash(recoveryFilesystemSource) || record.anchoredFileSourceSha256 !== hash(anchoredFileSource) || record.brokerSourceSha256 !== hash(brokerSource) || record.binarySha256 !== hash(binary)) fail('IDENTITY_MISMATCH');
    return { status: 'ALREADY_BUILT', abi: 1, scope: 'TRUSTED_PROCESS_OWNERSHIP_NOT_SANDBOX' };
  }
  if (fs.existsSync(manifest)) fail('STATE_INVALID');
  // Fixed system compiler and explicit references: no PowerShell runtime,
  // command string, ambient response file, downloaded SDK or host policy change.
  const args = ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x64', '/optimize+', ...references.map((file) => `/reference:${file}`), `/out:${binary}`, source, confinementSource, recoverySource, recoveryFilesystemSource, anchoredFileSource, brokerSource];
  const compile = spawnSync(compiler, args, { cwd: root, shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  if (compile.status !== 0) {
    const codes = [...new Set(`${compile.stdout}\n${compile.stderr}`.match(/\bCS\d{4}\b/gu) ?? [])].slice(0, 8);
    if (codes.length) process.stderr.write(`${codes.join(' ')}\n`);
    fail('COMPILE_FAILED');
  }
  const version = spawnSync(binary, ['--version'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  if (version.status !== 0 || !version.stdout.startsWith('Phi owned-process ABI 1;')) fail('ABI_FAILED');
  const record = { schemaVersion: 1, abi: 1, sourceSha256: hash(source), confinementSourceSha256: hash(confinementSource), recoverySourceSha256: hash(recoverySource), recoveryFilesystemSourceSha256: hash(recoveryFilesystemSource), anchoredFileSourceSha256: hash(anchoredFileSource), brokerSourceSha256: hash(brokerSource), binarySha256: hash(binary) };
  fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`, { flag: 'wx' });
  return { status: 'BUILT', abi: 1, scope: 'TRUSTED_PROCESS_OWNERSHIP_NOT_SANDBOX' };
}

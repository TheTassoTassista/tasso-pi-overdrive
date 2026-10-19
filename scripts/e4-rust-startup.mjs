import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const bounded = (value) => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, ' ').slice(0, 320);
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function classifyRustStartup(stderr, interpreterExists) {
  if (!interpreterExists) return { category: 'MISSING_ELF_INTERPRETER', missingLibraries: [] };
  const missing = [...String(stderr ?? '').matchAll(/error while loading shared libraries: ([A-Za-z0-9_.+-]+): cannot open shared object file/gu)]
    .map((match) => match[1]);
  return { category: missing.length ? 'MISSING_SHARED_LIBRARY' : 'UNKNOWN', missingLibraries: [...new Set(missing)] };
}

export function rustStartupEvidence(binary, expectedSha256) {
  assert.equal(fs.lstatSync(binary).isFile(), true, 'Rust executable is not a regular file');
  const realpath = fs.realpathSync(binary);
  assert.equal(realpath, binary, 'Rust executable is not at its canonical image path');
  const sha256 = digest(binary);
  assert.equal(sha256, expectedSha256, 'Rust executable digest mismatch');
  const elf = spawnSync('/usr/bin/readelf', ['-lW', binary], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(elf.status, 0, 'Rust ELF inspection failed');
  const ptInterp = /\[Requesting program interpreter: (\/[^\]\n]+)\]/u.exec(elf.stdout)?.[1];
  assert.ok(ptInterp, 'Rust PT_INTERP absent');
  const interpreterExists = fs.existsSync(ptInterp);
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', HOME: '/tmp', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const stdout = bounded(result.stdout);
  const stderr = bounded(result.stderr);
  const failure = classifyRustStartup(stderr, interpreterExists);
  return {
    pass: result.status === 0 && !result.error && /^rustc 1\.98\.1(?:\s|$)/u.test(stdout),
    evidence: {
      path: binary, realpath, sha256, ptInterp, interpreterExists,
      exitCode: result.status, errorCode: result.error?.code ?? null,
      stdout, stderr,
      category: result.status === 0 && !result.error ? 'NONE' : failure.category,
      missingLibraries: failure.missingLibraries,
    },
  };
}

// This is metadata-only failure evidence for the existing image self-check.
// In particular, a failed exec alone cannot distinguish noexec from modes/LSM.
const mode = (stat) => (stat.mode & 0o7777).toString(8).padStart(4, '0');
const observed = (fn) => {
  try { return fn(); } catch { return 'UNKNOWN'; }
};
const unescapeMount = (value) => value.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));

export function containingMount(file, mountinfo) {
  if (typeof mountinfo !== 'string') return 'UNKNOWN';
  const mounts = [];
  for (const line of mountinfo.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(' ');
    if (left.length < 6) continue;
    const target = unescapeMount(left[4]);
    if (target !== '/' && !file.startsWith(`${target}/`) && file !== target) continue;
    mounts.push({ target, flags: left[5].split(',').filter((flag) => /^(?:ro|rw|exec|noexec|nosuid|nodev)$/u.test(flag)) });
  }
  mounts.sort((a, b) => b.target.length - a.target.length);
  return mounts[0] ?? 'UNKNOWN';
}

export function rustSmokeExecEvidence(binary, result, options = {}) {
  const stat = options.stat ?? fs.statSync;
  const realpath = options.realpath ?? fs.realpathSync;
  const readFile = options.readFile ?? fs.readFileSync;
  const spawn = options.spawn ?? spawnSync;
  const file = observed(() => {
    const details = stat(binary);
    return { path: binary, realpath: realpath(binary), mode: mode(details), uid: details.uid, gid: details.gid,
      regular: details.isFile(), size: details.size };
  });
  const directories = [];
  for (let directory = path.dirname(binary);; directory = path.dirname(directory)) {
    directories.push(observed(() => {
      const details = stat(directory);
      return { path: directory, mode: mode(details), uid: details.uid, gid: details.gid };
    }));
    if (directory === '/') break;
  }
  const mount = observed(() => {
    const mountinfo = readFile('/proc/self/mountinfo', 'utf8');
    return mountinfo.length <= 128 * 1024 ? containingMount(binary, mountinfo) : 'UNKNOWN';
  });
  const mountExec = mount === 'UNKNOWN' ? 'UNKNOWN' : mount.flags.includes('noexec') ? 'NOEXEC' : 'EXEC';
  const elfInterpreter = observed(() => {
    const elf = spawn('/usr/bin/readelf', ['-h', '-lW', binary], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    if (elf.status !== 0 || elf.error) return 'UNKNOWN';
    const elfType = /\bType:\s+(EXEC|DYN)\b/u.exec(elf.stdout)?.[1] ?? 'UNKNOWN';
    const interpreter = /\[Requesting program interpreter: (\/[A-Za-z0-9_./+-]+)\]/u.exec(elf.stdout)?.[1];
    if (!interpreter) return 'UNKNOWN';
    const details = observed(() => stat(interpreter));
    return { path: interpreter, elfType, exists: details !== 'UNKNOWN',
      mode: details === 'UNKNOWN' ? 'UNKNOWN' : mode(details),
      uid: details === 'UNKNOWN' ? 'UNKNOWN' : details.uid,
      gid: details === 'UNKNOWN' ? 'UNKNOWN' : details.gid };
  });
  const lsm = observed(() => {
    const profile = readFile('/proc/self/attr/current', 'utf8').trim();
    return /^[A-Za-z0-9_ .:/()+-]{1,160}$/u.test(profile) ? profile : 'UNKNOWN';
  });
  return { file, directories, mount, elfInterpreter, lsm,
    mountExec, lsmDenial: 'UNKNOWN',
    executingUid: observed(() => process.getuid()), executingGid: observed(() => process.getgid()),
    errorCode: result?.error?.code ?? null, exitCode: result?.status ?? null, signal: result?.signal ?? null };
}

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
const safeOutput = (value) => {
  const output = String(value ?? '');
  const bytes = Buffer.from(output, 'utf8');
  return { text: bytes.subarray(0, 2048).toString('utf8'), bytes: bytes.length, complete: bytes.length <= 2048 };
};
const accessX = (file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return { allowed: true, errorCode: null }; }
  catch (error) { return { allowed: false, errorCode: /^[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'UNKNOWN' }; }
};
const metadata = (details) => ({ mode: mode(details), uid: details.uid, gid: details.gid,
  size: details.size, type: details.isFile() ? 'FILE' : details.isDirectory() ? 'DIRECTORY' :
    details.isSymbolicLink() ? 'SYMLINK' : 'OTHER', executableBits: (details.mode & 0o111) !== 0 });

export function containingMount(file, mountinfo) {
  if (typeof mountinfo !== 'string') return 'UNKNOWN';
  const mounts = [];
  for (const line of mountinfo.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    if (left.length < 6 || right.length < 3 || !/^\d+$/u.test(left[0])) continue;
    const target = unescapeMount(left[4]);
    if (target !== '/' && !file.startsWith(`${target}/`) && file !== target) continue;
    const safeFlag = (flag) => /^(?:ro|rw|exec|noexec|nosuid|nodev|relatime|strictatime|mode=[0-7]{3,4}|size=[0-9]+[kKmMgG]?)$/u.test(flag);
    mounts.push({ id: Number(left[0]), root: unescapeMount(left[3]), target, filesystem: right[0],
      flags: left[5].split(',').filter(safeFlag), superFlags: right[2].split(',').filter(safeFlag) });
  }
  mounts.sort((a, b) => b.target.length - a.target.length);
  if (!mounts.length || mounts.length > 1 && mounts[0].target === mounts[1].target) return 'UNKNOWN';
  return { ...mounts[0], overlappingAncestors: mounts.length - 1 };
}

export function rustSmokeExecEvidence(binary, result, options = {}) {
  const stat = options.stat ?? fs.statSync;
  const lstat = options.lstat ?? fs.lstatSync;
  const realpath = options.realpath ?? fs.realpathSync;
  const readFile = options.readFile ?? fs.readFileSync;
  const spawn = options.spawn ?? spawnSync;
  const file = observed(() => {
    const details = stat(binary);
    return { path: binary, realpath: realpath(binary), ...metadata(details),
      lstat: metadata(lstat(binary)), sha256: digest(binary), effectiveXAccess: accessX(binary) };
  });
  const directories = [];
  for (let directory = path.dirname(binary);; directory = path.dirname(directory)) {
    directories.push(observed(() => {
      const details = stat(directory);
      return { path: directory, ...metadata(details), effectiveTraversal: accessX(directory) };
    }));
    if (directory === '/') break;
  }
  const mount = observed(() => {
    const mountinfo = readFile('/proc/self/mountinfo', 'utf8');
    return mountinfo.length <= 128 * 1024 ? containingMount(binary, mountinfo) : 'UNKNOWN';
  });
  const mountExec = mount === 'UNKNOWN' ? 'UNKNOWN' :
    mount.flags.includes('noexec') ? 'NOEXEC' : mount.flags.includes('rw') || mount.flags.includes('ro') ? 'EXEC' : 'UNKNOWN';
  const elfInterpreter = observed(() => {
    const elf = spawn('/usr/bin/readelf', ['-h', '-lW', '-d', binary], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    if (elf.status !== 0 || elf.error) return 'UNKNOWN';
    const elfType = /\bType:\s+(EXEC|DYN)\b/u.exec(elf.stdout)?.[1] ?? 'UNKNOWN';
    const elfClass = /\bClass:\s+(ELF32|ELF64)\b/u.exec(elf.stdout)?.[1] ?? 'UNKNOWN';
    const machine = /\bMachine:\s+([^\n]{1,80})/u.exec(elf.stdout)?.[1]?.trim() ?? 'UNKNOWN';
    const needed = [...elf.stdout.matchAll(/Shared library: \[([A-Za-z0-9_.+-]+)\]/gu)].map((match) => match[1]);
    const interpreter = /\[Requesting program interpreter: (\/[A-Za-z0-9_./+-]+)\]/u.exec(elf.stdout)?.[1];
    if (!interpreter) return { path: null, elfType, elfClass, machine, needed, dependencyResolution: 'NOT_REQUIRED' };
    const exists = observed(() => fs.existsSync(interpreter));
    const details = exists === true ? observed(() => stat(interpreter)) : 'UNKNOWN';
    const loader = details === 'UNKNOWN' ? null : spawn(interpreter, ['--list', binary],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    const loaderOutput = `${loader?.stdout ?? ''}\n${loader?.stderr ?? ''}`;
    return { path: interpreter, elfType, elfClass, machine, needed, exists,
      realpath: details === 'UNKNOWN' ? 'UNKNOWN' : observed(() => realpath(interpreter)),
      mode: details === 'UNKNOWN' ? 'UNKNOWN' : mode(details),
      uid: details === 'UNKNOWN' ? 'UNKNOWN' : details.uid,
      gid: details === 'UNKNOWN' ? 'UNKNOWN' : details.gid,
      dependencyResolution: exists === false ? 'INTERPRETER_MISSING' : !loader ? 'UNKNOWN' : loader.status === 0 && !loader.error &&
        !loaderOutput.includes('not found') ? 'RESOLVED' : 'UNRESOLVED',
      loaderErrorCode: loader?.error?.code ?? null };
  });
  const lsm = observed(() => {
    const profile = readFile('/proc/self/attr/current', 'utf8').trim();
    return /^[A-Za-z0-9_ .:/()+-]{1,160}$/u.test(profile) ? profile : 'UNKNOWN';
  });
  const status = observed(() => readFile('/proc/self/status', 'utf8'));
  const processContext = { realUid: observed(() => process.getuid()), effectiveUid: observed(() => process.geteuid()),
    realGid: observed(() => process.getgid()), effectiveGid: observed(() => process.getegid()),
    groups: observed(() => process.getgroups()),
    capEff: status === 'UNKNOWN' ? 'UNKNOWN' : /^CapEff:\s+([a-fA-F0-9]+)$/mu.exec(status)?.[1] ?? 'UNKNOWN',
    noNewPrivs: status === 'UNKNOWN' ? 'UNKNOWN' : /^NoNewPrivs:\s+([01])$/mu.exec(status)?.[1] ?? 'UNKNOWN' };
  return { file, directories, mount, elfInterpreter, lsm, processContext,
    mountExec, lsmDenial: 'LSM_EVIDENCE_UNAVAILABLE',
    executingUid: observed(() => process.getuid()), executingGid: observed(() => process.getgid()),
    spawnStatus: result === null ? 'NOT_ATTEMPTED' : result?.error ? 'SPAWN_FAILURE' :
      Number.isInteger(result?.status) ? 'PROCESS_STARTED_AND_EXITED' : 'UNKNOWN',
    childPid: Number.isInteger(result?.pid) && result.pid > 0 ? result.pid : null,
    errorCode: result?.error?.code ?? null, exitCode: result?.status ?? null, signal: result?.signal ?? null,
    stdout: safeOutput(result?.stdout), stderr: safeOutput(result?.stderr) };
}

export const RUST_EXECVE_SCHEMA = 'phi-e4-rust-execve-forensic-v1';
export const RUST_SMOKE_SOURCE = 'fn main() { println!("E4_RUST_SYSROOT_READY"); }\n';
export const RUST_SMOKE_SOURCE_SHA256 = createHash('sha256').update(RUST_SMOKE_SOURCE).digest('hex');

export function rustForensicComplete(body) {
  const compile = body?.compile;
  const before = body?.beforeExec;
  const execution = body?.execution;
  const interpreter = before?.elfInterpreter;
  return body?.schema === RUST_EXECVE_SCHEMA && body.qualifying === false &&
    /^[a-f0-9]{40}$/u.test(body.candidateSha ?? '') &&
    /^[a-f0-9]{64}$/u.test(body.seedManifestSha256 ?? '') &&
    /^[a-f0-9]{64}$/u.test(body.rustcSha256 ?? '') &&
    compile?.binary === '/usr/bin/rustc' && compile.exitCode === 0 && compile.errorCode === null &&
    compile.sourceSha256 === RUST_SMOKE_SOURCE_SHA256 && compile.inputMethod === 'stdin' &&
    compile.cwd === path.dirname(compile.outputPath) &&
    compile.timeoutMs === 15000 && compile.maxBufferBytes === 1024 * 1024 &&
    compile.env?.PATH === '/usr/bin:/bin' && compile.env?.HOME === '/tmp' &&
    compile.stdoutComplete === true && compile.stderrComplete === true &&
    Array.isArray(compile.args) && compile.args.length === 4 &&
    compile.args[0] === '--edition=2021' && compile.args[1] === '-' &&
    compile.args[2] === '-o' && compile.args[3] === compile.outputPath &&
    before?.file?.path === compile.outputPath && before.file.realpath === compile.outputPath &&
    before.file.type === 'FILE' && before.file.lstat?.type === 'FILE' &&
    /^[a-f0-9]{64}$/u.test(before.file.sha256 ?? '') && /^[0-7]{4}$/u.test(before.file.mode ?? '') &&
    Number.isInteger(before.file.uid) && Number.isInteger(before.file.gid) &&
    Array.isArray(before.directories) && before.directories[0]?.path === path.dirname(compile.outputPath) &&
    before.directories.every((entry) => entry.type === 'DIRECTORY' && /^[0-7]{4}$/u.test(entry.mode) &&
      typeof entry.effectiveTraversal?.allowed === 'boolean') &&
    typeof before.file.effectiveXAccess?.allowed === 'boolean' &&
    Number.isInteger(before.mount?.id) && typeof before.mount?.target === 'string' &&
    before.mount?.filesystem && before.mountExec !== 'UNKNOWN' &&
    ['EXEC', 'NOEXEC'].includes(before.mountExec) &&
    interpreter !== 'UNKNOWN' && ['ELF32', 'ELF64'].includes(interpreter?.elfClass) &&
    interpreter?.machine !== 'UNKNOWN' &&
    (interpreter?.path === null && interpreter?.dependencyResolution === 'NOT_REQUIRED' ||
      typeof interpreter?.path === 'string' &&
      (interpreter?.exists === true && interpreter?.dependencyResolution !== 'UNKNOWN' ||
        interpreter?.exists === false && interpreter?.dependencyResolution === 'INTERPRETER_MISSING')) &&
    Number.isInteger(before.processContext?.realUid) && Number.isInteger(before.processContext?.effectiveUid) &&
    Number.isInteger(before.processContext?.realGid) && Number.isInteger(before.processContext?.effectiveGid) &&
    Array.isArray(before.processContext?.groups) &&
    /^[a-fA-F0-9]+$/u.test(before.processContext?.capEff ?? '') &&
    ['0', '1'].includes(before.processContext?.noNewPrivs) &&
    ['SPAWN_FAILURE', 'PROCESS_STARTED_AND_EXITED'].includes(execution?.spawnStatus) &&
    execution?.file?.sha256 === before.file.sha256 &&
    body.executionInvocation?.method === 'spawnSync' &&
    body.executionInvocation?.binary === compile.outputPath &&
    Array.isArray(body.executionInvocation?.args) && body.executionInvocation.args.length === 0 &&
    body.executionInvocation.timeoutMs === 15000 &&
    body.executionInvocation.maxBufferBytes === 1024 * 1024 &&
    body.executionInvocation.env?.PATH === '/usr/bin:/bin' &&
    body.executionInvocation.env?.HOME === '/tmp' &&
    execution?.stdout?.complete === true && execution?.stderr?.complete === true &&
    (execution.spawnStatus === 'SPAWN_FAILURE' && typeof execution.errorCode === 'string' && execution.exitCode === null ||
      execution.spawnStatus === 'PROCESS_STARTED_AND_EXITED' && execution.errorCode === null &&
        Number.isInteger(execution.exitCode) &&
        (execution.exitCode !== 0 || execution.stdout.text.trim() === 'E4_RUST_SYSROOT_READY')) &&
    body.cleanup === 'PASS' && body.error === null;
}

export function serializeRustForensic(body) {
  body.complete = Boolean(rustForensicComplete(body));
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  assert.ok(bytes.length <= 32 * 1024, 'FORENSIC_ARTIFACT_TOO_LARGE');
  const receipt = { schema: body.schema, candidateSha: body.candidateSha,
    qualifying: false, complete: body.complete, status: body.complete ? 'PASS' : 'INCOMPLETE',
    compileExitCode: body.compile?.exitCode ?? null,
    spawnStatus: body.execution?.spawnStatus ?? 'NOT_REACHED',
    errorCode: body.execution?.errorCode ?? null, cleanup: body.cleanup,
    artifact: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  return { bytes, receipt };
}

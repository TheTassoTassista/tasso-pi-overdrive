// INTERNAL_TRUSTED validation controller; never registered as an agent tool.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ownedWindowsHelper } from './process.mjs';

// INTERNAL_TRUSTED prerequisite lookup, not an agent executable allowlist.
// Do not start an unowned where.exe subprocess, search cwd, interpret PATHEXT
// scripts or accept relative PATH entries. Execution still requires the Job.
export function windowsValidationCandidates(command, environment) {
  if (typeof command !== 'string' || !/^[A-Za-z0-9_-]+(?:\.exe)?$/iu.test(command)) throw new Error('PHI_VALIDATION_COMMAND_UNAVAILABLE');
  const value = environment?.PATH ?? environment?.Path;
  if (typeof value !== 'string' || value.length > 32768 || value.includes('\0')) throw new Error('PHI_VALIDATION_COMMAND_UNAVAILABLE');
  const directories = value.split(';');
  if (directories.length > 128) throw new Error('PHI_VALIDATION_COMMAND_UNAVAILABLE');
  const filename = /\.exe$/iu.test(command) ? command : command + '.exe';
  return [...new Set(directories.filter(directory => /^[A-Za-z]:[\\/]/u.test(directory) && directory.indexOf(':',2) < 0)
    .map(directory => path.win32.join(directory,filename)))];
}

function resolveValidationExecutable(command, environment) {
  for (const candidate of windowsValidationCandidates(command, environment)) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const canonical = fs.realpathSync(candidate);
      if (!/^[A-Za-z]:[\\/]/u.test(canonical) || !canonical.toLowerCase().endsWith('.exe')) continue;
      return canonical;
    } catch(error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error('PHI_VALIDATION_COMMAND_UNAVAILABLE');
}

// Budget is tied to the exact aggregate entry, never to a stale diagnostic stage.
export function validationCommandTimeout(command, args, cwd, { diagnosticOnly = false } = {}) {
  const suite = command === process.execPath && args.length === 2 && args[0] === path.join(cwd, 'scripts', 'phi-check.mjs') && args[1] === '--owned-validation';
  return suite ? diagnosticOnly ? 780000 : 600000 : 120000;
}

export async function runValidationCommand(command, args, { cwd, env = process.env, timeoutMs = 120000, diagnosticOnly = false } = {}) {
  if (diagnosticOnly && (command !== process.execPath || args.length !== 2 || args[0] !== path.join(cwd, 'scripts', 'phi-check.mjs') || args[1] !== '--owned-validation' || timeoutMs !== 780000)) throw new Error('PHI_VALIDATION_DIAGNOSTIC_SCOPE_INVALID');
  if (process.platform !== 'win32') return spawnSync(command, args, { cwd, env, shell: false, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  let phase = 'RESOLVE_COMMAND';
  try {
  if (!path.isAbsolute(command)) {
    command = resolveValidationExecutable(command, env);
  }
  phase = 'HELPER_VALIDATION';
  const helper = ownedWindowsHelper();
  phase = 'SUPERVISOR_SPAWN';
  const child = spawn(helper, ['--validation-run'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const request = { command, args, cwd, env, timeoutMs, guardianPid: process.pid, ...(diagnosticOnly ? { diagnosticOnly: true } : {}) };
  let output = '', nativeError = '', bytes = 0, overflow = false;
  child.stdout.on('data', b => { bytes += b.length; if (bytes > 6 * 1024 * 1024) { overflow = true; child.kill(); } else output += b; });
  child.stderr.on('data', b => { if (nativeError.length < 65536) nativeError += b; });
  child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request) + '\n');
  const timer = setTimeout(() => child.kill(), timeoutMs + 17000);
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    phase = 'RECEIPT_PARSE';
    let row;
    try { row = JSON.parse(output); } catch { throw new Error('PHI_VALIDATION_RECEIPT_MISSING'); }
    phase = 'RECEIPT_VALIDATE';
    const keys = ['version', 'scope', 'resultExitCode', 'primaryExitCode', 'timedOut', 'jobAttested', 'targetStarted', 'jobEmptyVerified', 'pipesDrained', 'residualOwnedProcesses', 'childPid', 'childGeneration', 'stdoutBase64', 'stderrBase64'];
    if (overflow || !row || Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k)) || row.version !== 1 || row.scope !== 'TRUSTED_VALIDATION_JOB_NOT_SANDBOX' || status !== row.resultExitCode || !Number.isInteger(row.resultExitCode) || ![null, ...Array.from({length:256},(_,i)=>i)].includes(row.primaryExitCode) || !['timedOut','jobAttested','targetStarted','jobEmptyVerified','pipesDrained'].every(k=>typeof row[k]==='boolean') || !Number.isSafeInteger(row.childPid) || row.childGeneration !== null && !/^\d{1,20}$/u.test(row.childGeneration) || row.residualOwnedProcesses !== (row.jobEmptyVerified ? 0 : null) || !['stdoutBase64','stderrBase64'].every(k=>typeof row[k]==='string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(row[k]))) throw new Error('PHI_VALIDATION_RECEIPT_INVALID');
    const { stdoutBase64, stderrBase64, ...receipt } = row;
    return { status, stdout: Buffer.from(stdoutBase64, 'base64').toString('utf8'), stderr: Buffer.from(stderrBase64, 'base64').toString('utf8') + nativeError,
      error: row.timedOut ? { code: 'ETIMEDOUT' } : undefined, receipt };
  } finally { clearTimeout(timer); }
  } catch (error) {
    // A fixed phase/code may be published, never message/stack/path/argv/env.
    if (error && typeof error === 'object') error.validationPhase = phase;
    throw error;
  }
}

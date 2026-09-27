// INTERNAL_TRUSTED validation controller; never registered as an agent tool.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ownedWindowsHelper } from './process.mjs';

// Budget is tied to the exact aggregate entry, never to a stale diagnostic stage.
export function validationCommandTimeout(command, args, cwd) {
  return command === process.execPath && args.length === 2 && args[0] === path.join(cwd, 'scripts', 'phi-check.mjs') && args[1] === '--owned-validation' ? 600000 : 120000;
}

export async function runValidationCommand(command, args, { cwd, env = process.env, timeoutMs = 120000 } = {}) {
  if (process.platform !== 'win32') return spawnSync(command, args, { cwd, env, shell: false, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  if (!path.isAbsolute(command)) {
    const where = spawnSync(path.join(process.env.SystemRoot, 'System32', 'where.exe'), [command], { shell: false, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
    command = where.status === 0 ? where.stdout.split(/\r?\n/u).find(p => p.endsWith('.exe') && fs.statSync(p, { throwIfNoEntry: false })?.isFile()) : null;
    if (!command) throw new Error('PHI_VALIDATION_COMMAND_UNAVAILABLE');
  }
  const helper = ownedWindowsHelper();
  const child = spawn(helper, ['--validation-run'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const request = { command, args, cwd, env, timeoutMs, guardianPid: process.pid };
  let output = '', nativeError = '', bytes = 0, overflow = false;
  child.stdout.on('data', b => { bytes += b.length; if (bytes > 6 * 1024 * 1024) { overflow = true; child.kill(); } else output += b; });
  child.stderr.on('data', b => { if (nativeError.length < 65536) nativeError += b; });
  child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request) + '\n');
  const timer = setTimeout(() => child.kill(), timeoutMs + 17000);
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    let row;
    try { row = JSON.parse(output); } catch { throw new Error('PHI_VALIDATION_RECEIPT_MISSING'); }
    const keys = ['version', 'scope', 'resultExitCode', 'primaryExitCode', 'timedOut', 'jobAttested', 'targetStarted', 'jobEmptyVerified', 'pipesDrained', 'residualOwnedProcesses', 'childPid', 'childGeneration', 'stdoutBase64', 'stderrBase64'];
    if (overflow || !row || Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k)) || row.version !== 1 || row.scope !== 'TRUSTED_VALIDATION_JOB_NOT_SANDBOX' || status !== row.resultExitCode || !Number.isInteger(row.resultExitCode) || ![null, ...Array.from({length:256},(_,i)=>i)].includes(row.primaryExitCode) || !['timedOut','jobAttested','targetStarted','jobEmptyVerified','pipesDrained'].every(k=>typeof row[k]==='boolean') || !Number.isSafeInteger(row.childPid) || row.childGeneration !== null && !/^\d{1,20}$/u.test(row.childGeneration) || row.residualOwnedProcesses !== (row.jobEmptyVerified ? 0 : null) || !['stdoutBase64','stderrBase64'].every(k=>typeof row[k]==='string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(row[k]))) throw new Error('PHI_VALIDATION_RECEIPT_INVALID');
    const { stdoutBase64, stderrBase64, ...receipt } = row;
    return { status, stdout: Buffer.from(stdoutBase64, 'base64').toString('utf8'), stderr: Buffer.from(stderrBase64, 'base64').toString('utf8') + nativeError,
      error: row.timedOut ? { code: 'ETIMEDOUT' } : undefined, receipt };
  } finally { clearTimeout(timer); }
}

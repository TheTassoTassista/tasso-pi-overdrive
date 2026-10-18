import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const MAX_DIAGNOSTIC_STREAM_BYTES = 256 * 1024;

const asBuffer = (value) => Buffer.isBuffer(value) ? value : Buffer.alloc(0);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class LinkerDiagnosticCapture {
  constructor(limit = MAX_DIAGNOSTIC_STREAM_BYTES) {
    this.limit = limit;
    this.used = 0;
    this.records = [];
    this.incomplete = false;
  }

  run(binary, args, options = {}) {
    if (this.incomplete) throw new Error('DIAGNOSTIC_OUTPUT_TOO_LARGE');
    let result;
    try {
      result = spawnSync(binary, args, {
        ...options,
        input: typeof options.input === 'string' ? Buffer.from(options.input, 'utf8') : options.input,
        encoding: null,
        timeout: 15000,
        // Node bounds each stream separately; the combined bound is enforced below.
        maxBuffer: this.limit + 1,
        env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
      });
    } catch (error) {
      result = { stdout: null, stderr: null, status: null, signal: null, error };
    }
    const stdout = asBuffer(result.stdout);
    const stderr = asBuffer(result.stderr);
    const remaining = this.limit - this.used;
    const overflow = stdout.length + stderr.length > remaining || result.error?.code === 'ENOBUFS';
    // In an incomplete artifact, retain stderr first so the linker error is
    // available; the receipt still refuses to classify truncated evidence.
    const retainedStderr = stderr.subarray(0, Math.min(stderr.length, remaining));
    const retainedStdout = stdout.subarray(0, Math.min(stdout.length, remaining - retainedStderr.length));
    this.used += retainedStdout.length + retainedStderr.length;
    const terminalExit = Number.isInteger(result.status) && result.status >= 0
      && result.signal === null && !result.error
      && Buffer.isBuffer(result.stdout) && Buffer.isBuffer(result.stderr);
    const spawnError = result.error && !['ENOBUFS', 'ETIMEDOUT'].includes(result.error.code)
      && result.status === null && result.signal === null;
    const spawnStatus = overflow ? 'DIAGNOSTIC_OUTPUT_TOO_LARGE'
      : spawnError ? 'SPAWN_ERROR'
        : terminalExit ? 'SPAWNED_WITH_EXIT_RESULT' : 'CAPTURE_INCOMPLETE';
    const complete = spawnStatus === 'SPAWNED_WITH_EXIT_RESULT';
    const record = {
      command: [binary, ...args], spawnStatus, exitCode: result.status,
      signal: result.signal ?? null, errorCode: result.error?.code ?? null,
      errorMessage: result.error ? String(result.error.message).slice(0, 180) : null,
      stdout: retainedStdout.toString('utf8'), stderr: retainedStderr.toString('utf8'),
      stdoutBytes: stdout.length, stderrBytes: stderr.length,
      stdoutComplete: complete, stderrComplete: complete, complete,
    };
    this.records.push(record);
    if (!complete) this.incomplete = true;
    if (overflow) {
      throw new Error('DIAGNOSTIC_OUTPUT_TOO_LARGE');
    }
    return record;
  }

  serialize(metadata) {
    const compile = metadata?.compile;
    const compileComplete = compile?.spawnStatus === 'SPAWNED_WITH_EXIT_RESULT'
      && Number.isInteger(compile.exitCode) && compile.complete === true;
    const complete = !this.incomplete && compileComplete;
    const bytes = Buffer.from(JSON.stringify({ schema: 'phi-e4-linker-diagnostic-v1',
      streamLimitBytes: this.limit, streamBytesRetained: this.used,
      complete, metadata, records: this.records }, null, 2) + '\n');
    return { bytes, sha256: sha256(bytes), complete, streamBytes: this.used };
  }

  artifact(metadata, file) {
    const serialized = this.serialize(metadata);
    const { bytes } = serialized;
    fs.writeFileSync(file, bytes, { mode: 0o644, flag: 'wx' });
    return { path: file, sha256: serialized.sha256, bytes: bytes.length,
      complete: serialized.complete, streamBytes: serialized.streamBytes };
  }
}

export function keyErrorLines(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/u).filter((line) =>
    /(?:error|fatal|cannot|not found|denied|undefined reference|^\s*= note:)/iu.test(line));
  return lines.slice(-6).map((line) => line.slice(0, 180));
}

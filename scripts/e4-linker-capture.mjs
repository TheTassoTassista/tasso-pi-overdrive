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
    const result = spawnSync(binary, args, {
      encoding: 'buffer', timeout: 15000, maxBuffer: this.limit + 1,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp' }, ...options,
    });
    const stdout = asBuffer(result.stdout);
    const stderr = asBuffer(result.stderr);
    const remaining = this.limit - this.used;
    const overflow = stdout.length + stderr.length > remaining || result.error?.code === 'ENOBUFS';
    // In an incomplete artifact, retain stderr first so the linker error is
    // available; the receipt still refuses to classify truncated evidence.
    const retainedStderr = stderr.subarray(0, Math.min(stderr.length, remaining));
    const retainedStdout = stdout.subarray(0, Math.min(stdout.length, remaining - retainedStderr.length));
    this.used += retainedStdout.length + retainedStderr.length;
    const record = {
      command: [binary, ...args], exitCode: result.status,
      errorCode: result.error?.code ?? null,
      stdout: retainedStdout.toString('utf8'), stderr: retainedStderr.toString('utf8'),
      stdoutBytes: stdout.length, stderrBytes: stderr.length, complete: !overflow,
    };
    this.records.push(record);
    if (overflow) {
      this.incomplete = true;
      throw new Error('DIAGNOSTIC_OUTPUT_TOO_LARGE');
    }
    return record;
  }

  serialize(metadata) {
    const bytes = Buffer.from(JSON.stringify({ schema: 'phi-e4-linker-diagnostic-v1',
      streamLimitBytes: this.limit, streamBytesRetained: this.used,
      complete: !this.incomplete, metadata, records: this.records }, null, 2) + '\n');
    return { bytes, sha256: sha256(bytes), complete: !this.incomplete, streamBytes: this.used };
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

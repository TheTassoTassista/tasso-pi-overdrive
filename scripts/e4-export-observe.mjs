#!/usr/bin/env node
// Bounded, non-certifying observability around the existing Buildx --load export.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupOwnedImageStages, ownedImageEntrypointPids } from './e4-owned-image-cleanup.mjs';

const IMAGE_PREFIX = 'ghcr.io/thetassotassista/tasso-pi-overdrive-e4:';
const MAX_LOG_BYTES = 128 * 1024;
const MAX_LINE = 420;
const MAX_SAMPLES = 180;

export function buildArguments({ context, candidate, runnerTemp, evidenceDir }) {
  assert.match(candidate, /^[a-f0-9]{40}$/u);
  assert.equal(path.isAbsolute(context), true);
  assert.equal(path.isAbsolute(runnerTemp), true);
  assert.equal(path.isAbsolute(evidenceDir), true);
  return [
    'buildx', 'build', '--file', path.join(context, 'certification/Dockerfile.e4'),
    '--build-arg', `PRODUCT_CANDIDATE_SHA=${candidate}`,
    '--build-context', `seeds=${path.join(runnerTemp, 'phi-e4-seeds')}`,
    '--build-context', `lsp=${path.join(runnerTemp, 'phi-e4-lsp/managed')}`,
    '--progress=plain', '--metadata-file', path.join(evidenceDir, 'buildx-metadata.json'),
    '--load', '--tag', `${IMAGE_PREFIX}${candidate}`, context,
  ];
}

export function classifyBuildExit({ code, signal, spawnError, observedSignal }) {
  if (spawnError) return { kind: 'SPAWN_ERROR', code: null, signal: null, actor: 'UNKNOWN' };
  if (signal) return { kind: 'SIGNALLED', code: null, signal, actor: 'UNKNOWN' };
  if (observedSignal) return { kind: 'WRAPPER_SIGNAL_OBSERVED', code, signal: observedSignal, actor: 'UNKNOWN' };
  return { kind: code === 0 ? 'EXITED_ZERO' : 'EXITED_NONZERO', code, signal: null, actor: 'UNKNOWN' };
}

function readUnsigned(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return /^\d+$/u.test(value) ? Number(value) : null;
  } catch { return null; }
}

function memAvailable() {
  try {
    const match = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/mu);
    return match ? Number(match[1]) * 1024 : null;
  } catch { return null; }
}

export function resourceSnapshot(runnerTemp, phase, dockerStorage = null) {
  let filesystem = null;
  let dockerFilesystem = null;
  try {
    const stat = fs.statfsSync(runnerTemp);
    filesystem = { freeBytes: stat.bavail * stat.bsize, freeInodes: stat.ffree };
  } catch { /* unavailable remains null */ }
  try {
    const stat = fs.statfsSync('/var/lib/docker');
    dockerFilesystem = { freeBytes: stat.bavail * stat.bsize, freeInodes: stat.ffree };
  } catch { /* unavailable remains null */ }
  return {
    at: new Date().toISOString(), phase, filesystem, dockerFilesystem,
    memoryAvailableBytes: memAvailable(),
    cgroupMemoryCurrentBytes: readUnsigned('/sys/fs/cgroup/memory.current'),
    cgroupMemoryMaxBytes: readUnsigned('/sys/fs/cgroup/memory.max'),
    cgroupMemoryEvents: (() => {
      try {
        const pairs = [...fs.readFileSync('/sys/fs/cgroup/memory.events', 'utf8').matchAll(/^(\w+) (\d+)$/gmu)];
        return Object.fromEntries(pairs.map((match) => [match[1], Number(match[2])]));
      } catch { return null; }
    })(),
    dockerStorage,
  };
}

function boundedCommand(args, timeout = 10000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 });
  return {
    status: result.status,
    signal: result.signal ?? null,
    output: (result.stdout ?? '').trim().slice(0, 1200),
    stderr: (result.stderr ?? '').trim().slice(0, 200),
    error: result.error ? String(result.error.message).slice(0, 160) : null,
  };
}

function redact(line) {
  return line
    .replace(/(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/gu, '[REDACTED]')
    .slice(0, MAX_LINE);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--candidate', '--context', '--mode'].includes(key) || !argv[index + 1] || result[key]) {
      throw new Error('invalid export-observe arguments');
    }
    result[key] = argv[index + 1];
  }
  assert.equal(Object.keys(result).length, 3);
  assert.ok(['qualification', 'diagnostic'].includes(result['--mode']));
  assert.match(result['--candidate'], /^[a-f0-9]{40}$/u);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const candidate = options['--candidate'];
  const mode = options['--mode'];
  const context = fs.realpathSync(options['--context']);
  const runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP ?? '');
  assert.equal(path.basename(runnerTemp), '_temp');
  assert.equal(fs.statSync(runnerTemp).uid, process.getuid());
  const source = spawnSync('git', ['-C', context, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(source.status, 0);
  assert.equal(source.stdout.trim(), candidate, 'build context is not the frozen candidate');
  const evidenceDir = path.join(runnerTemp, 'phi-e4-export-evidence');
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  assert.equal(fs.lstatSync(evidenceDir).isDirectory(), true);
  assert.equal(fs.statSync(evidenceDir).uid, process.getuid());
  const imageRef = `${IMAGE_PREFIX}${candidate}`;
  const prior = boundedCommand(['image', 'inspect', imageRef, '--format', '{{.Id}}']);
  assert.equal(prior.status, 1, 'cannot establish absent pre-build image tag');
  assert.match(prior.stderr, /No such image/u, 'pre-build inspect failed for a reason other than absent tag');
  const runId = process.env.GITHUB_RUN_ID ?? '';
  assert.match(runId, /^\d+$/u, 'missing numeric job run ID');
  fs.writeFileSync(path.join(evidenceDir, 'ownership.json'), `${JSON.stringify({
    schema: 'phi-e4-export-owner-v1', runId, candidate, imageRef, preexistingTag: false,
  })}\n`, { mode: 0o600, flag: 'wx' });
  const args = buildArguments({ context, candidate, runnerTemp, evidenceDir });
  const startedAt = new Date().toISOString();
  const receipt = {
    schema: 'phi-e4-export-observe-v1', mode, candidate, imageRef, startedAt,
    runner: { name: (process.env.RUNNER_NAME ?? 'UNKNOWN').slice(0, 80), os: process.platform },
    jobTimeoutMinutes: 40, exportDestination: 'local-docker-image/--load',
    command: ['docker', ...args], builder: boundedCommand(['buildx', 'version']),
    docker: boundedCommand(['version', '--format', '{{.Server.Version}}']),
    dockerRoot: boundedCommand(['info', '--format', '{{.DockerRootDir}}']),
    pre: resourceSnapshot(runnerTemp, 'before', boundedCommand(['system', 'df', '--format', '{{json .}}'])),
    samples: [], tail: [], build: null, outputIdentity: null, cleanup: 'UNVERIFIED',
  };
  console.log(`E4_EXPORT_START=${startedAt} candidate=${candidate} mode=${mode} driver=default/docker export=--load`);
  console.log(`E4_EXPORT_BUILDER=${JSON.stringify(receipt.builder)}`);
  console.log(`E4_EXPORT_RESOURCE_BEFORE=${JSON.stringify(receipt.pre)}`);
  let emittedBytes = 0;
  let lateBytes = 0;
  let buildPhase = 'build';
  const record = (stream, line) => {
    const bounded = redact(line);
    if (/exporting to image|exporting layers/u.test(bounded)) buildPhase = 'export';
    const entry = `${new Date().toISOString()} ${stream} ${bounded}`;
    receipt.tail.push(entry);
    if (receipt.tail.length > 80) receipt.tail.shift();
    const size = Buffer.byteLength(entry) + 1;
    if (emittedBytes + size <= MAX_LOG_BYTES) {
      console.log(entry);
      emittedBytes += size;
    } else if (lateBytes + size <= 64 * 1024 && /ERROR|FATAL|failed|exporting|no space|killed|signal/iu.test(bounded)) {
      console.log(entry);
      lateBytes += size;
    }
  };
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let observedSignal = null;
  for (const name of ['SIGTERM', 'SIGINT']) {
    process.on(name, () => {
      observedSignal = name;
      console.log(`E4_EXPORT_WRAPPER_SIGNAL=${name}`);
      if (child.exitCode === null && child.signalCode === null) child.kill(name);
    });
  }
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    let remainder = '';
    stream.on('data', (data) => {
      remainder += data.toString('utf8');
      const lines = remainder.split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) record(name, line);
      if (remainder.length > MAX_LINE * 4) { record(name, remainder); remainder = ''; }
    });
    stream.on('end', () => { if (remainder) record(name, remainder); });
  }
  const interval = setInterval(() => {
    if (receipt.samples.length >= MAX_SAMPLES) return;
    const sample = resourceSnapshot(runnerTemp, buildPhase);
    receipt.samples.push(sample);
    console.log(`E4_EXPORT_RESOURCE_SAMPLE=${JSON.stringify(sample)}`);
  }, 15000);
  const completion = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, spawnError: String(error.message).slice(0, 160) }));
    child.once('close', (code, signal) => resolve({ code, signal, spawnError: null }));
  });
  clearInterval(interval);
  receipt.build = classifyBuildExit({ ...completion, observedSignal });
  receipt.endedAt = new Date().toISOString();
  receipt.post = resourceSnapshot(runnerTemp, 'after', boundedCommand(['system', 'df', '--format', '{{json .}}']));
  if (completion.code === 0 && !completion.signal && !completion.spawnError) {
    const inspected = boundedCommand(['image', 'inspect', imageRef, '--format', '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}']);
    const match = inspected.output.match(/^(sha256:[a-f0-9]{64}) ([a-f0-9]{40})$/u);
    if (inspected.status === 0 && match?.[2] === candidate) receipt.outputIdentity = match[1];
  }
  const success = receipt.build.kind === 'EXITED_ZERO' && receipt.outputIdentity !== null;
  if (mode === 'diagnostic' || !success) {
    try {
      const present = boundedCommand(['image', 'inspect', imageRef, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}']);
      if (present.status === 0) {
        assert.equal(present.output, candidate, 'new tag identity mismatch; refuse deletion');
        assert.equal(boundedCommand(['image', 'rm', imageRef]).status, 0, 'owned image tag removal failed');
      } else {
        assert.equal(present.status, 1, 'image inspection unavailable');
        assert.match(present.stderr, /No such image/u, 'post-build inspect failed for a reason other than absent tag');
      }
      cleanupOwnedImageStages(runnerTemp);
      assert.equal(ownedImageEntrypointPids().length, 0, 'owned image entrypoint remained');
      receipt.cleanup = 'PASS';
    } catch (error) {
      receipt.cleanup = 'FAIL';
      receipt.cleanupError = String(error.message).slice(0, 180);
    }
  } else receipt.cleanup = 'DEFERRED_TO_JOB_FINALIZER';
  const output = JSON.stringify(receipt);
  assert.ok(Buffer.byteLength(output) <= 128 * 1024, 'export receipt exceeded bound');
  fs.writeFileSync(path.join(evidenceDir, 'export-receipt.json'), `${output}\n`, { mode: 0o600 });
  console.log(`E4_EXPORT_RESULT=${success ? 'PASS' : 'FAIL'} exit=${JSON.stringify(receipt.build)} identity=${receipt.outputIdentity ?? 'UNKNOWN'} cleanup=${receipt.cleanup}`);
  if (!success || receipt.cleanup === 'FAIL') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`E4_EXPORT_OBSERVER=FAIL reason=${redact(String(error.message))}`);
    process.exitCode = 1;
  });
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
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

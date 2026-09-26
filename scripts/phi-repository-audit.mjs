#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
function git(args, maxBuffer = 16 * 1024 * 1024) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, maxBuffer });
  if (result.status !== 0) throw new Error('PHI_GIT_AUDIT_UNAVAILABLE');
  return result.stdout;
}
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--history')) throw new Error('PHI_AUDIT_USAGE');
const history = args.includes('--history');
const files = history ? git(['rev-list', '--objects', 'HEAD']).trim().split('\n').filter((entry) => git(['cat-file', '-t', entry.split(' ')[0]]).trim() === 'blob').map((entry) => {
  const space = entry.indexOf(' ');
  const object = space < 0 ? entry : entry.slice(0, space);
  const name = space < 0 ? `unknown-history-blob/${object}` : entry.slice(space + 1);
  return `100644 ${object} 0\t${name}`;
}) : git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
const findings = [];
let bytes = 0;
let scanned = 0;
for (const entry of files) {
  const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/u.exec(entry);
  if (!match || match[3] !== '0') throw new Error('PHI_INDEX_UNMERGED');
  const [, mode, object, , name] = match;
  if (mode !== '100644' && mode !== '100755') { findings.push({ status: 'FAIL', kind: 'non-regular-source', file: name }); continue; }
  const size = Number(git(['cat-file', '-s', object]));
  bytes += size;
  if (size > 5 * 1024 * 1024) { findings.push({ status: 'FAIL', kind: 'large-file', file: name, bytes: size }); continue; }
  if (/(?:^|\/)(?:node_modules|\.venv|\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|browser-data|sessions|cookies|private-memory|\.phi-cache)(?:\/|$)|\.(?:sqlite|db|log)$/iu.test(name)) findings.push({ status: 'FAIL', kind: 'private-or-generated-artifact', file: name });
  const content = git(['cat-file', 'blob', object], 6 * 1024 * 1024);
  scanned++;
  const secrets = [...content.matchAll(/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{20,}/gu)];
  if (secrets.length) {
    // Construct the exact invalid fixture marker instead of placing a full
    // credential-shaped literal in the scanner's own source.
    const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const footer = ['-----END', 'PRIVATE KEY-----'].join(' ');
    const fixture = JSON.stringify([header, 'private-key-body', footer].join('\n'));
    const deterministicPlaceholder = name === 'tests/artifact-store.test.mjs' && secrets.length === 1 && secrets[0][0] === header && content.includes(fixture);
    findings.push({ status: deterministicPlaceholder ? 'WARN' : 'FAIL', kind: deterministicPlaceholder ? 'known-invalid-private-key-test-placeholder' : 'secret-like-value', file: name });
  }
  const absolute = [...content.matchAll(/\/home\/(?!sandbox(?:[\/\s"']|$))[a-zA-Z][\w.-]*|[A-Z]:\\Users\\[\w.-]+|\.codex\/attachments|(?:files-pasted)-(?:by-the-user)/gu)];
  if (absolute.length) {
    const detectorOnly = name === 'scripts/validate-package.mjs' && absolute.every((match) => match[0] === ['files-pasted', 'by-the-user'].join('-')) && content.includes("if (path.basename(file) !== 'validate-package.mjs' && /");
    findings.push({ status: history || detectorOnly ? 'WARN' : /^(?:lib|extensions|platform|bootstrap|bin|services|config|branding|themes|scripts)\//u.test(name) ? 'FAIL' : 'WARN', kind: detectorOnly ? 'forbidden-path-detector-source' : 'machine-path-or-historical-fixture', file: name });
  }
}
const report = { version: 1, scope: history ? 'HEAD_ANCESTRY_BLOBS_NOT_OTHER_BRANCHES_OR_COMMIT_MESSAGES' : 'CURRENT_GIT_INDEX_BLOBS_NOT_UNSTAGED_USER_CONTENT_OR_HISTORY', status: findings.some((finding) => finding.status === 'FAIL') ? 'FAIL' : findings.length ? 'WARN' : 'PASS', files: scanned, totalBytes: bytes, modelCalls: 0, findings, limitations: ['Heuristic secret scan is not proof of absence of every secret', 'Sensitive prose and Git metadata require separate review before public publishing', 'WARN paths in historical docs/fixtures are not production path dependencies'] };
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'FAIL' ? 1 : 0;

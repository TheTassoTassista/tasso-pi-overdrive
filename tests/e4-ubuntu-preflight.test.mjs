import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const scriptUrl = new URL('../scripts/e4-ubuntu-preflight.sh', import.meta.url);
const assertionUrl = new URL('../scripts/e4-preflight-assertions.mjs', import.meta.url);
const script = readFileSync(scriptUrl, 'utf8');
const resetUrl = new URL('../certification/e4-probe-fixture-reset.sh', import.meta.url);
const probe = readFileSync(new URL('../certification/e4-host-probe.sh', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
const preflight = workflow.split('  e4-ubuntu-preflight:\n')[1]?.split('  integrated-ubuntu:\n')[0];
const qualifiedImage = 'ghcr.io/thetassotassista/tasso-pi-overdrive-e4@sha256:4fdd60d808c9bfdf31c6c9832424e2fe3804ccb119aa0e59ce788b4f8668c8a2';
const frozenProduct = 'd94c3474820dd4a0097b140969afb605cf641985';

test('Ubuntu preflight requires separate dispatch after image qualification and readiness review', () => {
  assert.ok(preflight);
  assert.match(preflight, /needs: e4-image-qualification/u);
  assert.doesNotMatch(preflight, /needs\.e4-image-qualification\.result == 'success'/u);
  assert.match(preflight, /inputs\['e4-ubuntu-preflight-only'\] && !inputs\['e4-image-qualification-only'\]/u);
  assert.match(preflight, /runs-on: ubuntu-24\.04/u);
  assert.match(preflight, /packages: read/u);
  assert.match(preflight, /E4_GATE_KIND: preflight/u);
  assert.match(preflight, /ref: \$\{\{ inputs\.certified_sha \}\}/u);
  assert.match(preflight, /E4_CERTIFIED_IMAGE_DIGEST: \$\{\{ needs\.e4-image-qualification\.outputs\.digest \}\}/u);
  assert.ok(preflight.includes(`image='${qualifiedImage}'`), 'separate dispatch must use the qualified image, not an older digest');
  assert.ok(script.includes(`expected_image='${qualifiedImage}'`), 'host verification must pin the same image');
  assert.equal((workflow.match(new RegExp(qualifiedImage, 'gu')) ?? []).length, 2, 'preflight and replacement E4 must use the same digest');
  assert.match(preflight, /bash scripts\/e4-ubuntu-preflight\.sh "\$image" "\$CERTIFIED_SHA"/u);
  assert.doesNotMatch(preflight, /campaign3-e4-windows:|phi-bounded-workflow-pi-smoke|--e1|--e2|--autonomy-crash-v2/u);
  const defaultJob = workflow.split('  native-foundation:\n')[1]?.split('\n')[0];
  assert.match(defaultJob ?? '', /!inputs\['e4-ubuntu-preflight-only'\]/u);
  const e4Ubuntu = workflow.split('  campaign3-e4-ubuntu:\n')[1]?.split('\n')[0];
  assert.match(e4Ubuntu ?? '', /!inputs\['e4-ubuntu-preflight-only'\]/u);
  const e4UbuntuJob = workflow.split('  campaign3-e4-ubuntu:\n')[1]?.split('  campaign3-e4-windows:\n')[0];
  assert.match(e4UbuntuJob ?? '', /E4_GATE_KIND: e4/u);
});

test('host preflight retains frozen Bubblewrap policy and isolates every validation command', () => {
  const syntax = spawnSync('bash', ['-n', scriptUrl.pathname], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(script, /expected_image='ghcr\.io\/thetassotassista\/tasso-pi-overdrive-e4@sha256:[a-f0-9]{64}'/u);
  assert.match(script, /expected_bwrap_sha=[a-f0-9]{64}/u);
  assert.match(script, /expected_profile_sha=[a-f0-9]{64}/u);
  assert.match(script, /expected_seed_sha=[a-f0-9]{64}/u);
  assert.match(script, /case \$\{E4_GATE_KIND:-\} in[\s\S]*preflight\) gate_marker=E4_UBUNTU_PREFLIGHT[\s\S]*e4\) gate_marker=E4_LINUX_FOUNDATION/u);
  assert.match(script, /\[\[ \$\(docker image inspect "\$image" --format '\{\{index \.Config\.Labels "org\.opencontainers\.image\.revision"\}\}'\) == "\$product_sha" \]\]/u);
  assert.match(script, /--unshare-all --unshare-user --disable-userns --clearenv --die-with-parent --new-session/u);
  const mounts = script.match(/bwrap_args=\(\n([\s\S]*?)\n\)/u)?.[1];
  assert.ok(mounts);
  assert.equal((mounts.match(/--(?:ro-bind|bind|proc|dev|tmpfs)\b/gu) ?? []).length, 7);
  assert.match(mounts, /--ro-bind "\$stage\/rootfs" \/[\s\S]*--bind "\$stage\/fixture" \/phi --bind "\$stage\/evidence" \/evidence/u);
  assert.doesNotMatch(mounts, /--share-net|--bind \/ \/|--bind \/var\/run|--bind \/run|--bind \/home/u);
  assert.match(script, /run_payload \/usr\/bin\/sh \/usr\/local\/bin\/phi-e4-probe/u);
  assert.match(script, /"\$stage\/fixture\/fixture-identity"/u);
  assert.match(probe, /: > \/phi\/writable/u);
  assert.match(probe, /: > \/phi\/fixture-writable/u);
  assert.match(script, /bash "\$repo_root\/certification\/e4-probe-fixture-reset\.sh" "\$stage\/fixture"/u);
  const resetCall = script.indexOf('bash "$repo_root/certification/e4-probe-fixture-reset.sh"');
  assert.ok(script.indexOf('E4_PREFLIGHT_HOST_PRECHECK=PASS') < resetCall);
  assert.ok(resetCall < script.indexOf('run_payload /usr/bin/node /opt/phi/e4-image-selfcheck.mjs'));
  assert.match(script, /run_payload \/usr\/bin\/node \/opt\/phi\/e4-image-selfcheck\.mjs/u);
  assert.match(script, /run_validation 'npm run check'/u);
  assert.match(script, /node "\$repo_root\/scripts\/e4-preflight-assertions\.mjs" "\$stage\/full-check\.log" "\$stage\/fixture\/project" \|\| fail HISTORICAL_ASSERTIONS/u);
  assert.match(script, /run_validation 'node scripts\/phi-owned-main-suite\.mjs'/u);
  assert.match(script, /run_validation 'node scripts\/phi-repository-audit\.mjs'/u);
  assert.match(script, /E4_PREFLIGHT_CLEANUP=%s/u);
  assert.match(script, /E4_PREFLIGHT_RESIDUAL_OWNED_PROCESSES=%s/u);
  assert.match(script, /if docker info >\/dev\/null 2>&1; then[\s\S]*container_residual=0[\s\S]*docker container inspect "\$container_id"/u);
  assert.match(script, /process_residual=UNKNOWN container_residual=UNKNOWN/u);
  assert.match(script, /trap cleanup EXIT/u);
  assert.match(script, /if \[\[ "\$original" != 0 \|\| "\$cleanup_ok" != 1 \|\| "\$preflight_passed" != 1 \]\]; then/u);
  assert.match(script, /bash "\$cleanup_source" "\$stage" "\$expected_temp" \|\| cleanup_ok=0/u);
  assert.match(script, /assert_no_owned\(\)/u);
  assert.equal((script.match(/^assert_no_owned$/gmu) ?? []).length, 6, 'every payload phase must drain before the next');
  assert.doesNotMatch(script, /sudo (?:-n )?"?\$?expected_bwrap|sudo (?:-n )?bwrap|--privileged|seccomp=unconfined|--share-net|GITHUB_TOKEN|GH_TOKEN|https?:\/\//u);
});

test('native full-check evidence requires every historical assertion and both Rust cases without skips', () => {
  const root = new URL('../', import.meta.url).pathname;
  const ledger = readFileSync(new URL('../docs/e4-ubuntu-failure-closure-v1.md', import.meta.url), 'utf8');
  const entries = [...ledger.matchAll(/^\| (\d+) \| `([^`:]+\.test\.mjs):(\d+)` \|/gmu)];
  assert.equal(entries.length, 29);
  const names = entries.map(([, , file, line]) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n');
    return source[Number(line) - 1]?.match(/^test\((['"])(.*?)\1/u)?.[2];
  });
  const rust = '20-class real edit-contract corpus uses exact oracles and no model calls';
  assert.ok(names.every(Boolean));
  const temporary = mkdtempSync(path.join(tmpdir(), 'phi-e4-tap-'));
  const output = path.join(temporary, 'full-check.log');
  const run = (lines) => {
    writeFileSync(output, `TAP version 13\n${lines.join('\n')}\n`);
    return spawnSync(process.execPath, [assertionUrl.pathname, output, root], { encoding: 'utf8' });
  };
  const pass = [...names, rust].map((name, index) => `ok ${index + 1} - ${name}`);
  try {
    const complete = run(pass);
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, /E4_PREFLIGHT_HISTORICAL_ASSERTIONS=PASS count=29/u);
    assert.match(complete.stdout, /E4_PREFLIGHT_RUST_HOST_ASSERTIONS=PASS count=2/u);
    assert.notEqual(run(pass.filter((_, index) => index !== 3)).status, 0, 'missing historical assertion');
    assert.notEqual(run(pass.map((line, index) => index === 4 ? `${line} # SKIP` : line)).status, 0, 'silently skipped assertion');
    assert.notEqual(run(pass.map((line, index) => index === 5 ? line.replace(/^ok/u, 'not ok') : line)).status, 0, 'failed assertion');
    assert.notEqual(run([...pass, pass[0]]).status, 0, 'duplicate assertion');
    assert.notEqual(run(pass.slice(0, -1)).status, 0, 'missing Rust syntax oracle');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('trusted Tier B removes only nested-userns denial and attests canonical fixture dependencies', () => {
  const strict = script.match(/bwrap_args=\(\n([\s\S]*?)\n\)/u)?.[1];
  assert.ok(strict);
  assert.match(strict, /--disable-userns/u);
  assert.match(script, /for argument in "\$\{bwrap_args\[@\]\}"; do\n  \[\[ "\$argument" == --disable-userns \]\] \|\| trusted_regression_args\+=\("\$argument"\)\ndone/u);
  assert.match(script, /\(\( \$\{#trusted_regression_args\[@\]\} \+ 1 == \$\{#bwrap_args\[@\]\} \)\) \|\| fail TIER_B_POLICY/u);
  assert.match(script, /run_validation 'test ! -e \/host .*\/usr\/bin\/unshare --user --map-root-user \/usr\/bin\/true' \|\| fail TIER_B_CAPABILITY/u);
  assert.match(script, /E4_PREFLIGHT_TIER_B_CAPABILITY=PASS/u);
  assert.match(script, /--setenv PI_OVERDRIVE_LSP_RUNTIME \/opt\/phi\/runtime\/lsp/u);
  assert.match(script, /compiler_target="\$stage\/fixture\/project\/runtime\/lsp\/node_modules\/typescript\/lib\/typescript\.js"/u);
  assert.match(script, /stat -c %h "\$compiler_target"\) == 1/u);
  assert.match(script, /cp -a -- "\$stage\/rootfs\/opt\/phi\/runtime\/dap\/python\/debugpy"/u);
  assert.doesNotMatch(script, /--setenv NODE_OPTIONS --test-reporter=tap/u);
  assert.match(script, /run_validation 'npm run check' \|\| fail FULL_CHECK/u);
  assert.match(script, /run_validation 'node --test --test-reporter=tap tests\/\*\.test\.mjs' \| tee "\$stage\/full-check\.log" \|\| fail FULL_TAP_CHECK/u);
  assert.match(script, /TEST_OVERLAY_BASE[\s\S]*TEST_OVERLAY_SOURCE[\s\S]*TEST_OVERLAY_TARGET/u);
  assert.match(script, /--ro-bind "\$stage\/rootfs\/opt\/phi\/browser\/agent-browser-0\.36\.0" \/tmp\/\.local\/share\/pi-overdrive\/agent-browser-0\.36\.0/u);
  assert.match(script, /--ro-bind "\$stage\/rootfs\/opt\/phi\/browser\/chrome-152\.0\.7977\.82" \/tmp\/\.agent-browser\/browsers\/chrome-152\.0\.7977\.82/u);
  assert.match(script, /expected_seed_sha=ddf8e28d8be90e1e2d941e364b68e735aa5dca3c48295763883d368f97e03f70/u);
  assert.doesNotMatch(script, /--share-net|--bind \/ \/|--bind \/var\/run|--bind \/run|--bind \/home/u);
});

test('frozen fixture test overlay changes only child reporter selection and is hash-bound', () => {
  const file = 'tests/clone-runtime-gate.test.mjs';
  const root = new URL('../', import.meta.url).pathname;
  const original = spawnSync('git', ['show', `${frozenProduct}:${file}`], { cwd: root, encoding: 'utf8' });
  assert.equal(original.status, 0, original.stderr);
  const overlay = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const before = "['--input-type=module', '-e', outerCeilingFixture]";
  const after = "['--test-reporter=tap', '--input-type=module', '-e', outerCeilingFixture]";
  assert.equal(original.stdout.split(before).length, 2, 'one exact frozen child invocation');
  assert.equal(overlay, original.stdout.replace(before, after), 'no assertion, discovery, fixture or line change');
  const digest = (content) => createHash('sha256').update(content).digest('hex');
  assert.equal(digest(original.stdout), 'a724c525f93c3c58b93cc7dbcf4198afddd1c3f0b1cfcd9b2a3d0d614fd9de74');
  assert.equal(digest(overlay), 'c1dac8bad745ef581b99c8872ce3ca6c26baecfad5818981a81293243951dfcb');
  assert.ok(script.includes(`"$product_sha" == ${frozenProduct}`));
  assert.ok(script.includes(digest(original.stdout)) && script.includes(digest(overlay)));
});

test('explicit parent TAP leaves real reporter children independent and preserves non-reporter NODE_OPTIONS', () => {
  const env = { ...process.env, NODE_OPTIONS: '--no-warnings' };
  delete env.NODE_TEST_CONTEXT;
  const files = ['tests/clone-runtime-gate.test.mjs', 'tests/clone-runtime-reporter.test.mjs', 'tests/failure-ledger.test.mjs'];
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files],
    { cwd: new URL('../', import.meta.url).pathname, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /^TAP version 13/mu);
  assert.match(run.stdout, /^# tests 20$/mu);
  assert.match(run.stdout, /^# pass 17$/mu);
  assert.match(run.stdout, /^# fail 0$/mu);
  assert.match(run.stdout, /^# skipped 3$/mu);
  assert.doesNotMatch(run.stdout + run.stderr, /ERR_INVALID_ARG_VALUE|FAILURE_LEDGER_INCOMPLETE/u);
  const child = spawnSync(process.execPath, ['--test', 'tests/e4-owned-rootfs-cleanup.test.mjs'],
    { cwd: new URL('../', import.meta.url).pathname, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.length > 0, 'child without an explicit reporter still reports results');
  assert.doesNotMatch(child.stdout + child.stderr, /ERR_INVALID_ARG_VALUE/u);

  const temporary = mkdtempSync(path.join(tmpdir(), 'phi-e4-reporter-child-'));
  try {
    const fixture = path.join(temporary, 'failure.test.mjs');
    writeFileSync(fixture, `import test from 'node:test';
import assert from 'node:assert/strict';
test('non-reporter option preserved', () => assert.equal(process.env.NODE_OPTIONS, '--no-warnings'));
test('genuine failure remains fatal', () => assert.equal(1, 2));
`);
    const failed = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture],
      { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /^# tests 2$/mu);
    assert.match(failed.stdout, /^# pass 1$/mu);
    assert.match(failed.stdout, /^# fail 1$/mu);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('probe fixture reset removes only the exact owned footprint and rejects extras or symlinks', () => {
  const syntax = spawnSync('bash', ['-n', resetUrl.pathname], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const root = mkdtempSync(path.join(tmpdir(), 'phi-e4-probe-reset-'));
  const fixture = path.join(root, 'fixture');
  const expected = `phi-e4-fixture:sha256:${'0'.repeat(64)}`;
  const prepare = () => {
    rmSync(fixture, { recursive: true, force: true });
    mkdirSync(fixture);
    writeFileSync(path.join(fixture, 'fixture-identity'), `${expected}\n`);
    writeFileSync(path.join(fixture, 'fixture-writable'), '');
    writeFileSync(path.join(fixture, 'writable'), '');
  };
  const run = () => spawnSync('bash', [resetUrl.pathname, fixture, expected], { encoding: 'utf8' });
  try {
    prepare();
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /E4_PREFLIGHT_FIXTURE_RESET=PASS/u);
    assert.deepEqual(readdirSync(fixture), []);
    prepare();
    writeFileSync(path.join(fixture, 'unexpected'), 'user bytes');
    const extra = run();
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /UNEXPECTED_ENTRIES/u);
    assert.equal(readFileSync(path.join(fixture, 'unexpected'), 'utf8'), 'user bytes');
    assert.equal(readdirSync(fixture).length, 4);
    prepare();
    rmSync(path.join(fixture, 'writable'));
    symlinkSync(path.join(root, 'foreign'), path.join(fixture, 'writable'));
    const escaped = run();
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr, /CANARY/u);
    assert.equal(readdirSync(fixture).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight rejects malformed gate mode before any host or network action', () => {
  const result = spawnSync('bash', [scriptUrl.pathname, 'invalid', '0'.repeat(40), '/tmp'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, E4_GATE_KIND: 'unknown' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^E4_PREFLIGHT_FAIL=GATE_KIND$/mu);
  assert.doesNotMatch(result.stdout, /E4_PREFLIGHT_IMAGE|E4_UBUNTU_PREFLIGHT=PASS/u);
});

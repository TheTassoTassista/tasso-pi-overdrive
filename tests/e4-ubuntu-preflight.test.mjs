import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const scriptUrl = new URL('../scripts/e4-ubuntu-preflight.sh', import.meta.url);
const script = readFileSync(scriptUrl, 'utf8');
const resetUrl = new URL('../certification/e4-probe-fixture-reset.sh', import.meta.url);
const probe = readFileSync(new URL('../certification/e4-host-probe.sh', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
const preflight = workflow.split('  e4-ubuntu-preflight:\n')[1]?.split('  integrated-ubuntu:\n')[0];

test('Ubuntu preflight is a separate exact-image, exact-candidate gate without E4 or Windows', () => {
  assert.ok(preflight);
  assert.match(preflight, /inputs\['e4-ubuntu-preflight-only'\] && !inputs\['campaign3-e4-certification'\]/u);
  assert.match(preflight, /runs-on: ubuntu-24\.04/u);
  assert.match(preflight, /packages: read/u);
  assert.match(preflight, /E4_GATE_KIND: preflight/u);
  assert.match(preflight, /ref: \$\{\{ inputs\.certified_sha \}\}/u);
  assert.match(preflight, /bash scripts\/e4-ubuntu-preflight\.sh 'ghcr\.io\/thetassotassista\/tasso-pi-overdrive-e4@sha256:[a-f0-9]{64}'/u);
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
  assert.match(script, /run_validation 'node scripts\/phi-owned-main-suite\.mjs'/u);
  assert.match(script, /run_validation 'node scripts\/phi-repository-audit\.mjs'/u);
  assert.match(script, /E4_PREFLIGHT_CLEANUP=%s/u);
  assert.match(script, /E4_PREFLIGHT_RESIDUAL_OWNED_PROCESSES=%s/u);
  assert.match(script, /rm -rf -- "\$stage" \|\| cleanup_ok=0/u);
  assert.match(script, /assert_no_owned\(\)/u);
  assert.equal((script.match(/^assert_no_owned$/gmu) ?? []).length, 6, 'every payload phase must drain before the next');
  assert.doesNotMatch(script, /sudo (?:-n )?"?\$?expected_bwrap|sudo (?:-n )?bwrap|--privileged|seccomp=unconfined|--share-net|GITHUB_TOKEN|GH_TOKEN|https?:\/\//u);
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
  assert.match(script, /--setenv NODE_OPTIONS --test-reporter=tap/u);
  assert.match(script, /--ro-bind "\$stage\/rootfs\/opt\/phi\/browser\/agent-browser-0\.36\.0" \/tmp\/\.local\/share\/pi-overdrive\/agent-browser-0\.36\.0/u);
  assert.match(script, /--ro-bind "\$stage\/rootfs\/opt\/phi\/browser\/chrome-152\.0\.7977\.82" \/tmp\/\.agent-browser\/browsers\/chrome-152\.0\.7977\.82/u);
  assert.match(script, /expected_seed_sha=ddf8e28d8be90e1e2d941e364b68e735aa5dca3c48295763883d368f97e03f70/u);
  assert.doesNotMatch(script, /--share-net|--bind \/ \/|--bind \/var\/run|--bind \/run|--bind \/home/u);
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

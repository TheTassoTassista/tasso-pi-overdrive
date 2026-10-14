import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const scriptUrl = new URL('../scripts/e4-ubuntu-preflight.sh', import.meta.url);
const script = readFileSync(scriptUrl, 'utf8');
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
  assert.match(script, /run_payload \/usr\/bin\/node \/opt\/phi\/e4-image-selfcheck\.mjs/u);
  assert.match(script, /run_validation 'npm run check'/u);
  assert.match(script, /run_validation 'node scripts\/phi-owned-main-suite\.mjs'/u);
  assert.match(script, /run_validation 'node scripts\/phi-repository-audit\.mjs'/u);
  assert.match(script, /E4_PREFLIGHT_CLEANUP=%s/u);
  assert.match(script, /E4_PREFLIGHT_RESIDUAL_OWNED_PROCESSES=%s/u);
  assert.match(script, /assert_no_owned\(\)/u);
  assert.equal((script.match(/^assert_no_owned$/gmu) ?? []).length, 5, 'every payload phase must drain before the next');
  assert.doesNotMatch(script, /sudo (?:-n )?"?\$?expected_bwrap|sudo (?:-n )?bwrap|--privileged|seccomp=unconfined|--share-net|GITHUB_TOKEN|GH_TOKEN|https?:\/\//u);
});

test('preflight rejects malformed gate mode before any host or network action', () => {
  const result = spawnSync('bash', [scriptUrl.pathname, 'invalid', '0'.repeat(40), '/tmp'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, E4_GATE_KIND: 'unknown' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^E4_PREFLIGHT_FAIL=GATE_KIND$/mu);
  assert.doesNotMatch(result.stdout, /E4_PREFLIGHT_IMAGE|E4_UBUNTU_PREFLIGHT=PASS/u);
});

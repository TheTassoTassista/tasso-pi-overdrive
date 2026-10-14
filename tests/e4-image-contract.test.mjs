import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('E4 image is built from the pinned base and exact seed/LSP contexts with structural /phi', () => {
  const dockerfile = read('certification/Dockerfile.e4');
  const ignore = read('certification/Dockerfile.e4.dockerignore');
  assert.match(dockerfile, /^FROM docker\.io\/library\/archlinux:base@sha256:[a-f0-9]{64}$/mu);
  assert.match(dockerfile, /^COPY --from=seeds \/usr \/usr$/mu);
  assert.match(dockerfile, /readelf -d \/usr\/bin\/node \| grep -Fq 'Shared library: \[libsimdjson\.so\.33\]'/u);
  assert.match(dockerfile, /ld-linux-x86-64\.so\.2 --list \/usr\/bin\/node/u);
  assert.match(dockerfile, /TOOLCHAIN_RUNTIME_DEPENDENCY_MISSING tool=node soname=libsimdjson\.so\.33/u);
  assert.match(dockerfile, /^COPY --from=lsp \/ \/opt\/phi\/runtime\/lsp\/managed\/$/mu);
  assert.match(dockerfile, /^COPY config\/routing-policy\.json \/opt\/phi\/project\/config\/routing-policy\.json$/mu);
  assert.match(ignore, /^!config\/routing-policy\.json$/mu);
  assert.match(dockerfile, /mkdir -p \/phi \/evidence \/run \/tmp/u);
  assert.match(dockerfile, /USER 1001:1001/u);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/node", "\/opt\/phi\/e4-image-selfcheck\.mjs"\]/u);
  assert.doesNotMatch(dockerfile, /COPY \./u);
  assert.equal(ignore.split('\n')[0], '**');
  assert.doesNotMatch(ignore, /!\.git|!\.env|!docs\/final-adversarial-audit/u);
});

test('E4 self-check reads live tool manifests, proves jiti resolution and fails closed on identity mismatch', () => {
  const source = read('scripts/e4-image-selfcheck.mjs');
  for (const name of ['e4-toolchain-seeds.json', 'git-resources.json', 'dap-engine.json', 'eval-engine.json', 'ast-edit.json', 'pi-package-lock.json']) {
    assert.ok(source.includes(name), `${name} must be read`);
  }
  assert.match(source, /requireFromSubagents\.resolve\('jiti'\)/u);
  assert.match(source, /prompt-template-bridge\.ts/u);
  assert.match(source, /fs\.readdirSync\('\/phi'\)\.length, 0/u);
  assert.match(source, /E4_IMAGE_SELFCHECK=FAIL/u);
  assert.match(source, /E4_IMAGE_NODE_ELF_CLOSURE=PASS/u);
  assert.match(source, /simdjson\.requiredBySha256, nodeSeed\.extracted\[0\]\.sha256/u);
  assert.match(source, /fs\.realpathSync\(simdjson\.linkPath\), simdjson\.path/u);
  assert.match(source, /node_modules\/@ast-grep\/cli-linux-x64-gnu/u);
  assert.match(source, /fileIdentity\(astBin, ast\.binarySha256\)/u);
  assert.match(source, /\['--test', '--test-reporter=tap',/u);
  assert.doesNotMatch(source, /path\.join\(root, 'pi', 'npm', 'node_modules', '@ast-grep', 'cli', 'ast-grep'\)/u);
  assert.doesNotMatch(source, /fetch\(|https?:\/\//u);
});

test('E4 image qualification cannot launch preflight, default matrix or certification', () => {
  const workflow = read('.github/workflows/phi-foundation.yml');
  const job = workflow.split('  e4-image-qualification:\n')[1]?.split('  integrated-ubuntu:\n')[0];
  assert.ok(job);
  assert.match(job, /inputs\['e4-image-qualification-only'\] && !inputs\['e4-host-feasibility-only'\] && !inputs\['campaign3-e4-certification'\]/u);
  assert.match(job, /runs-on: ubuntu-24\.04/u);
  assert.match(job, /packages: write/u);
  assert.match(job, /node scripts\/e4-stage-seeds\.mjs/u);
  assert.match(job, /node scripts\/install-managed-lsp\.mjs --runtime "\$RUNNER_TEMP\/phi-e4-lsp" --check/u);
  assert.match(job, /docker run --rm --name "phi-e4-image-selfcheck-\$GITHUB_RUN_ID" --network none --read-only --cap-drop ALL/u);
  assert.match(job, /--security-opt no-new-privileges/u);
  assert.match(job, /test "\$package" = private/u);
  assert.match(job, /if: always\(\)[\s\S]*E4_IMAGE_RESIDUAL_OWNED_CONTAINERS=0/u);
  assert.doesNotMatch(job, /npm run check|phi-owned-main-suite|campaign3-e1-focused|campaign3-e2-focused|campaign3-e3-focused/u);
  const ordinary = workflow.split('  native-foundation:\n')[1]?.split('\n')[0] ?? '';
  assert.match(ordinary, /!inputs\['e4-image-qualification-only'\]/u);
});

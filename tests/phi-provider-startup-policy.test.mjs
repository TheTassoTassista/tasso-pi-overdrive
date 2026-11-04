import assert from 'node:assert/strict';
import test from 'node:test';
import { pinFreshSessionDefault } from '../lib/phi-initial-model.mjs';
import { createOmniRouteSelectionGate } from '../extensions/omniroute.ts';

const codex = { defaultProvider: 'openai-codex', defaultModel: 'gpt-6-sol' };

test('fresh Phi session pins its configured default instead of Pi authenticated-provider fallback', () => {
  assert.deepEqual(pinFreshSessionDefault(['--offline', '--mode', 'rpc'], codex),
    ['--provider', 'openai-codex', '--model', 'gpt-6-sol', '--offline', '--mode', 'rpc']);
  assert.deepEqual(pinFreshSessionDefault(['--no-session'], { defaultProvider: 'anthropic', defaultModel: 'claude-opus-5' }),
    ['--provider', 'anthropic', '--model', 'claude-opus-5', '--no-session']);
  assert.deepEqual(pinFreshSessionDefault(['--provider', 'omniroute', '--model', 'fixture/local'], codex),
    ['--provider', 'omniroute', '--model', 'fixture/local']);
  assert.deepEqual(pinFreshSessionDefault(['--continue'], codex), ['--continue']);
  assert.deepEqual(pinFreshSessionDefault(['--session', 'owned.jsonl'], codex), ['--session', 'owned.jsonl']);
  assert.throws(() => pinFreshSessionDefault([], { ...codex, defaultModel: 'bad\nmodel' }), /PHI_MODEL_DEFAULT_INVALID/u);
  assert.throws(() => pinFreshSessionDefault([], null), /PHI_MODEL_DEFAULT_UNAVAILABLE/u);
});

test('OmniRoute token alone never authorizes its stream, but explicit selection does', () => {
  const gate = createOmniRouteSelectionGate(['pi', '--mode', 'rpc']);
  assert.throws(() => gate.assertAuthorized(), /OMNIROUTE_EXPLICIT_SELECTION_REQUIRED/u);
  gate.selected({ model: { provider: 'omniroute' }, source: 'restore' });
  assert.throws(() => gate.assertAuthorized(), /OMNIROUTE_EXPLICIT_SELECTION_REQUIRED/u);
  gate.selected({ model: { provider: 'omniroute' }, source: 'set' });
  assert.doesNotThrow(() => gate.assertAuthorized());
  gate.selected({ model: { provider: 'openai-codex' }, source: 'set' });
  assert.throws(() => gate.assertAuthorized(), /OMNIROUTE_EXPLICIT_SELECTION_REQUIRED/u);
  assert.doesNotThrow(() => createOmniRouteSelectionGate(['pi', '--provider', 'omniroute']).assertAuthorized());
  assert.doesNotThrow(() => createOmniRouteSelectionGate(['pi', '--model', 'omniroute/fixture/local']).assertAuthorized());
  assert.throws(() => createOmniRouteSelectionGate(['pi', '--provider', 'anthropic']).assertAuthorized(), /OMNIROUTE_EXPLICIT_SELECTION_REQUIRED/u);
});

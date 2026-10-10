import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedTaskPublicationIntent, publicationApprovalMatchesEnvelope } from '../lib/phi-worker-authority.mjs';
import { resolveTaskPolicy } from '../lib/task-governor.mjs';

test('legacy internal controller rename approval remains distinct from immutable ordinary envelope', () => {
  const rename = { sourcePath: 'move.txt', destinationPath: 'moved.txt' };
  const approval = { approveProjectMutation: true, rename };
  assert.equal(publicationApprovalMatchesEnvelope(null, approval), true);
  assert.equal(publicationApprovalMatchesEnvelope(null, null), false);
  assert.equal(publicationApprovalMatchesEnvelope(undefined, approval), false);
  assert.equal(publicationApprovalMatchesEnvelope({ operation: 'CREATE', target: 'moved.txt' }, approval), false);
  assert.equal(publicationApprovalMatchesEnvelope({ operation: 'MODIFY', target: 'moved.txt' }, approval), false);
  assert.equal(publicationApprovalMatchesEnvelope({ operation: 'DELETE', target: 'moved.txt' }, approval), false);
  const envelope = { operation: 'RENAME', source: 'move.txt', target: 'moved.txt' };
  assert.equal(publicationApprovalMatchesEnvelope(envelope, approval), true);
  assert.equal(publicationApprovalMatchesEnvelope(envelope, { approveProjectMutation: true }), false);
  assert.equal(publicationApprovalMatchesEnvelope(envelope, { approveProjectMutation: true,
    rename: { sourcePath: 'move.txt', destinationPath: 'else.txt' } }), false);
  assert.equal(publicationApprovalMatchesEnvelope(envelope, { approveProjectMutation: true,
    rename: { sourcePath: 'else.txt', destinationPath: 'moved.txt' } }), false);
  assert.equal(publicationApprovalMatchesEnvelope({ operation: 'CREATE', target: 'moved.txt' }, { approveProjectMutation: true }), true);
});

test('ordinary publication still rejects absent or nonmatching trusted task intent before delegation', () => {
  const task = 'Rename file `move.txt` to `moved.txt`';
  const policy = resolveTaskPolicy({ task });
  assert.throws(() => boundedTaskPublicationIntent(task, null, policy), /PUBLICATION_ENVELOPE_DENIED/u);
  assert.throws(() => boundedTaskPublicationIntent(task, 'Rename file `move.txt` to `other.txt`', policy), /PUBLICATION_ENVELOPE_DENIED/u);
  assert.deepEqual(boundedTaskPublicationIntent(task, task, policy),
    { operation: 'RENAME', target: 'moved.txt', source: 'move.txt' });
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const packageRoot = process.env.PHI_PI15_PACKAGE_ROOT;
const expectedHash = 'e52d27d064df05fe8ec15f05db07d7c895051597551a0d62b2fe77208d88e942';

test('published Pi 1.5 bundle rejects six response content encodings without crashing', { skip: !packageRoot }, async () => {
  const chunk = path.join(packageRoot, 'dist/bundle/chunks/chunk-44DLKSKE.js');
  const bytes = fs.readFileSync(chunk);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash, 'must exercise the exact published chunk');
  const { configureHttpDispatcher } = await import(pathToFileURL(chunk).href);
  const originalFetch = globalThis.fetch;
  configureHttpDispatcher(2000);
  assert.notEqual(globalThis.fetch, originalFetch, 'bundled dispatcher must install bundled fetch');

  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip' });
    response.end('invalid-encoding-body');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    await assert.rejects(
      async () => (await globalThis.fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(3000) })).text(),
      (error) => error?.name === 'TypeError' && /^too many content-encodings in response: 6, maximum allowed is 5$/u.test(error?.cause?.message ?? ''),
    );
    assert.equal(requests, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

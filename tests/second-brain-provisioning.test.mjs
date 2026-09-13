import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("Second Brain Python environments are fully and deterministically locked", () => {
  for (const relative of ["services/requirements-openviking.lock.txt", "services/requirements-hindsight.lock.txt"]) {
    const entries = read(relative).trim().split(/\r?\n/u);
    assert.ok(entries.length >= 100);
    assert.deepEqual(entries, [...entries].sort());
    assert.ok(entries.every((entry) => /^[A-Za-z0-9_.-]+==[^\s=]+$/u.test(entry)));
  }
});

test("embedding service uses only the checksum-pinned local CPU artifact", () => {
  const manifest = JSON.parse(read("config/local-embedding-model.json"));
  const service = read("services/systemd/pi-overdrive-embeddings.service.in");
  const implementation = read("services/local_embeddings.py");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/u);
  assert.equal(Object.keys(manifest.files).length, 5);
  assert.ok(Object.values(manifest.files).every((digest) => /^[0-9a-f]{64}$/u.test(digest)));
  assert.match(service, new RegExp(`snapshots/${manifest.revision}`, "u"));
  assert.match(service, /Environment=ORT_DISABLE_TELEMETRY=1/u);
  assert.match(implementation, /os\.environ\.setdefault\("ORT_DISABLE_TELEMETRY", "1"\)/u);
  assert.match(implementation, /local_files_only=True/u);
  assert.match(implementation, /providers=\["CPUExecutionProvider"\]/u);
});

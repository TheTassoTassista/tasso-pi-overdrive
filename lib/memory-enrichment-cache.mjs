import path from "node:path";
import { canonicalMemoryText, containsSecret, ensurePrivateDirectory, memoryDigest, readPrivateJson, safeMemoryId, writePrivateJsonAtomic } from "./memory-security.mjs";

function sentences(text) {
  return text.split(/(?<=[.!?])\s+/u).map((value) => value.trim()).filter(Boolean);
}

function bounded(value, max) {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function deterministicMemoryEnrichment({ sourceId, content, reusedL0, reusedL1 } = {}) {
  const source = safeMemoryId(sourceId, "memory_source_id");
  const text = canonicalMemoryText(content, 64_000);
  if (containsSecret(text)) throw new Error("memory_secret_rejected");
  const parts = sentences(text);
  const l0 = canonicalMemoryText(reusedL0 ?? bounded(parts[0] ?? text, 256), 256);
  const l1 = canonicalMemoryText(reusedL1 ?? bounded(parts.slice(0, 6).join(" ") || text, 1400), 1400);
  if (containsSecret(l0) || containsSecret(l1)) throw new Error("memory_secret_rejected");
  return Object.freeze({ sourceId: source, sourceHash: memoryDigest(text), l0, l1, l0Hash: memoryDigest(l0), l1Hash: memoryDigest(l1), provider: reusedL0 || reusedL1 ? "task-output" : "local", model: reusedL0 || reusedL1 ? "reuse" : "deterministic-v1" });
}

export class MemoryEnrichmentCache {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, "enrichment-cache.json");
    this.clock = options.clock ?? (() => new Date());
    this.emit = options.emit;
  }

  put(input) {
    const generated = deterministicMemoryEnrichment(input);
    const state = readPrivateJson(this.file, { version: 1, entries: [] });
    const current = state.entries.find((entry) => entry.sourceId === generated.sourceId && entry.current === true);
    if (current?.sourceHash === generated.sourceHash) {
      this.#event("REUSED", current);
      return Object.freeze({ status: "REUSED", entry: Object.freeze({ ...current }) });
    }
    for (const entry of state.entries) {
      if (entry.sourceId === generated.sourceId && entry.current === true) {
        entry.current = false;
        entry.superseded = true;
      }
    }
    const entry = { ...generated, timestamp: this.clock().toISOString(), provenance: `${generated.provider}:${generated.model}`, current: true, superseded: false, published: { openviking: false, hindsight: false } };
    state.entries.push(entry);
    writePrivateJsonAtomic(this.file, state);
    this.#event("STORED", entry);
    return Object.freeze({ status: "STORED", entry: Object.freeze({ ...entry }) });
  }

  needsPublication(entry, backend) {
    if (!['openviking', 'hindsight'].includes(backend)) throw new Error('memory_backend_invalid');
    return entry?.published?.[backend] !== true;
  }

  markPublished(sourceId, sourceHash, backend) {
    const source = safeMemoryId(sourceId, 'memory_source_id');
    if (!['openviking', 'hindsight'].includes(backend)) throw new Error('memory_backend_invalid');
    const state = readPrivateJson(this.file, { version: 1, entries: [] });
    const entry = state.entries.find((candidate) => candidate.sourceId === source && candidate.sourceHash === sourceHash && candidate.current === true);
    if (!entry) throw new Error('memory_enrichment_entry_missing');
    entry.published = { openviking: entry.published?.openviking === true, hindsight: entry.published?.hindsight === true, [backend]: true };
    writePrivateJsonAtomic(this.file, state);
    return Object.freeze({ ...entry, published: Object.freeze({ ...entry.published }) });
  }

  #event(status, entry) {
    try { this.emit?.({ kind: "memory_enrichment", status, sourceIdHash: memoryDigest(entry.sourceId), sourceHash: entry.sourceHash, provider: entry.provider, model: entry.model, l0Chars: entry.l0.length, l1Chars: entry.l1.length, remoteCalls: 0 }); } catch {}
  }
}

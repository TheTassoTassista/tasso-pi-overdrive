import path from "node:path";
import { canonicalMemoryText, containsSecret, ensurePrivateDirectory, memoryDigest, MEMORY_TRUST_LEVELS, MEMORY_TYPES, readPrivateJson, safeMemoryId, writePrivateJsonAtomic } from "./memory-security.mjs";

const EMPTY_LEDGER = Object.freeze({ version: 1, entries: [] });
const IMPORTANCE = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const TRUST = Object.freeze({ EXTERNAL: 0, INFERRED: 1, PROJECT_DOC: 2, USER: 3, VERIFIED: 4 });

function tokens(value) {
  return new Set(String(value).toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length > 1));
}

function relevance(entry, query) {
  const wanted = tokens(query);
  const available = tokens(`${entry.content} ${entry.tags.join(" ")} ${entry.type}`);
  let overlap = 0;
  for (const token of wanted) if (available.has(token)) overlap += 1;
  if (wanted.size > 0 && overlap === 0) return Number.NEGATIVE_INFINITY;
  const lexical = wanted.size === 0 ? 0 : overlap / wanted.size;
  return lexical * 10 + TRUST[entry.trustLevel] * 2 + IMPORTANCE[entry.importance] + (entry.current ? 3 : -2) + (entry.verified ? 2 : 0);
}

function activeAt(entry, now) {
  if (!entry.current || entry.supersededBy) return false;
  if (!entry.expiresAt) return true;
  return Date.parse(entry.expiresAt) > now.getTime();
}

export class MemoryLedger {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, options.fileName ?? "curation-ledger.json");
    this.clock = options.clock ?? (() => new Date());
  }

  load() {
    ensurePrivateDirectory(this.root);
    const value = readPrivateJson(this.file, EMPTY_LEDGER);
    if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error("memory_ledger_invalid");
    return value;
  }

  save(value) {
    ensurePrivateDirectory(this.root);
    writePrivateJsonAtomic(this.file, value);
  }

  accept(candidate) {
    try {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { status: "REJECTED", reason: "invalid_candidate" };
      if (!MEMORY_TYPES.includes(candidate.type)) return { status: "REJECTED", reason: "invalid_type" };
      if (!MEMORY_TRUST_LEVELS.includes(candidate.trustLevel)) return { status: "REJECTED", reason: "invalid_trust" };
      const content = canonicalMemoryText(candidate.content);
      if (containsSecret({ ...candidate, content })) return { status: "REJECTED", reason: "secret_detected" };
      if (/^(?:user|assistant|system|tool)\s*:/imu.test(content) || /<\/?(?:conversation|transcript|messages?)>/iu.test(content) || candidate.rawTranscript === true) return { status: "REJECTED", reason: "raw_transcript" };
      if (content.length < 20 && candidate.importance !== "critical") return { status: "REJECTED", reason: "low_value" };
      const project = safeMemoryId(candidate.project, "memory_project");
      const source = canonicalMemoryText(candidate.source, 1000);
      const sourceType = safeMemoryId(candidate.sourceType, "memory_source_type");
      const scope = safeMemoryId(candidate.scope ?? "project", "memory_scope");
      const importance = Object.hasOwn(IMPORTANCE, candidate.importance) ? candidate.importance : "medium";
      const confidence = Number(candidate.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { status: "REJECTED", reason: "invalid_confidence" };
      const canonicalHash = memoryDigest(`${project}\0${candidate.type}\0${content.toLowerCase()}`);
      const ledger = this.load();
      const duplicate = ledger.entries.find((entry) => entry.canonicalHash === canonicalHash);
      if (duplicate) return { status: "REJECTED", reason: "duplicate", dedupeHit: true, existingId: duplicate.id };
      const now = this.clock();
      const retentionDays = candidate.retentionDays === 0 ? 0 : Math.max(1, Math.min(3650, Number(candidate.retentionDays) || 365));
      const id = safeMemoryId(candidate.id ?? `mem-${canonicalHash.slice(0, 24)}`);
      if (ledger.entries.some((entry) => entry.id === id)) return { status: "REJECTED", reason: "duplicate_id" };
      const supersedes = candidate.supersedes ? safeMemoryId(candidate.supersedes) : undefined;
      if (supersedes) {
        const older = ledger.entries.find((entry) => entry.id === supersedes);
        if (!older) return { status: "REJECTED", reason: "supersedes_missing" };
        if (older.project !== project) return { status: "REJECTED", reason: "supersedes_scope_mismatch" };
        older.current = false;
        older.supersededBy = id;
        older.updatedAt = now.toISOString();
      }
      const entry = Object.freeze({
        id,
        type: candidate.type,
        project,
        scope,
        content,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        source,
        sourceType,
        trustLevel: candidate.trustLevel,
        confidence,
        verified: candidate.verified === true,
        importance,
        retentionDays,
        expiresAt: retentionDays === 0 ? null : new Date(now.getTime() + retentionDays * 86400000).toISOString(),
        supersedes: supersedes ?? null,
        supersededBy: null,
        current: true,
        tags: Object.freeze([...new Set((candidate.tags ?? []).map((tag) => safeMemoryId(tag, "memory_tag")))].slice(0, 24)),
        reason: canonicalMemoryText(candidate.reason ?? "Curated durable project memory", 1000),
        canonicalHash,
      });
      ledger.entries.push(entry);
      this.save(ledger);
      return { status: "ACCEPTED", entry, supersededMemory: supersedes ?? null };
    } catch (error) {
      return { status: "REJECTED", reason: error instanceof Error ? error.message : "curation_error" };
    }
  }

  get(id) {
    const wanted = safeMemoryId(id);
    return this.load().entries.find((entry) => entry.id === wanted);
  }

  recent({ project, limit = 10, includeExpired = false } = {}) {
    const now = this.clock();
    return this.load().entries
      .filter((entry) => (!project || entry.project === project) && (includeExpired || activeAt(entry, now)))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, Math.min(50, limit)));
  }

  search(query, { project, limit = 10, historical = false, types } = {}) {
    const now = this.clock();
    return this.load().entries
      .filter((entry) => (!project || entry.project === project) && (!types || types.includes(entry.type)) && (historical || activeAt(entry, now)))
      .map((entry) => ({ ...entry, score: relevance(entry, query), expired: Boolean(entry.expiresAt && Date.parse(entry.expiresAt) <= now.getTime()) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, Math.min(64, limit)));
  }

  stats(project) {
    const now = this.clock();
    const entries = this.load().entries.filter((entry) => !project || entry.project === project);
    return { total: entries.length, current: entries.filter((entry) => activeAt(entry, now)).length, superseded: entries.filter((entry) => Boolean(entry.supersededBy)).length, expired: entries.filter((entry) => Boolean(entry.expiresAt && Date.parse(entry.expiresAt) <= now.getTime())).length };
  }
}

export function toPackItem(entry, backend = "ledger") {
  return Object.freeze({ id: entry.id, type: entry.type, project: entry.project, content: entry.content, source: entry.source, sourceType: entry.sourceType, trustLevel: entry.trustLevel, confidence: entry.confidence, verified: entry.verified, current: entry.current && !entry.supersededBy && !entry.expired, level: 0, backend, score: entry.score ?? 0 });
}

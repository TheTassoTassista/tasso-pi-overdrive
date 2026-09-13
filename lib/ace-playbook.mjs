import path from "node:path";
import { canonicalMemoryText, containsSecret, ensurePrivateDirectory, memoryDigest, readPrivateJson, safeMemoryId, writePrivateJsonAtomic } from "./memory-security.mjs";

const EMPTY = Object.freeze({ version: 1, entries: [] });

function overlap(query, lesson) {
  const terms = new Set(String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 2));
  const content = String(`${lesson.title} ${lesson.procedure} ${lesson.tags.join(" ")}`).toLowerCase();
  let hits = 0;
  for (const term of terms) if (content.includes(term)) hits += 1;
  if (terms.size > 0 && hits === 0) return 0;
  return hits + (lesson.outcome === "success" ? 1 : 0) + (lesson.verified ? 2 : 0);
}

export class AcePlaybook {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, options.fileName ?? "ace-playbook.json");
    this.maxEntries = options.maxEntries ?? 128;
    this.clock = options.clock ?? (() => new Date());
  }

  load() {
    ensurePrivateDirectory(this.root);
    const value = readPrivateJson(this.file, EMPTY);
    if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error("ace_playbook_invalid");
    return value;
  }

  add(candidate) {
    try {
      const title = canonicalMemoryText(candidate.title, 160);
      const procedure = canonicalMemoryText(candidate.procedure, 2400);
      const reason = canonicalMemoryText(candidate.reason ?? "Reusable verified working method", 600);
      if (containsSecret(candidate)) return { status: "REJECTED", reason: "secret_detected" };
      if (candidate.rawTranscript === true || /^(?:user|assistant|system|tool)\s*:/imu.test(procedure) || procedure.length < 24) return { status: "REJECTED", reason: "raw_or_low_value" };
      if (!["success", "failed"].includes(candidate.outcome)) return { status: "REJECTED", reason: "outcome_invalid" };
      if (candidate.outcome === "failed" && !String(candidate.failureReason ?? "").trim()) return { status: "REJECTED", reason: "failure_reason_required" };
      const project = safeMemoryId(candidate.project, "ace_project");
      const source = canonicalMemoryText(candidate.source, 800);
      const canonicalHash = memoryDigest(`${project}\0${title.toLowerCase()}\0${procedure.toLowerCase()}`);
      const playbook = this.load();
      const duplicate = playbook.entries.find((entry) => entry.canonicalHash === canonicalHash);
      if (duplicate) return { status: "REJECTED", reason: "duplicate", dedupeHit: true, existingId: duplicate.id };
      const now = this.clock().toISOString();
      const id = safeMemoryId(candidate.id ?? `ace-${canonicalHash.slice(0, 24)}`);
      const entry = {
        id, project, title, procedure, outcome: candidate.outcome,
        failureReason: candidate.outcome === "failed" ? canonicalMemoryText(candidate.failureReason, 800) : null,
        conditions: candidate.conditions ? canonicalMemoryText(candidate.conditions, 800) : null,
        source, sourceType: safeMemoryId(candidate.sourceType, "ace_source_type"),
        trustLevel: candidate.verified === true ? "VERIFIED" : "INFERRED", verified: candidate.verified === true,
        tags: [...new Set((candidate.tags ?? []).map((tag) => safeMemoryId(tag, "ace_tag")))].slice(0, 16),
        reason, createdAt: now, updatedAt: now, uses: 0, canonicalHash,
      };
      playbook.entries.push(entry);
      playbook.entries = playbook.entries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, this.maxEntries);
      ensurePrivateDirectory(this.root);
      writePrivateJsonAtomic(this.file, playbook);
      return { status: "ACCEPTED", entry };
    } catch (error) {
      return { status: "REJECTED", reason: error instanceof Error ? error.message : "ace_error" };
    }
  }

  search(query, { project, limit = 4 } = {}) {
    return this.load().entries
      .filter((entry) => !project || entry.project === project)
      .map((entry) => ({ ...entry, score: overlap(query, entry) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, Math.min(12, limit)));
  }

  compact(query, options = {}) {
    return this.search(query, options).map((entry) => ({
      id: entry.id,
      type: entry.outcome === "failed" ? "failed_strategy" : "lesson",
      project: entry.project,
      content: `${entry.title}: ${entry.procedure}${entry.failureReason ? ` Failed because: ${entry.failureReason}` : ""}${entry.conditions ? ` Conditions: ${entry.conditions}` : ""}`,
      source: entry.source,
      sourceType: entry.sourceType,
      trustLevel: entry.trustLevel,
      confidence: entry.verified ? 1 : 0.6,
      verified: entry.verified,
      current: true,
      level: 0,
      backend: "ace",
      score: entry.score,
    }));
  }

  stats(project) {
    const entries = this.load().entries.filter((entry) => !project || entry.project === project);
    return { total: entries.length, verified: entries.filter((entry) => entry.verified).length, failedStrategies: entries.filter((entry) => entry.outcome === "failed").length };
  }
}

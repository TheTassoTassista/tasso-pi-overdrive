import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { toPackItem } from "./memory-ledger.mjs";
import { renderUntrustedMemoryData } from "./memory-security.mjs";
import { routeMemoryQuery } from "./memory-router.mjs";

const TRUST_SCORE = Object.freeze({ VERIFIED: 5, USER: 4, PROJECT_DOC: 3, INFERRED: 1, EXTERNAL: 0 });

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function dedupeRank(items) {
  const unique = new Map();
  for (const item of items) {
    const key = createHash("sha256").update(`${item.project ?? ""}\0${item.type}\0${String(item.content).toLowerCase()}`).digest("hex");
    const prior = unique.get(key);
    const value = { ...item, rank: Number(item.score ?? 0) + TRUST_SCORE[item.trustLevel] * 4 + (item.verified ? 5 : 0) + (item.current === false ? -20 : 4) };
    if (!prior || value.rank > prior.rank) unique.set(key, value);
  }
  return [...unique.values()].sort((left, right) => right.rank - left.rank || left.id.localeCompare(right.id));
}

function fit(items, charLimit) {
  const selected = [];
  for (const item of items) {
    const trial = renderUntrustedMemoryData([...selected, item]);
    if (trial.length > charLimit) continue;
    selected.push(item);
  }
  return selected;
}

function memoryEvent(emit, data) {
  try { emit?.({ ...data, timestamp: undefined }); } catch {}
}

export class SharedMemoryPackController {
  constructor({ projectId, hindsightBankId, policy, ledger, ace, openViking, hindsight, emit } = {}) {
    this.projectId = projectId;
    this.hindsightBankId = hindsightBankId ?? projectId;
    this.policy = policy;
    this.ledger = ledger;
    this.ace = ace;
    this.openViking = openViking;
    this.hindsight = hindsight;
    this.emit = emit;
    this.cache = new Map();
    this.backendCalls = { openviking: 0, hindsight: 0, ace: 0, ledger: 0 };
  }

  async build(query, hints = {}) {
    const route = routeMemoryQuery(query, hints);
    const cacheKey = createHash("sha256").update(JSON.stringify({ query, route, policy: this.policy, projectId: this.projectId, detailLevel: hints.detailLevel ?? 0, selectedUri: hints.selectedUri ?? null, reflectExplicit: hints.reflectExplicit === true })).digest("hex");
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const promise = this.#buildUncached(query, route, hints, cacheKey);
    this.cache.set(cacheKey, promise);
    try { return await promise; } catch (error) { this.cache.delete(cacheKey); throw error; }
  }

  async #buildUncached(query, route, hints, cacheKey) {
    const started = performance.now();
    memoryEvent(this.emit, { kind: "memory_router_decision", decision: route.decision, sourceCount: route.sources.length, reflectRequested: route.reflect });
    if (route.sources.length === 0) return deepFreeze({ version: 1, id: cacheKey, route, items: [], text: "", metadata: { status: "SKIPPED", candidateCount: 0, itemCount: 0, packChars: 0, approximateTokens: 0, backendCalls: { ...this.backendCalls }, degradationCount: 0, latencyMs: Math.round(performance.now() - started) } });
    const operations = [];
    const ledgerTypes = new Set();
    if (route.sources.includes("openviking")) ledgerTypes.add("fact").add("decision").add("resource");
    if (route.sources.includes("hindsight")) ledgerTypes.add("event").add("decision").add("failed_strategy");
    if (ledgerTypes.size && this.ledger) {
      this.backendCalls.ledger += 1;
      operations.push(Promise.resolve().then(() => ({ backend: "ledger", status: "OK", items: this.ledger.search(query, { project: this.projectId, limit: this.policy.candidateLimit, historical: route.sources.includes("hindsight"), types: [...ledgerTypes] }).map((entry) => toPackItem(entry)), candidateCount: 0 })).catch(() => ({ backend: "ledger", status: "DEGRADED", items: [], candidateCount: 0, reason: "unavailable" })));
    }
    if (route.sources.includes("openviking") && this.openViking) {
      this.backendCalls.openviking += 1;
      operations.push(this.openViking.retrieve({ query, level: hints.selectedUri ? Math.min(2, hints.detailLevel ?? 0) : 0, selectedUri: hints.selectedUri, limit: this.policy.candidateLimit }));
    }
    if (route.sources.includes("hindsight") && this.hindsight && this.policy.hindsight.recall) {
      this.backendCalls.hindsight += 1;
      const budget = this.policy.effectiveQuality === "low" ? "low" : this.policy.effectiveQuality === "medium" ? "mid" : "high";
      operations.push(this.hindsight.recall({ bankId: this.hindsightBankId, query, budget, maxTokens: this.policy.approximateTokenLimit, tags: [`project:${this.projectId}`] }));
      if (route.reflect && hints.reflectExplicit === true && (this.policy.hindsight.reflect || this.policy.hindsight.reflectExceptional)) {
        this.backendCalls.hindsight += 1;
        operations.push(this.hindsight.reflect({ bankId: this.hindsightBankId, query, budget, maxTokens: this.policy.approximateTokenLimit, explicitlyAuthorized: true }));
      }
    }
    if (route.sources.includes("ace") && this.ace && this.policy.ace.enabled) {
      this.backendCalls.ace += 1;
      operations.push(Promise.resolve().then(() => ({ backend: "ace", status: "OK", items: this.ace.compact(query, { project: this.projectId, limit: this.policy.ace.maxEntries }), candidateCount: 0 })).catch(() => ({ backend: "ace", status: "DEGRADED", items: [], candidateCount: 0, reason: "unavailable" })));
    }
    const results = await Promise.all(operations);
    for (const result of results) {
      memoryEvent(this.emit, {
        kind: "memory_backend_result",
        backend: result.backend,
        operation: result.operation,
        status: result.status,
        retrievalLevel: Number.isInteger(result.level) ? result.level : undefined,
        retrievedCandidateCount: Number(result.candidateCount ?? 0),
        retrievedItemCount: Array.isArray(result.items) ? result.items.length : 0,
        latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : undefined,
      });
    }
    const candidates = results.flatMap((result) => result.items ?? []);
    const selected = fit(dedupeRank(candidates), this.policy.packCharLimit);
    const text = selected.length ? renderUntrustedMemoryData(selected) : "";
    const degradationCount = results.filter((result) => result.status === "DEGRADED").length + route.sources.filter((source) => !results.some((result) => result.backend === source)).length;
    const metadata = {
      status: degradationCount === 0 ? "OK" : selected.length ? "PARTIAL" : "DEGRADED",
      candidateCount: candidates.length,
      itemCount: selected.length,
      packChars: text.length,
      approximateTokens: Math.ceil(text.length / 4),
      backendCalls: { ...this.backendCalls },
      degradationCount,
      latencyMs: Math.round(performance.now() - started),
      levels: [...new Set(selected.map((item) => item.level))].sort(),
    };
    memoryEvent(this.emit, { kind: "shared_memory_pack", decision: route.decision, retrievedCandidateCount: metadata.candidateCount, retrievedItemCount: metadata.itemCount, packChars: metadata.packChars, approximateTokens: metadata.approximateTokens, degradationCount, latencyMs: metadata.latencyMs, hindsightRecallUsed: results.some((result) => result.backend === "hindsight" && result.operation === "recall" && result.status === "OK"), hindsightReflectUsed: results.some((result) => result.backend === "hindsight" && result.operation === "reflect" && result.status === "OK"), aceEntriesUsed: selected.filter((item) => item.backend === "ace").length });
    const id = createHash("sha256").update(`${cacheKey}\0${text}`).digest("hex");
    return deepFreeze({ version: 1, id, route, items: selected, text, metadata });
  }

  async targeted(query, { source, selectedUri, detailLevel = 1, reflectExplicit = false } = {}) {
    if (source === "openviking" && selectedUri && this.openViking) {
      if (![1, 2].includes(detailLevel)) throw new Error("targeted_openviking_level_invalid");
      if (detailLevel === 1 && !this.policy.openViking.l1) throw new Error("targeted_openviking_l1_suppressed");
      if (detailLevel === 2 && !this.policy.openViking.selectedL2) throw new Error("targeted_openviking_l2_suppressed");
      return this.openViking.retrieve({ query, level: detailLevel, selectedUri, limit: 1 });
    }
    if (source === "hindsight" && reflectExplicit && this.hindsight) {
      if (!this.policy.hindsight.reflect && !this.policy.hindsight.reflectExceptional) {
        return { backend: "hindsight", operation: "reflect", status: "SUPPRESSED", items: [], candidateCount: 0, reason: "memory_policy_suppressed" };
      }
      return this.hindsight.reflect({ bankId: this.hindsightBankId, query, explicitlyAuthorized: true, maxTokens: this.policy.approximateTokenLimit });
    }
    throw new Error("targeted_memory_request_invalid");
  }
}

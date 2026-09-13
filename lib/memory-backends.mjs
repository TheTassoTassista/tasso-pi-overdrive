import { performance } from "node:perf_hooks";
import { canonicalMemoryText, escapeMemoryData, memoryDigest, redactSensitiveText, safeMemoryId } from "./memory-security.mjs";

async function fetchJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function headers(apiKey) {
  return { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}), "user-agent": "tasso-pi-overdrive-second-brain/1" };
}

function memoryItem(backend, raw, level) {
  const content = raw.abstract ?? raw.text ?? raw.content ?? raw.overview;
  if (typeof content !== "string" || !content.trim()) return undefined;
  const source = raw.uri ?? raw.document_id ?? raw.documentId ?? `${backend}:result`;
  return Object.freeze({
    id: safeMemoryId(`${backend}:${memoryDigest(`${source}:${content}`).slice(0, 24)}`),
    type: backend === "hindsight" ? "event" : "resource",
    project: raw.project,
    content: escapeMemoryData(content),
    source: escapeMemoryData(source, 600),
    sourceType: backend,
    trustLevel: backend === "openviking" ? "PROJECT_DOC" : "INFERRED",
    confidence: Number.isFinite(raw.score) ? Math.max(0, Math.min(1, raw.score)) : 0.5,
    verified: false,
    current: true,
    level,
    backend,
    score: Number.isFinite(raw.score) ? raw.score : 0,
  });
}

export class OpenVikingAdapter {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiKey = options.apiKey ?? process.env.OPENVIKING_API_KEY;
  }

  async health() {
    const started = performance.now();
    try {
      await fetchJson(this.fetch, `${this.config.endpoint}/health`, { method: "GET", headers: headers(this.apiKey) }, this.config.timeoutMs);
      return { backend: "openviking", available: true, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { backend: "openviking", available: false, latencyMs: Math.round(performance.now() - started), reason: error?.name === "AbortError" ? "timeout" : "unavailable" };
    }
  }

  async retrieve({ query, level = 0, selectedUri, limit = this.config.candidateLimit, targetUri = this.config.targetUri } = {}) {
    const started = performance.now();
    try {
      if (![0, 1, 2].includes(level)) throw new Error("openviking_level_invalid");
      if (level === 2 && !selectedUri) throw new Error("openviking_l2_requires_exact_uri");
      if (level > 0 && selectedUri) {
        if (!String(selectedUri).startsWith("viking://")) throw new Error("openviking_uri_invalid");
        const operation = level === 1 ? "overview" : "read";
        const raw = await fetchJson(this.fetch, `${this.config.endpoint}/api/v1/content/${operation}?uri=${encodeURIComponent(selectedUri)}`, { method: "GET", headers: headers(this.apiKey) }, this.config.timeoutMs);
        const content = raw?.result?.content ?? raw?.result ?? raw?.content;
        const item = memoryItem("openviking", { uri: selectedUri, content }, level);
        return { backend: "openviking", status: "OK", level, items: item ? [item] : [], candidateCount: item ? 1 : 0, latencyMs: Math.round(performance.now() - started) };
      }
      const raw = await fetchJson(this.fetch, `${this.config.endpoint}/api/v1/search/find`, { method: "POST", headers: headers(this.apiKey), body: JSON.stringify({ query: canonicalMemoryText(redactSensitiveText(query), 2000), target_uri: targetUri, context_type: ["memory", "resource"], limit: Math.max(1, Math.min(64, limit)) }) }, this.config.timeoutMs);
      const result = raw?.result ?? raw;
      const candidates = [...(Array.isArray(result?.resources) ? result.resources : []), ...(Array.isArray(result?.memories) ? result.memories : [])];
      const items = candidates.map((entry) => memoryItem("openviking", entry, 0)).filter(Boolean);
      return { backend: "openviking", status: "OK", level: 0, items, candidateCount: candidates.length, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { backend: "openviking", status: "DEGRADED", level, items: [], candidateCount: 0, latencyMs: Math.round(performance.now() - started), reason: error?.name === "AbortError" ? "timeout" : "unavailable" };
    }
  }

  async publishResource({ uri, content, l0, l1, tags = [] } = {}) {
    const started = performance.now();
    try {
      const target = String(uri ?? "");
      if (!/^viking:\/\/~\/resources\/[A-Za-z0-9][A-Za-z0-9._/-]{0,399}$/u.test(target) || target.split("/").includes("..") || target.endsWith("/")) throw new Error("openviking_publish_uri_invalid");
      const original = canonicalMemoryText(content, 64_000);
      const abstract = canonicalMemoryText(l0, 256);
      const overview = canonicalMemoryText(l1, 1400);
      if ([original, abstract, overview].some((value) => value.includes("[REDACTED]") || redactSensitiveText(value) !== value)) throw new Error("memory_secret_rejected");
      const timeout = this.config.writeTimeoutMs ?? 60_000;
      const write = (body) => fetchJson(this.fetch, `${this.config.endpoint}/api/v1/content/write`, { method: "POST", headers: headers(this.apiKey), body: JSON.stringify(body) }, timeout);
      await write({ uri: target, content: original, mode: "replace", wait: true, timeout: Math.ceil(timeout / 1000), processing_mode: "semantic_and_vectors", tags });
      const directory = target.slice(0, target.lastIndexOf("/"));
      await write({ uri: `${directory}/.abstract.md`, content: abstract, mode: "replace", wait: true, timeout: Math.ceil(timeout / 1000), processing_mode: "vectors_only", tags });
      await write({ uri: `${directory}/.overview.md`, content: overview, mode: "replace", wait: true, timeout: Math.ceil(timeout / 1000), processing_mode: "vectors_only", tags });
      return { backend: "openviking", operation: "publish", status: "OK", uri: target, writes: 3, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { backend: "openviking", operation: "publish", status: "DEGRADED", writes: 0, latencyMs: Math.round(performance.now() - started), reason: error?.name === "AbortError" ? "timeout" : (error?.message === "memory_secret_rejected" ? "secret_rejected" : "unavailable") };
    }
  }
}

export class HindsightAdapter {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiKey = options.apiKey ?? process.env.HINDSIGHT_API_KEY;
  }

  async health() {
    const started = performance.now();
    try {
      await fetchJson(this.fetch, `${this.config.endpoint}/health`, { method: "GET", headers: headers(this.apiKey) }, this.config.timeoutMs);
      return { backend: "hindsight", available: true, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { backend: "hindsight", available: false, latencyMs: Math.round(performance.now() - started), reason: error?.name === "AbortError" ? "timeout" : "unavailable" };
    }
  }

  async recall({ bankId, query, budget = "low", maxTokens = 700, tags = [] } = {}) {
    const started = performance.now();
    try {
      const bank = safeMemoryId(bankId, "hindsight_bank");
      const body = { query: canonicalMemoryText(redactSensitiveText(query), 2000), budget, max_tokens: Math.max(100, Math.min(4096, maxTokens)), ...(tags.length ? { tags, tags_match: "all_strict" } : {}) };
      const raw = await fetchJson(this.fetch, `${this.config.endpoint}/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, { method: "POST", headers: headers(this.apiKey), body: JSON.stringify(body) }, this.config.timeoutMs);
      const candidates = Array.isArray(raw?.results) ? raw.results : [];
      return { backend: "hindsight", operation: "recall", status: "OK", items: candidates.map((entry) => memoryItem("hindsight", entry, 1)).filter(Boolean), candidateCount: candidates.length, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { backend: "hindsight", operation: "recall", status: "DEGRADED", items: [], candidateCount: 0, latencyMs: Math.round(performance.now() - started), reason: error?.name === "AbortError" ? "timeout" : "unavailable" };
    }
  }

  async retain({ bankId, items = [] } = {}) {
    const started = performance.now();
    try {
      const bank = safeMemoryId(bankId, "hindsight_bank");
      if (!Array.isArray(items) || items.length < 1 || items.length > 64) throw new Error("hindsight_items_invalid");
      const safeItems = items.map((item) => {
        const content = canonicalMemoryText(item.content, 16_000);
        if (redactSensitiveText(content) !== content) throw new Error("memory_secret_rejected");
        return {
          content,
          ...(item.context ? { context: canonicalMemoryText(item.context, 1000) } : {}),
          ...(item.timestamp ? { timestamp: new Date(item.timestamp).toISOString() } : {}),
          ...(item.documentId ? { document_id: safeMemoryId(item.documentId, "hindsight_document_id") } : {}),
          ...(Array.isArray(item.tags) && item.tags.length ? { tags: item.tags.map((tag) => safeMemoryId(tag, "hindsight_tag")) } : {}),
        };
      });
      const raw = await fetchJson(this.fetch, `${this.config.endpoint}/v1/default/banks/${encodeURIComponent(bank)}/memories`, { method: "POST", headers: headers(this.apiKey), body: JSON.stringify({ items: safeItems, async: false }) }, this.config.writeTimeoutMs ?? 60_000);
      return { backend: "hindsight", operation: "retain", status: "OK", retained: Number(raw?.items_count ?? raw?.count ?? safeItems.length), latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { backend: "hindsight", operation: "retain", status: "DEGRADED", retained: 0, latencyMs: Math.round(performance.now() - started), reason: error?.name === "AbortError" ? "timeout" : (error?.message === "memory_secret_rejected" ? "secret_rejected" : "unavailable") };
    }
  }

  async reflect({ bankId, query, budget = "low", maxTokens = 900, explicitlyAuthorized = false } = {}) {
    if (!explicitlyAuthorized || this.config.reflect !== "explicit-only") return { backend: "hindsight", operation: "reflect", status: "SUPPRESSED", items: [], candidateCount: 0, reason: "explicit_authorization_required" };
    const started = performance.now();
    try {
      const bank = safeMemoryId(bankId, "hindsight_bank");
      const raw = await fetchJson(this.fetch, `${this.config.endpoint}/v1/default/banks/${encodeURIComponent(bank)}/reflect`, { method: "POST", headers: headers(this.apiKey), body: JSON.stringify({ query: canonicalMemoryText(redactSensitiveText(query), 2000), budget, max_tokens: Math.max(100, Math.min(4096, maxTokens)), include: { facts: true, tool_calls: false } }) }, this.config.timeoutMs);
      const content = raw?.text ?? raw?.answer ?? raw?.result;
      const item = typeof content === "string" ? memoryItem("hindsight", { text: content, document_id: `${bank}:reflect` }, 1) : undefined;
      return { backend: "hindsight", operation: "reflect", status: "OK", items: item ? [item] : [], candidateCount: item ? 1 : 0, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { backend: "hindsight", operation: "reflect", status: "DEGRADED", items: [], candidateCount: 0, latencyMs: Math.round(performance.now() - started), reason: error?.name === "AbortError" ? "timeout" : "unavailable" };
    }
  }
}

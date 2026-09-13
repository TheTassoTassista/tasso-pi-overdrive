import path from "node:path";
import { AcePlaybook } from "./ace-playbook.mjs";
import { HindsightAdapter, OpenVikingAdapter } from "./memory-backends.mjs";
import { MemoryEnrichmentCache } from "./memory-enrichment-cache.mjs";
import { deriveProjectIdentity, readSecondBrainConfig } from "./memory-config.mjs";
import { MemoryLedger } from "./memory-ledger.mjs";
import { resolveMemoryPolicy } from "./memory-policy.mjs";
import { routeMemoryEnrichment } from "./memory-model-router.mjs";
import { safeMemoryId } from "./memory-security.mjs";
import { SharedMemoryPackController } from "./shared-memory-pack.mjs";

/**
 * @param {{cwd: string, preset?: string, qualityRequested?: string, effectiveQuality?: string, config?: any, fetch?: typeof globalThis.fetch, emit?: (value: object) => void, clock?: () => Date}} options
 */
export function createSecondBrainRuntime({ cwd, preset = "normal", qualityRequested = "auto", effectiveQuality, config, fetch, emit, clock }) {
  const resolvedConfig = config ?? readSecondBrainConfig();
  const projectId = deriveProjectIdentity(cwd);
  const policy = resolveMemoryPolicy({ preset, qualityRequested, effectiveQuality });
  const ledger = new MemoryLedger(path.join(resolvedConfig.root, "ledger"), { clock });
  const ace = new AcePlaybook(path.join(resolvedConfig.root, "ace"), { maxEntries: resolvedConfig.ace.maxEntries, clock });
  const openViking = resolvedConfig.openViking.mode === "disabled" ? undefined : new OpenVikingAdapter(resolvedConfig.openViking, { fetch });
  const hindsight = resolvedConfig.hindsight.mode === "disabled" ? undefined : new HindsightAdapter(resolvedConfig.hindsight, { fetch });
  const enrichment = new MemoryEnrichmentCache(path.join(resolvedConfig.root, "enrichment"), { clock, emit });
  const hindsightBankId = safeMemoryId(`${resolvedConfig.hindsight.bankPrefix}-${projectId}`, "hindsight_bank");
  const controller = new SharedMemoryPackController({ projectId, hindsightBankId, policy, ledger, ace, openViking, hindsight, emit });
  const publishDurable = async (entry) => {
    const route = routeMemoryEnrichment({ localAvailable: true });
    if (route.tier !== "LOCAL") return { status: "DEGRADED", openviking: "SKIPPED", hindsight: "SKIPPED" };
    const cached = enrichment.put({ sourceId: entry.id, content: entry.content });
    let current = cached.entry;
    let openvikingResult = { status: "SKIPPED" };
    let hindsightResult = { status: "SKIPPED" };
    if (openViking && enrichment.needsPublication(current, "openviking")) {
      openvikingResult = await openViking.publishResource({ uri: `viking://~/resources/${projectId}/${entry.id}/content.md`, content: entry.content, l0: current.l0, l1: current.l1, tags: [`project=${projectId}`, `memory=${entry.id}`] });
      if (openvikingResult.status === "OK") current = enrichment.markPublished(entry.id, current.sourceHash, "openviking");
    }
    if (hindsight && enrichment.needsPublication(current, "hindsight")) {
      hindsightResult = await hindsight.retain({ bankId: hindsightBankId, items: [{ content: entry.content, context: entry.reason, timestamp: entry.updatedAt, documentId: entry.id, tags: [`project:${projectId}`, `type:${entry.type}`] }] });
      if (hindsightResult.status === "OK") current = enrichment.markPublished(entry.id, current.sourceHash, "hindsight");
    }
    const status = [openvikingResult.status, hindsightResult.status].every((value) => ["OK", "SKIPPED"].includes(value)) ? "OK" : "PARTIAL";
    try { emit?.({ kind: "memory_projection", status, openvikingStatus: openvikingResult.status, hindsightStatus: hindsightResult.status, sourceIdHash: current.sourceHash, remoteCalls: 0 }); } catch {}
    return { status, openviking: openvikingResult.status, hindsight: hindsightResult.status };
  };
  return Object.freeze({ config: resolvedConfig, projectId, policy, ledger, ace, enrichment, openViking, hindsight, controller, publishDurable });
}

export async function secondBrainHealth(runtime) {
  const safe = async (backend, operation) => {
    if (!operation) return { backend, available: false, reason: "disabled" };
    try { return await operation.health(); } catch { return { backend, available: false, reason: "unavailable" }; }
  };
  const [openViking, hindsight] = await Promise.all([safe("openviking", runtime.openViking), safe("hindsight", runtime.hindsight)]);
  let ledger;
  let ace;
  try { ledger = { available: true, ...runtime.ledger.stats(runtime.projectId) }; } catch { ledger = { available: false, total: 0, current: 0, superseded: 0, expired: 0 }; }
  try { ace = { available: true, ...runtime.ace.stats(runtime.projectId) }; } catch { ace = { available: false, total: 0, verified: 0, failedStrategies: 0 }; }
  const available = [openViking.available, hindsight.available, ledger.available, ace.available].filter(Boolean).length;
  return { enabled: runtime.config.enabled, projectId: runtime.projectId, openViking, hindsight, ledger, ace, status: available === 4 ? "OK" : available > 0 ? "DEGRADED" : "UNAVAILABLE", policy: runtime.policy };
}

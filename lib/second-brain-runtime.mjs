import path from "node:path";
import { AcePlaybook } from "./ace-playbook.mjs";
import { HindsightAdapter, OpenVikingAdapter } from "./memory-backends.mjs";
import { deriveProjectIdentity, readSecondBrainConfig } from "./memory-config.mjs";
import { MemoryLedger } from "./memory-ledger.mjs";
import { resolveMemoryPolicy } from "./memory-policy.mjs";
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
  const hindsightBankId = safeMemoryId(`${resolvedConfig.hindsight.bankPrefix}-${projectId}`, "hindsight_bank");
  const controller = new SharedMemoryPackController({ projectId, hindsightBankId, policy, ledger, ace, openViking, hindsight, emit });
  return Object.freeze({ config: resolvedConfig, projectId, policy, ledger, ace, openViking, hindsight, controller });
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

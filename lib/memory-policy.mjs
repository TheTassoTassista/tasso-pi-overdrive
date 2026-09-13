const PRESETS = Object.freeze(["normal", "token-saver"]);
const QUALITIES = Object.freeze(["low", "medium", "high", "max"]);

const PACK_LIMITS = Object.freeze({
  normal: Object.freeze({ low: 1400, medium: 2600, high: 4200, max: 5600 }),
  "token-saver": Object.freeze({ low: 900, medium: 1400, high: 2200, max: 3000 }),
});

const CANDIDATES = Object.freeze({
  normal: Object.freeze({ low: 12, medium: 20, high: 32, max: 44 }),
  "token-saver": Object.freeze({ low: 24, medium: 32, high: 44, max: 56 }),
});

/** @param {{preset?: string, qualityRequested?: string, effectiveQuality?: string}} [options] */
export function resolveMemoryPolicy({ preset = "normal", qualityRequested = "auto", effectiveQuality } = {}) {
  const concretePreset = preset === "custom" ? "normal" : preset;
  if (!PRESETS.includes(concretePreset)) throw new Error("memory_policy_preset_invalid");
  const quality = effectiveQuality ?? (qualityRequested === "auto" ? "medium" : qualityRequested);
  if (!QUALITIES.includes(quality)) throw new Error("memory_policy_quality_invalid");
  const saver = concretePreset === "token-saver";
  return Object.freeze({
    version: 1,
    preset: concretePreset,
    qualityRequested,
    effectiveQuality: quality,
    localSearch: "aggressive",
    candidateLimit: CANDIDATES[concretePreset][quality],
    packCharLimit: PACK_LIMITS[concretePreset][quality],
    approximateTokenLimit: Math.ceil(PACK_LIMITS[concretePreset][quality] / 4),
    openViking: Object.freeze({ l0: true, l1: true, selectedL2: true, broadL2: false }),
    hindsight: Object.freeze({ recall: true, reflect: ["high", "max"].includes(quality) && !saver, reflectExceptional: saver && ["high", "max"].includes(quality) }),
    ace: Object.freeze({ enabled: true, maxEntries: saver ? 3 : quality === "low" ? 2 : quality === "medium" ? 4 : 6 }),
    stopWhenEnough: true,
  });
}

export function memoryPolicyTopology(policy) {
  return {
    currentContextCheck: true,
    router: "deterministic",
    openViking: "L0 → L1 → selected L2",
    hindsight: `Recall; Reflect ${policy.hindsight.reflect ? "conditional" : "suppressed by default"}`,
    ace: "incremental curated playbook",
    sharedMemoryPack: `bounded ${policy.packCharLimit} chars`,
    curator: "provenance/trust/dedupe/superseding/retention",
    tokenGovernor: `${policy.preset}/${policy.effectiveQuality}`,
  };
}

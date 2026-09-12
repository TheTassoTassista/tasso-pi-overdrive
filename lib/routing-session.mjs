export const QUALITY_LEVELS = Object.freeze(["auto", "low", "medium", "high", "max"]);

export function parseQuality(value) {
  const quality = String(value ?? "").trim().toLowerCase();
  if (!QUALITY_LEVELS.includes(quality)) throw new Error("unknown_quality_level");
  return quality;
}

export function createSessionQualityState() {
  let quality = "auto";
  return Object.freeze({
    get: () => quality,
    set: (value) => { quality = parseQuality(value); return quality; },
    reset: () => { quality = "auto"; return quality; },
  });
}

const currentSession = createSessionQualityState();

export function getSessionQuality() { return currentSession.get(); }
export function setSessionQuality(value) { return currentSession.set(value); }
export function resetSessionQuality() { return currentSession.reset(); }

const HISTORY = /\b(?:before|previous(?:ly)?|history|historical|earlier|last time|used to|why (?:did|was|were)|when did|what happened|decision evolution|superseded|failed approach|già|prima|precedent|stor(?:ia|ico)|perché|quando)\b/iu;
const STRATEGY = /\b(?:strategy|playbook|best practice|workflow|how (?:should|do) (?:we|i)|lesson|heuristic|known trap|avoid repeating|debugging approach|strategia|lezione|procedura|buona pratica)\b/iu;
const PROJECT = /\b(?:project|repository|repo|architecture|codebase|source|documentation|config|module|file|class|function|api|test|build|dependency|bug|fix|implement|refactor|compile|deploy|release|progetto|codice|architettura|documentazione|errore|correggi|implementa)\b/iu;
const REFLECT = /\b(?:synthesize|across (?:many|multiple)|root pattern|recurring pattern|why .* repeatedly|compare .* history|evolution.*why|sintetizza|schema ricorrente)\b/iu;
const EXACT_EDIT = /\b(?:change|replace|rename|edit|update|delete|remove|aggiungi|modifica|sostituisci)\b[\s\S]{0,120}(?:[\w./-]+\.[a-z0-9]+|line \d+|riga \d+)/iu;

export function inferCurrentContextSufficient(query, hints = {}) {
  if (hints.currentContextSufficient === true) return true;
  if (hints.currentContextSufficient === false) return false;
  return EXACT_EDIT.test(query) && !HISTORY.test(query) && !STRATEGY.test(query);
}

export function routeMemoryQuery(query, hints = {}) {
  const text = String(query ?? "").trim();
  if (!text) throw new Error("memory_query_required");
  if (inferCurrentContextSufficient(text, hints)) return Object.freeze({ decision: "NONE", sources: Object.freeze([]), reflect: false, reasons: Object.freeze(["current-context-sufficient"]), deterministic: true });
  const sources = [];
  const reasons = [];
  const historical = hints.history === true || HISTORY.test(text);
  const strategic = hints.strategy === true || STRATEGY.test(text);
  const project = hints.project === true || PROJECT.test(text);
  if (project) { sources.push("openviking"); reasons.push("project-context"); }
  if (historical) { sources.push("hindsight"); reasons.push("temporal-intent"); }
  if (strategic) { sources.push("ace"); reasons.push("experience-intent"); }
  const reflect = historical && (hints.reflect === true || REFLECT.test(text));
  if (reflect) reasons.push("historical-synthesis-requested");
  if (sources.length === 0) reasons.push("no-memory-intent");
  return Object.freeze({ decision: sources.length === 0 ? "NONE" : sources.length === 1 ? sources[0].toUpperCase() : "MIXED", sources: Object.freeze(sources), reflect, reasons: Object.freeze(reasons), deterministic: true });
}

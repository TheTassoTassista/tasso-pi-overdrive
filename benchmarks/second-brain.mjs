#!/usr/bin/env node
import { SharedMemoryPackController } from "../lib/shared-memory-pack.mjs";
import { resolveMemoryPolicy } from "../lib/memory-policy.mjs";

const scenarios = [
  { name: "current-architecture", query: "project architecture modules", files: 18, fixtureChars: 48200, items: ["Router selects only relevant memory backends.", "Shared packs are bounded and reused.", "OpenViking loads L0 before targeted detail."] },
  { name: "historical-decision", query: "why did the architecture change before", files: 24, fixtureChars: 67100, items: ["Historical decisions remain available after superseding.", "Current verified facts outrank older inferred facts.", "Hindsight Recall is conditional."] },
  { name: "reusable-workflow", query: "best practice workflow strategy", files: 12, fixtureChars: 31900, items: ["Run deterministic checks before model review.", "Use pinned runtimes instead of ambient PATH.", "Record failed strategies with their conditions."] },
];

function sourceFixture(count, totalChars, seed) {
  const documents = [];
  let remaining = totalChars;
  for (let index = 0; index < count; index += 1) {
    const length = index === count - 1 ? remaining : Math.floor(remaining / (count - index));
    const prefix = `${seed} source ${index}: `;
    documents.push(`${prefix}${"x".repeat(Math.max(0, length - prefix.length))}`.slice(0, length));
    remaining -= length;
  }
  return documents;
}

const results = [];
for (const scenario of scenarios) {
  const naiveSources = sourceFixture(scenario.files, scenario.fixtureChars, scenario.name);
  const naiveChars = naiveSources.reduce((total, sourceText) => total + sourceText.length, 0);
  const backend = scenario.name === "reusable-workflow" ? "ace" : scenario.name === "historical-decision" ? "hindsight" : "openviking";
  const source = {
    async retrieve() { return { backend, status: "OK", operation: backend === "hindsight" ? "recall" : undefined, candidateCount: scenario.items.length, items: scenario.items.map((content, index) => ({ id: `${backend}-${index}`, type: backend === "hindsight" ? "event" : backend === "ace" ? "lesson" : "resource", project: "pi-overdrive", content, source: `${backend}:fixture-${index}`, trustLevel: index === 0 ? "VERIFIED" : "PROJECT_DOC", confidence: 0.9, verified: index === 0, current: true, level: 0, backend, score: scenario.items.length - index })) }; },
    async recall() { return this.retrieve(); },
    compact() { return scenario.items.map((content, index) => ({ id: `ace-${index}`, type: "lesson", project: "pi-overdrive", content, source: `ace:fixture-${index}`, trustLevel: "VERIFIED", confidence: 1, verified: true, current: true, level: 0, backend: "ace", score: scenario.items.length - index })); },
  };
  const controller = new SharedMemoryPackController({ projectId: "pi-overdrive", policy: resolveMemoryPolicy({ preset: "token-saver", qualityRequested: "medium" }), ...(backend === "openviking" ? { openViking: source } : backend === "hindsight" ? { hindsight: source } : { ace: source }) });
  const pack = await controller.build(scenario.query, { currentContextSufficient: false });
  const reduction = naiveChars === 0 ? null : Number((((naiveChars - pack.text.length) / naiveChars) * 100).toFixed(2));
  results.push({ scenario: scenario.name, candidateSourceFiles: naiveSources.length, candidateSourceChars: naiveChars, retrievedCandidateCount: pack.metadata.candidateCount, finalPackChars: pack.text.length, estimatedNaiveTokens: Math.ceil(naiveChars / 4), estimatedPackTokens: Math.ceil(pack.text.length / 4), reductionPercent: reduction, measurement: "FIXTURE FILE COUNT/CHARACTERS EXACT; TOKENS ESTIMATED AT 4 CHARS PER TOKEN" });
}
const status = results.every((entry) => entry.finalPackChars > 0 && entry.finalPackChars < entry.candidateSourceChars && entry.reductionPercent > 80) ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, modelCalls: 0, methodology: "Deterministically generated source fixtures; file counts and character counts are measured exactly. Token figures are explicitly estimated, not tokenizer output.", results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeLspOverlay } from "./lsp-manager.mjs";

export const LSP_WRITE_GUARD_VERSION = 1;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyFile = path.join(packageRoot, "config", "lsp-write-guard.json");
const CONTRACTS = new Set(["hash-replace-v1", "ast-grep-v1"]);

export class LspWriteGuardError extends Error {
  constructor(code, classification) { super(code); this.name = "LspWriteGuardError"; this.code = code; this.classification = classification; }
}

function fail(code, classification) { throw new LspWriteGuardError(code, classification); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

export function validateLspWriteGuardPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== LSP_WRITE_GUARD_VERSION) fail("LSP_WRITE_POLICY_INVALID");
  const keys = ["version", "enabled", "blockingSeverities", "maxDiagnostics", "requirePostMatch", "unsupportedLanguageAction", "managedServerUnavailableAction", "runtimeFailureAction"];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("LSP_WRITE_POLICY_UNKNOWN_FIELD");
  if (typeof value.enabled !== "boolean" || typeof value.requirePostMatch !== "boolean") fail("LSP_WRITE_POLICY_INVALID");
  if (!Array.isArray(value.blockingSeverities) || value.blockingSeverities.length < 1 || value.blockingSeverities.some((entry) => !["Error", "Warning"].includes(entry)) || new Set(value.blockingSeverities).size !== value.blockingSeverities.length) fail("LSP_WRITE_SEVERITY_INVALID");
  for (const key of ["unsupportedLanguageAction", "managedServerUnavailableAction", "runtimeFailureAction"]) if (!["SKIP", "BLOCK"].includes(value[key])) fail("LSP_WRITE_UNAVAILABLE_ACTION_INVALID");
  return Object.freeze({
    version: value.version,
    enabled: value.enabled,
    blockingSeverities: Object.freeze([...value.blockingSeverities]),
    maxDiagnostics: integer(value.maxDiagnostics, 1, 2000, "LSP_WRITE_DIAGNOSTIC_LIMIT_INVALID"),
    requirePostMatch: value.requirePostMatch,
    unsupportedLanguageAction: value.unsupportedLanguageAction,
    managedServerUnavailableAction: value.managedServerUnavailableAction,
    runtimeFailureAction: value.runtimeFailureAction,
  });
}

export function readLspWriteGuardPolicy(file = policyFile) {
  try { return validateLspWriteGuardPolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) { if (error instanceof LspWriteGuardError) throw error; fail("LSP_WRITE_POLICY_UNREADABLE"); }
}

function diagnosticKey(entry) {
  return JSON.stringify([entry.path ?? "", entry.severity ?? "", entry.source ?? "", String(entry.code ?? ""), entry.message ?? ""]);
}

function location(value) {
  const line = Number.isSafeInteger(value?.line) && value.line > 0 ? value.line : 0;
  const character = Number.isSafeInteger(value?.character) && value.character > 0 ? value.character : 0;
  return { line, character };
}

function inspect(result, policy) {
  if (!result || typeof result !== "object") fail("LSP_WRITE_RESULT_INVALID");
  if (result.status !== "PASS") {
    const reason = String(result.error ?? "lsp_unavailable").slice(0, 120);
    const action = reason === "unsupported_language"
      ? policy.unsupportedLanguageAction
      : result.status === "PARTIAL"
        ? policy.managedServerUnavailableAction
        : policy.runtimeFailureAction;
    return Object.freeze({ status: action === "SKIP" ? "SKIPPED" : "FAIL", reason });
  }
  if (!Array.isArray(result.entries) || result.entries.length > policy.maxDiagnostics) fail("LSP_WRITE_DIAGNOSTIC_LIMIT_EXCEEDED");
  const normalized = result.entries.map((entry) => ({
    path: String(entry?.path ?? "").slice(0, 2048), severity: String(entry?.severity ?? "Unknown"), source: String(entry?.source ?? "").slice(0, 120),
    code: entry?.code ?? null, message: String(entry?.message ?? "").slice(0, 1000), start: location(entry?.start), end: location(entry?.end),
  })).sort((left, right) => `${diagnosticKey(left)}${JSON.stringify(left.start)}`.localeCompare(`${diagnosticKey(right)}${JSON.stringify(right.start)}`));
  const blocking = normalized.filter((entry) => policy.blockingSeverities.includes(entry.severity));
  return Object.freeze({
    status: "PASS", language: String(result.language ?? "unknown").slice(0, 32), backendDigest: hash(String(result.backend ?? "unknown")),
    projectDigest: hash(String(result.projectRoot ?? ".")),
    diagnosticCount: normalized.length, blockingCount: blocking.length, digest: hash(JSON.stringify(normalized)),
    blockingKeys: Object.freeze(blocking.map(diagnosticKey)),
  });
}

function newBlocking(candidate, baseline) {
  const existing = new Map();
  for (const key of baseline.blockingKeys) existing.set(key, (existing.get(key) ?? 0) + 1);
  return candidate.blockingKeys.filter((key) => {
    const count = existing.get(key) ?? 0;
    if (count < 1) return true;
    existing.set(key, count - 1);
    return false;
  });
}

function classification(candidate, baseline) {
  if (candidate.blockingCount < baseline.blockingCount) return "IMPROVED";
  return "UNCHANGED";
}

export class LspWriteGuard {
  constructor(options = {}) {
    if (!options.editEngine) fail("LSP_WRITE_ENGINE_INVALID");
    this.editEngine = options.editEngine;
    this.cwd = options.cwd ?? process.cwd();
    this.diagnostics = options.diagnostics ?? (async ({ path: source, content }) => executeLspOverlay(this.cwd, source, content));
    this.policy = validateLspWriteGuardPolicy(options.policy ?? readLspWriteGuardPolicy());
    this.proofs = new Map();
    this.stats = { previews: 0, guarded: 0, skipped: 0, blocked: 0, rolledBack: 0 };
  }

  async preview(input = {}) {
    if (!CONTRACTS.has(input.expectedContract)) fail("LSP_WRITE_CONTRACT_INVALID");
    const transaction = this.editEngine.adapterTransaction(input.transactionId, input.expectedContract);
    if (!this.policy.enabled) {
      const skipped = Object.freeze({ kind: "LSP_WRITE_PREFLIGHT", status: "SKIPPED", classification: "UNKNOWN_UNVERIFIABLE", reason: "disabled" });
      this.proofs.set(transaction.id, skipped);
      this.stats.skipped += 1;
      return skipped;
    }
    const baseline = await this.#inspect({ path: transaction.relative, content: transaction.beforeText, phase: "baseline" }, "LSP_WRITE_BASELINE_FAILED", transaction.id);
    if (baseline.status === "SKIPPED") {
      const skipped = Object.freeze({ kind: "LSP_WRITE_PREFLIGHT", status: "SKIPPED", classification: "UNKNOWN_UNVERIFIABLE", reason: baseline.reason });
      this.proofs.set(transaction.id, skipped);
      this.stats.skipped += 1;
      return skipped;
    }
    if (baseline.status !== "PASS") return this.#block(transaction.id, "LSP_WRITE_BASELINE_FAILED");
    const candidate = await this.#inspect({ path: transaction.relative, content: transaction.afterText, phase: "candidate" }, "LSP_WRITE_CANDIDATE_FAILED", transaction.id);
    if (candidate.status !== "PASS") return this.#block(transaction.id, "LSP_WRITE_CANDIDATE_FAILED");
    if (candidate.language !== baseline.language || candidate.backendDigest !== baseline.backendDigest || candidate.projectDigest !== baseline.projectDigest) return this.#block(transaction.id, "LSP_WRITE_BACKEND_CHANGED");
    if (newBlocking(candidate, baseline).length) return this.#block(transaction.id, "LSP_NEW_BLOCKING_DIAGNOSTIC", "REGRESSED");
    const proof = Object.freeze({
      kind: "LSP_WRITE_PREFLIGHT", status: "PASS", transactionId: transaction.id, contract: transaction.contract,
      classification: classification(candidate, baseline),
      beforeDigest: transaction.beforeDigest, afterDigest: transaction.afterDigest, language: candidate.language, backendDigest: candidate.backendDigest, projectDigest: candidate.projectDigest,
      baselineDiagnosticCount: baseline.diagnosticCount, baselineErrorCount: baseline.blockingCount, baselineDigest: baseline.digest,
      candidateDiagnosticCount: candidate.diagnosticCount, candidateErrorCount: candidate.blockingCount, candidateDigest: candidate.digest,
      candidateBlockingKeys: candidate.blockingKeys,
    });
    this.proofs.set(transaction.id, proof);
    this.stats.previews += 1;
    const { candidateBlockingKeys: _internal, ...publicProof } = proof;
    return Object.freeze(publicProof);
  }

  async #inspect(input, code, transactionId) {
    try { return inspect(await this.diagnostics(input), this.policy); }
    catch { return this.#block(transactionId, code); }
  }

  #block(transactionId, code, classification = "UNKNOWN_UNVERIFIABLE") {
    this.editEngine.discardTransaction(transactionId);
    this.proofs.delete(transactionId);
    this.stats.blocked += 1;
    fail(code, classification);
  }

  async apply(input = {}, adapter = this.editEngine) {
    if (!CONTRACTS.has(input.expectedContract)) fail("LSP_WRITE_CONTRACT_INVALID");
    if (!adapter || typeof adapter.apply !== "function" || typeof adapter.applyValidated !== "function") fail("LSP_WRITE_ENGINE_INVALID");
    const proof = this.proofs.get(input.transactionId);
    if (!proof) fail("LSP_WRITE_PROOF_MISSING");
    this.proofs.delete(input.transactionId);
    if (proof.status === "SKIPPED") return adapter.apply({ transactionId: input.transactionId, expectedContract: input.expectedContract });
    try {
      const applied = await adapter.applyValidated({ transactionId: input.transactionId, expectedContract: input.expectedContract }, async () => {
        let post;
        try { post = inspect(await this.diagnostics({ path: this.editEngine.adapterTransaction(input.transactionId, input.expectedContract).relative, phase: "post" }), this.policy); }
        catch { fail("LSP_WRITE_POST_FAILED"); }
        if (post.status !== "PASS") fail("LSP_WRITE_POST_FAILED");
        if (post.language !== proof.language || post.backendDigest !== proof.backendDigest || post.projectDigest !== proof.projectDigest) fail("LSP_WRITE_BACKEND_CHANGED");
        if (newBlocking(post, { blockingKeys: proof.candidateBlockingKeys }).length) fail("LSP_NEW_BLOCKING_DIAGNOSTIC", "REGRESSED");
        if (this.policy.requirePostMatch && post.digest !== proof.candidateDigest) fail("LSP_WRITE_POST_MISMATCH", "UNKNOWN_UNVERIFIABLE");
        return {
          kind: "LSP_WRITE_GUARD", status: "PASS", language: post.language,
          backendDigest: post.backendDigest, projectDigest: post.projectDigest,
          baselineErrorCount: proof.baselineErrorCount, candidateErrorCount: proof.candidateErrorCount, postErrorCount: post.blockingCount,
          baselineDigest: proof.baselineDigest, candidateDigest: proof.candidateDigest, postDigest: post.digest,
        };
      });
      this.stats.guarded += 1;
      return applied;
    } catch (error) {
      if (error instanceof LspWriteGuardError) { this.stats.blocked += 1; this.stats.rolledBack += 1; }
      throw error;
    }
  }

  status() { return Object.freeze({ version: LSP_WRITE_GUARD_VERSION, activeProofs: this.proofs.size, stats: { ...this.stats } }); }
}

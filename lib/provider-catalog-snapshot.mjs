import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CATALOG_SNAPSHOT_VERSION = 1;
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 1000;
const ID = /^[~A-Za-z0-9._:-]+(?:\/[~A-Za-z0-9._:-]+)+$/u;

export function classifyEvidenceFreshness(observedAt, now = Date.now(), maxAgeMs = CATALOG_MAX_AGE_MS) {
  const timestamp = typeof observedAt === "string" ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(timestamp) || !Number.isFinite(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || timestamp > now + 5 * 60 * 1000) return "UNKNOWN_AGE";
  return now - timestamp <= maxAgeMs ? "FRESH" : "STALE";
}

function positive(value) { return Number.isSafeInteger(value) && value >= 1024 && value <= 100_000_000 ? value : null; }
function finitePrice(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000 ? parsed : null;
}

/** Whitelist-only transform: descriptions, links, provider auth and raw prices never leave this boundary. */
export function normalizeOpenRouterCatalog(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.data) || raw.data.length > MAX_MODELS || classifyEvidenceFreshness(raw.fetchedAt, now) === "UNKNOWN_AGE") throw new Error("provider_catalog_invalid");
  const observedAt = new Date(raw.fetchedAt).toISOString();
  const seen = new Set();
  const models = raw.data.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string" || !ID.test(entry.id) || entry.id.split("/").some((segment) => segment === "." || segment === "..") || seen.has(entry.id)) throw new Error("provider_catalog_model_invalid");
    seen.add(entry.id);
    const parameters = Array.isArray(entry.supported_parameters) && entry.supported_parameters.every((item) => typeof item === "string") ? entry.supported_parameters : [];
    const input = Array.isArray(entry.architecture?.input_modalities) && entry.architecture.input_modalities.every((item) => typeof item === "string") ? entry.architecture.input_modalities : null;
    const pricing = entry.pricing?.currency === "USD" && entry.pricing?.unit === "PER_MILLION_TOKENS"
      ? { input: finitePrice(entry.pricing.prompt), output: finitePrice(entry.pricing.completion), currency: "USD", unit: "PER_MILLION_TOKENS" } : null;
    return Object.freeze({
      identity: `omniroute/openrouter/${entry.id}`,
      contextWindow: positive(entry.context_length),
      maxOutputTokens: positive(entry.top_provider?.max_completion_tokens),
      toolSupport: parameters.includes("tools") ? true : null,
      vision: input ? input.includes("image") : null,
      structuredOutput: parameters.includes("response_format") ? true : null,
      pricing: pricing?.input !== null && pricing?.output !== null ? pricing : null,
    });
  }).sort((left, right) => left.identity.localeCompare(right.identity));
  const body = { version: CATALOG_SNAPSHOT_VERSION, source: "omniroute-openrouter-cache", observedAt, models };
  return Object.freeze({ ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
}

export function localOpenRouterCatalogPath(environment = process.env) {
  return environment.PI_OVERDRIVE_OMNIROUTE_CATALOG_CACHE ?? path.join(environment.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "omniroute", "cache", "openrouter-catalog.json");
}

/** Optional local metadata only. No network, database, credentials or call-log access. */
export function readLocalOpenRouterCatalog(file = localOpenRouterCatalogPath()) {
  let descriptor;
  try {
    const requested = path.resolve(file);
    if (fs.realpathSync(requested) !== requested) throw new Error("provider_catalog_path_unsafe");
    descriptor = fs.openSync(requested, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > MAX_BYTES) throw new Error("provider_catalog_file_unsafe");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("provider_catalog_file_changed");
    return Object.freeze({ status: "AVAILABLE", snapshot: normalizeOpenRouterCatalog(JSON.parse(bytes.toString("utf8"))) });
  } catch (error) {
    return Object.freeze({ status: error?.code === "ENOENT" ? "UNAVAILABLE" : "INVALID", snapshot: null });
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

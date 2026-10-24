const PROVIDERS = Object.freeze(["brave", "perplexity"]);
const EXPLICIT_PROVIDERS = Object.freeze([...PROVIDERS, "searxng"]);
const ENV_KEYS = Object.freeze({ brave: "BRAVE_SEARCH_API_KEY", perplexity: "PERPLEXITY_API_KEY" });
const clamp = (value, minimum, maximum) => Math.min(Math.max(Number.isFinite(value) ? Math.trunc(value) : minimum, minimum), maximum);
const cleanText = (value, maximum) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").slice(0, maximum);

export function assertWebProvider(value) {
  if (!PROVIDERS.includes(value)) throw new Error(`Unsupported web provider: ${cleanText(value, 40)}. Allowed: brave, perplexity.`);
  return value;
}

function assertExplicitProvider(value) {
  if (!EXPLICIT_PROVIDERS.includes(value)) throw new Error(`Unsupported web provider: ${cleanText(value, 40)}. Allowed: brave, perplexity, searxng.`);
  return value;
}

export function resolveWebPolicy(config = {}, environment = {}) {
  const requestedByEnvironment = environment.WEB_SEARCH_PROVIDER?.trim();
  const configuredPrimary = config.overdriveRouting?.primaryProvider ?? config.provider ?? "brave";
  const primary = assertWebProvider(requestedByEnvironment || configuredPrimary);
  const configuredSecondary = config.overdriveRouting?.secondaryProvider ?? (primary === "brave" ? "perplexity" : "brave");
  const secondary = assertWebProvider(configuredSecondary);
  if (primary === secondary) throw new Error("Web primary and secondary providers must differ.");
  return {
    primary,
    secondary,
    automaticFallback: config.overdriveRouting?.automaticFallback !== false,
  };
}

export function resolveProviderCredential(provider, config = {}, environment = {}) {
  assertWebProvider(provider);
  const fromEnvironment = environment[ENV_KEYS[provider]]?.trim();
  if (fromEnvironment) return { value: fromEnvironment, source: "environment" };
  const fromProviderConfig = config.apiKeys?.[provider]?.trim();
  if (fromProviderConfig) return { value: fromProviderConfig, source: "user-config" };
  if (provider === "brave") {
    const legacy = config.apiKey?.trim();
    if (legacy) return { value: legacy, source: "legacy-user-config" };
  }
  return { value: undefined, source: "missing" };
}

export function webCredentialStatus(config = {}, environment = {}) {
  return Object.fromEntries(PROVIDERS.map((provider) => {
    const resolved = resolveProviderCredential(provider, config, environment);
    return [provider, { configured: Boolean(resolved.value), source: resolved.source }];
  }));
}

function normalizeResults(value) {
  if (!value || !Array.isArray(value.results)) throw new Error("malformed_response");
  return value.results.slice(0, 10).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const urlText = cleanText(entry.url, 2048);
    let parsed;
    try { parsed = new URL(urlText); } catch { return []; }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return [];
    return [{ title: cleanText(entry.title, 300), url: parsed.href, snippet: cleanText(entry.snippet, 1200) }];
  });
}

function deduplicate(results) {
  const seen = new Set();
  return results.filter((entry) => {
    const key = entry.url.replace(/#.*$/u, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function boundedAttempt(provider, query, maxResults, timeoutMs, dependencies) {
  const credential = provider === "searxng" ? { value: undefined } : resolveProviderCredential(provider, dependencies.config, dependencies.environment);
  if (provider !== "searxng" && !credential.value) return { provider, status: "credential_missing", result_count: 0, results: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const abortParent = () => controller.abort(new Error("cancelled"));
  dependencies.signal?.addEventListener("abort", abortParent, { once: true });
  try {
    const response = await dependencies.search(provider, credential.value, query, maxResults, controller.signal);
    const results = normalizeResults(response);
    return { provider, status: "ok", result_count: results.length, results };
  } catch (error) {
    const searxngCode = provider === "searxng" && typeof error?.message === "string" &&
      (/^http_status_\d{3}$/u.test(error.message) ||
       ["malformed_response", "response_too_large", "unsupported_content_type", "untrusted_endpoint", "api_redirect_forbidden", "request_timeout"].includes(error.message))
      ? (error.message === "request_timeout" ? "timeout" : error.message) : null;
    const reason = controller.signal.aborted ? (dependencies.signal?.aborted ? "cancelled" : "timeout") :
      searxngCode ?? (error?.message === "malformed_response" ? "malformed_response" : "provider_error");
    return { provider, status: reason, result_count: 0, results: [] };
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", abortParent);
  }
}

function formatResults(results, prefix = "") {
  const lines = results.map((entry, index) => `${index + 1}. ${entry.title || "Untitled"}\n   ${entry.url}\n   ${entry.snippet}`);
  const text = `${prefix}${lines.length ? lines.join("\n\n") : "No usable search results."}`;
  return Buffer.byteLength(text, "utf8") <= 49152 ? text : `${Buffer.from(text, "utf8").subarray(0, 49152).toString("utf8")}\n\n[bounded at 48 KiB]`;
}

export async function executeWebRoute(parameters, dependencies) {
  const query = cleanText(parameters.query, 1000).trim();
  if (!query) throw new Error("A non-empty web search query is required.");
  const maxResults = clamp(parameters.max_results ?? 5, 1, 10);
  const minimumResults = clamp(parameters.min_results ?? 2, 1, maxResults);
  const timeoutMs = clamp(dependencies.timeoutMs ?? 15000, 100, 20000);
  const policy = resolveWebPolicy(dependencies.config, dependencies.environment);
  const requested = parameters.provider ? assertExplicitProvider(parameters.provider) : null;
  const mode = parameters.mode === "cross-check" ? "cross-check" : "normal";
  if (requested === "searxng" && mode === "cross-check") throw new Error("SearXNG is an explicit single-provider route only.");
  const attempts = [];
  let selectedProviders = [];
  let fallbackUsed = false;
  let results = [];

  if (requested === "searxng") {
    const only = await boundedAttempt("searxng", query, maxResults, timeoutMs, dependencies);
    attempts.push((({ results: _results, ...receipt }) => receipt)(only));
    selectedProviders = only.status === "ok" ? ["searxng"] : [];
    results = only.results;
  } else if (mode === "cross-check") {
    const providers = requested ? [requested, requested === "brave" ? "perplexity" : "brave"] : [policy.primary, policy.secondary];
    const settled = await Promise.all(providers.map((provider) => boundedAttempt(provider, query, maxResults, timeoutMs, dependencies)));
    attempts.push(...settled.map(({ results: _results, ...receipt }) => receipt));
    selectedProviders = settled.filter((entry) => entry.status === "ok").map((entry) => entry.provider);
    results = deduplicate(settled.flatMap((entry) => entry.results)).slice(0, maxResults);
  } else {
    const firstProvider = requested ?? policy.primary;
    const first = await boundedAttempt(firstProvider, query, maxResults, timeoutMs, dependencies);
    attempts.push((({ results: _results, ...receipt }) => receipt)(first));
    results = first.results;
    selectedProviders = first.status === "ok" ? [first.provider] : [];
    const shouldFallback = !requested && policy.automaticFallback && (first.status !== "ok" || first.results.length < minimumResults);
    if (shouldFallback) {
      fallbackUsed = true;
      const second = await boundedAttempt(policy.secondary, query, maxResults, timeoutMs, dependencies);
      attempts.push((({ results: _results, ...receipt }) => receipt)(second));
      if (second.status === "ok") {
        selectedProviders = [second.provider];
        results = deduplicate([...second.results, ...first.results]).slice(0, maxResults);
      }
    }
  }

  const successful = attempts.some((entry) => entry.status === "ok");
  const status = successful ? (attempts.every((entry) => entry.status === "ok") ? "PASS" : "PARTIAL") : "FAIL";
  return {
    status,
    text: formatResults(results, requested === "searxng" ? "Untrusted search results; verify sources independently.\n\n" : ""),
    details: {
      status,
      requested_provider: requested,
      selected_provider: selectedProviders.length <= 1 ? (selectedProviders[0] ?? null) : selectedProviders,
      fallback_used: fallbackUsed,
      search_mode: mode,
      result_count: results.length,
      attempts,
      ...(requested === "searxng" ? { source_trust: "untrusted_search_results" } : {}),
    },
  };
}

export const WEB_PROVIDER_ENV_KEYS = ENV_KEYS;

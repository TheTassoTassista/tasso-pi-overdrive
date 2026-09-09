import test from "node:test";
import assert from "node:assert/strict";
import { executeWebRoute, resolveProviderCredential, resolveWebPolicy, webCredentialStatus } from "../lib/web-routing.mjs";

const baseConfig = { provider: "brave", overdriveRouting: { primaryProvider: "brave", secondaryProvider: "perplexity", automaticFallback: true } };
const result = (provider, count = 2) => ({ results: Array.from({ length: count }, (_, index) => ({ title: `${provider}-${index}`, url: `https://${provider}.example/${index}`, snippet: "fixture" })) });

function dependencies(config, responses = {}) {
  const calls = [];
  return {
    calls,
    value: {
      config,
      environment: {},
      timeoutMs: 500,
      search: async (provider, credential) => {
        calls.push({ provider, credential });
        const response = responses[provider];
        if (response instanceof Error) throw response;
        return response ?? result(provider);
      },
    },
  };
}

test("credential precedence is environment, provider config, then legacy Brave without exposing values", () => {
  assert.equal(resolveProviderCredential("brave", { apiKeys: { brave: "config-fixture" }, apiKey: "legacy-fixture" }, { BRAVE_SEARCH_API_KEY: "environment-fixture" }).source, "environment");
  assert.equal(resolveProviderCredential("brave", { apiKeys: { brave: "config-fixture" }, apiKey: "legacy-fixture" }, {}).source, "user-config");
  assert.equal(resolveProviderCredential("brave", { apiKey: "legacy-fixture" }, {}).source, "legacy-user-config");
  assert.deepEqual(webCredentialStatus({ apiKeys: { brave: "configured" } }, {}), {
    brave: { configured: true, source: "user-config" },
    perplexity: { configured: false, source: "missing" },
  });
});

test("the environment credential is the one passed to the provider when config also has a credential", async () => {
  let receivedCredential;
  const routed = await executeWebRoute({ query: "q", provider: "brave" }, {
    config: { ...baseConfig, apiKeys: { brave: "config-fixture" } },
    environment: { BRAVE_SEARCH_API_KEY: "environment-fixture" },
    search: async (_provider, credential) => {
      receivedCredential = credential;
      return result("brave");
    },
  });
  assert.equal(routed.status, "PASS");
  assert.equal(receivedCredential, "environment-fixture");
});

test("only Brave, only Perplexity, both, and neither route deterministically", async () => {
  const onlyBrave = dependencies({ ...baseConfig, apiKeys: { brave: "fixture" } });
  assert.equal((await executeWebRoute({ query: "q" }, onlyBrave.value)).details.selected_provider, "brave");
  assert.deepEqual(onlyBrave.calls.map((call) => call.provider), ["brave"]);

  const onlyPerplexity = dependencies({ ...baseConfig, apiKeys: { perplexity: "fixture" } });
  const fallback = await executeWebRoute({ query: "q" }, onlyPerplexity.value);
  assert.equal(fallback.details.selected_provider, "perplexity");
  assert.equal(fallback.details.fallback_used, true);
  assert.deepEqual(fallback.details.attempts.map((entry) => entry.status), ["credential_missing", "ok"]);

  const both = dependencies({ ...baseConfig, apiKeys: { brave: "fixture-a", perplexity: "fixture-b" } });
  assert.equal((await executeWebRoute({ query: "q" }, both.value)).details.fallback_used, false);
  assert.deepEqual(both.calls.map((call) => call.provider), ["brave"]);

  const neither = dependencies(baseConfig);
  const failed = await executeWebRoute({ query: "q" }, neither.value);
  assert.equal(failed.status, "FAIL");
  assert.deepEqual(failed.details.attempts.map((entry) => entry.status), ["credential_missing", "credential_missing"]);
});

test("explicit provider override disables fallback while weak normal results trigger observable fallback", async () => {
  const direct = dependencies({ ...baseConfig, apiKeys: { brave: "fixture-a", perplexity: "fixture-b" } });
  const overridden = await executeWebRoute({ query: "q", provider: "perplexity" }, direct.value);
  assert.equal(overridden.details.requested_provider, "perplexity");
  assert.equal(overridden.details.selected_provider, "perplexity");
  assert.equal(overridden.details.fallback_used, false);
  assert.deepEqual(direct.calls.map((call) => call.provider), ["perplexity"]);

  const weak = dependencies({ ...baseConfig, apiKeys: { brave: "fixture-a", perplexity: "fixture-b" } }, { brave: result("brave", 0), perplexity: result("perplexity", 2) });
  const rerouted = await executeWebRoute({ query: "q", min_results: 2 }, weak.value);
  assert.equal(rerouted.details.selected_provider, "perplexity");
  assert.equal(rerouted.details.fallback_used, true);
  assert.deepEqual(weak.calls.map((call) => call.provider), ["brave", "perplexity"]);
});

test("invalid providers fail before network and cross-check is isolated, deduplicated, and bounded to two", async () => {
  assert.throws(() => resolveWebPolicy({ ...baseConfig, provider: "invalid", overdriveRouting: { primaryProvider: "invalid", secondaryProvider: "perplexity" } }, {}), /Unsupported web provider/u);
  const calls = [];
  let active = 0;
  let maximum = 0;
  const routed = await executeWebRoute({ query: "q", mode: "cross-check", max_results: 4 }, {
    config: { ...baseConfig, apiKeys: { brave: "fixture-a", perplexity: "fixture-b" } },
    environment: {},
    timeoutMs: 500,
    search: async (provider) => {
      calls.push(provider);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { results: [{ title: provider, url: "https://shared.example/result", snippet: provider }] };
    },
  });
  assert.deepEqual(calls.sort(), ["brave", "perplexity"]);
  assert.equal(maximum, 2);
  assert.equal(routed.details.result_count, 1);
  assert.deepEqual(routed.details.selected_provider, ["brave", "perplexity"]);
});

test("provider errors, malformed responses, timeouts, and unsafe result URLs are sanitized into receipt codes", async () => {
  const config = { ...baseConfig, apiKeys: { brave: "fixture-a", perplexity: "fixture-b" } };
  const broken = dependencies(config, { brave: new Error("remote body must not escape"), perplexity: null });
  broken.value.search = async (provider) => provider === "brave" ? Promise.reject(new Error("remote body must not escape")) : { invalid: true };
  const response = await executeWebRoute({ query: "q" }, broken.value);
  assert.equal(response.status, "FAIL");
  assert.deepEqual(response.details.attempts.map((entry) => entry.status), ["provider_error", "malformed_response"]);
  assert.doesNotMatch(JSON.stringify(response), /remote body must not escape/u);

  const unsafe = await executeWebRoute({ query: "q", provider: "brave" }, {
    config,
    environment: {},
    search: async () => ({ results: [{ title: "bad", url: "file:///etc/passwd", snippet: "bad" }, { title: "ok", url: "https://safe.example/", snippet: "x".repeat(5000) }] }),
  });
  assert.equal(unsafe.details.result_count, 1);
  assert.ok(unsafe.text.length < 3000);
});

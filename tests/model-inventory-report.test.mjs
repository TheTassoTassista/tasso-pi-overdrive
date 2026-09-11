import test from "node:test";
import assert from "node:assert/strict";
import { summarizeProviderCapabilities } from "../lib/model-inventory-report.mjs";

test("registered provider without authentication is not reported as authenticated", () => {
  const result = summarizeProviderCapabilities({
    providers: [
      { provider: "registry-only", configured: false, availableModels: 0 },
      { provider: "authenticated", configured: true, availableModels: 2 },
    ],
    availableModels: [
      { model: "registry-only/model", registryStatus: "REGISTRY_AVAILABLE", authenticationStatus: "AUTH_MISSING", runtimeStatus: "RUNTIME_CALLABLE" },
      { model: "authenticated/callable", registryStatus: "REGISTRY_AVAILABLE", authenticationStatus: "AUTHENTICATED", runtimeStatus: "RUNTIME_CALLABLE" },
      { model: "authenticated/rejected", registryStatus: "REGISTRY_AVAILABLE", authenticationStatus: "AUTHENTICATED", runtimeStatus: "RUNTIME_REJECTED" },
      { model: "authenticated/unknown", registryStatus: "REGISTRY_AVAILABLE", authenticationStatus: "AUTHENTICATED", runtimeStatus: "RUNTIME_UNKNOWN" },
    ],
  });

  assert.deepEqual(result.authenticatedProviders, ["authenticated"]);
  assert.deepEqual(result.providerCapabilities.find((entry) => entry.provider === "registry-only"), {
    provider: "registry-only",
    registryStatus: "REGISTRY_AVAILABLE",
    authenticationStatus: "AUTH_MISSING",
    runtimeCallable: 1,
    runtimeRejected: 0,
    runtimeUnknown: 0,
  });
  assert.deepEqual(result.providerCapabilities.find((entry) => entry.provider === "authenticated"), {
    provider: "authenticated",
    registryStatus: "REGISTRY_AVAILABLE",
    authenticationStatus: "AUTH_PRESENT",
    runtimeCallable: 1,
    runtimeRejected: 1,
    runtimeUnknown: 1,
  });
});

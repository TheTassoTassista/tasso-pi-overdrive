const AUTH_PRESENT = new Set(["AUTHENTICATED", "AUTH_PRESENT"]);

function providerFromModel(identity) {
  return typeof identity === "string" && identity.includes("/") ? identity.slice(0, identity.indexOf("/")) : "";
}

export function summarizeProviderCapabilities(inventory = {}) {
  const providers = Array.isArray(inventory.providers) ? inventory.providers : [];
  const models = Array.isArray(inventory.availableModels) ? inventory.availableModels : [];
  const authenticatedProviders = providers
    .filter((entry) => entry?.configured === true)
    .map((entry) => entry.provider)
    .filter((provider) => typeof provider === "string" && provider.length > 0);
  const summaries = new Map();

  for (const provider of new Set([
    ...providers.map((entry) => entry?.provider),
    ...models.map((entry) => providerFromModel(entry?.model)),
  ].filter((value) => typeof value === "string" && value.length > 0))) {
    const providerMetadata = providers.find((entry) => entry?.provider === provider);
    const providerModels = models.filter((entry) => providerFromModel(entry?.model) === provider);
    summaries.set(provider, {
      provider,
      registryStatus: providerModels.some((entry) => entry.registryStatus === "REGISTRY_AVAILABLE") ? "REGISTRY_AVAILABLE" : "REGISTRY_MISSING",
      authenticationStatus: providerMetadata?.configured === true || providerModels.some((entry) => AUTH_PRESENT.has(entry.authenticationStatus)) ? "AUTH_PRESENT" : "AUTH_MISSING",
      runtimeCallable: providerModels.filter((entry) => entry.runtimeStatus === "RUNTIME_CALLABLE").length,
      runtimeRejected: providerModels.filter((entry) => entry.runtimeStatus === "RUNTIME_REJECTED").length,
      runtimeUnknown: providerModels.filter((entry) => !["RUNTIME_CALLABLE", "RUNTIME_REJECTED"].includes(entry.runtimeStatus)).length,
    });
  }

  return {
    authenticatedProviders: [...new Set(authenticatedProviders)].sort(),
    providerCapabilities: [...summaries.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
  };
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import routingPolicy from "../config/routing-policy.json" with { type: "json" };

type CatalogModel = {
  identity: string;
  source: string;
  family: string;
  catalogId?: string;
  contextWindow?: number;
  maxTokens?: number;
  pricing?: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
};

export default function omnirouteProvider(pi: ExtensionAPI): void {
  const models = Object.values(routingPolicy.models as Record<string, CatalogModel>)
    .filter((model) => model.source === "OmniRoute" && model.catalogId)
    .map((model) => ({
      id: model.catalogId!,
      name: `${model.family} via OmniRoute — ${model.catalogId}`,
      reasoning: false,
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
      input: ["text"] as ["text"],
      cost: model.pricing ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow!,
      maxTokens: model.maxTokens!,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    }));
  pi.registerProvider("omniroute", {
    name: "OmniRoute (existing local gateway)",
    baseUrl: "$OMNIROUTER_BASE_URL",
    apiKey: "$OMNIROUTER_API_KEY",
    authHeader: true,
    api: "openai-completions",
    models,
  });
}

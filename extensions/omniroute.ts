import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOmniRouteStream, loadPiOpenAiCompletionsStreamSimple, OMNIROUTE_TLS_ORIGIN } from "../lib/omniroute-tls.mjs";
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

export function createOmniRouteSelectionGate(argv: string[]) {
  const providerIndex = argv.indexOf("--provider");
  const modelIndex = argv.indexOf("--model");
  let explicitlySelected = (providerIndex >= 0 && argv[providerIndex + 1] === "omniroute") || argv.includes("--provider=omniroute") ||
    (modelIndex >= 0 && argv[modelIndex + 1]?.startsWith("omniroute/")) || argv.some((arg) => arg.startsWith("--model=omniroute/"));
  return {
    selected(event: { model: { provider: string }; source: string }) {
      explicitlySelected = event.model.provider === "omniroute" && (event.source === "set" || event.source === "cycle");
    },
    assertAuthorized() {
      if (!explicitlySelected) throw new Error("OMNIROUTE_EXPLICIT_SELECTION_REQUIRED");
    },
  };
}

export default function omnirouteProvider(pi: ExtensionAPI): void {
  const streamSimple = loadPiOpenAiCompletionsStreamSimple();
  const secureStream = createOmniRouteStream(streamSimple);
  // A configured token is not consent to use OmniRoute as Pi's fallback.
  const selection = createOmniRouteSelectionGate(process.argv);
  pi.on("model_select", (event) => selection.selected(event));
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
    name: "OmniRoute (verified local HTTPS)",
    baseUrl: `${OMNIROUTE_TLS_ORIGIN}/v1`,
    apiKey: "$OMNIROUTER_API_KEY",
    authHeader: true,
    api: "openai-completions",
    streamSimple: (model, context, options) => {
      selection.assertAuthorized();
      return secureStream(model, context, options);
    },
    models,
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const direct = ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol", "gpt-6-astra"].map((id) => ({
  id, name: `Deterministic ${id}`, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, input: ["text"] as ["text"], cost, contextWindow: 278528, maxTokens: 32768,
}));
const omni = [
  "deepseek/deepseek-v4-pro-high", "deepseek/deepseek-v4-flash", "openrouter/qwen/qwen3.8-27b",
  "openrouter/qwen/qwen3-coder-next", "groq/qwen/qwen3-32b", "auto/best-fast", "auto/best-reasoning", "auto/best-coding",
].map((id) => ({ id, name: `Deterministic ${id}`, reasoning: false, input: ["text"] as ["text"], cost, contextWindow: 1_000_000, maxTokens: 32768 }));

export default function deterministicRoutingProvider(pi: ExtensionAPI): void {
  pi.registerProvider("pi-overdrive-routing-audit", { name: "Deterministic routing command driver", baseUrl: "http://127.0.0.1.invalid", apiKey: "$PI_OVERDRIVE_ROUTING_AUDIT_KEY", api: "openai-completions", models: [{ id: "driver", name: "Routing command driver", reasoning: false, input: ["text"], cost, contextWindow: 8192, maxTokens: 1024 }] });
  pi.registerProvider("openai-codex", { name: "Deterministic OpenAI routing catalog", baseUrl: "http://127.0.0.1.invalid", apiKey: "$PI_OVERDRIVE_ROUTING_AUDIT_KEY", api: "openai-completions", models: direct });
  pi.registerProvider("omniroute", { name: "Deterministic OmniRoute catalog", baseUrl: "http://127.0.0.1.invalid", apiKey: "$PI_OVERDRIVE_ROUTING_AUDIT_KEY", api: "openai-completions", models: omni });
}

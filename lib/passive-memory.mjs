import { containsSecret } from "./memory-security.mjs";

// Only direct, durable user declarations qualify. Never persist a transcript,
// arbitrary task text, model output, tool output, or a credential-like value.
export function extractPassiveUserMemory(prompt) {
  if (typeof prompt !== "string" || prompt.length > 500 || prompt.includes("\n") || /```|<\/?(?:system|assistant|tool)>/iu.test(prompt)) return null;
  const trimmed = prompt.trim();
  const match = /^(?:ricorda\s+che|remember\s+that|da\s+ora\s+in\s+poi|from\s+now\s+on|preferisco\s+che|i\s+prefer\s+that)\s*[:,]?\s*(.+)$/iu.exec(trimmed);
  if (!match) return null;
  const content = match[1].trim();
  if (content.length < 20 || content.length > 300 || containsSecret({ content }) || /(?:password|api.?key|token|secret|credenzial|chiave privata)/iu.test(content)) return null;
  return { content, type: "decision", sourceType: "user", trustLevel: "USER", confidence: 1, verified: false, importance: "medium", retentionDays: 365, tags: ["passive-user-preference"], reason: "Direct user preference captured without a slash command" };
}

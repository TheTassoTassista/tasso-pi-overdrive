import type { Context, Tool } from "@earendil-works/pi-ai";

// Pi 0.87 normalizes provider input into transcript system messages. Older Pi
// passes these two values as top-level Context fields. Keep deterministic
// fixtures sensitive to the real model-facing declarations on both runtimes.
export function providerTools(context: Context): Tool[] {
  if (context.tools !== undefined) return context.tools;
  const tools = new Map<string, Tool>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
    for (const added of message.toolsAdded ?? []) tools.set(added.name, added);
  }
  return [...tools.values()];
}

export function providerSystemPrompt(context: Context): string {
  if (context.systemPrompt !== undefined) return context.systemPrompt;
  const content: string[] = [];
  const sections = new Map<string, string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string") {
      if (message.content) content.push(message.content);
    } else {
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (text) content.push(text);
    }
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [...content, ...sections.values()].join("\n");
}

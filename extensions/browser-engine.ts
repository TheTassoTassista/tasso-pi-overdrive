import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BrowserEngine } from "../lib/browser-engine.mjs";

const Parameters = Type.Object({
  args: Type.Array(Type.String({ maxLength: 2048 }), { minItems: 3, maxItems: 7 }),
  sessionMode: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("auto")])),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000 })),
}, { additionalProperties: false });

export default function browserEngineExtension(pi: ExtensionAPI): void {
  let engine: BrowserEngine | undefined;
  pi.registerTool({
    name: "browser_engine",
    label: "Isolated Browser Engine",
    description: "Bounded local UI actions for an allocated autonomous worktree. Pinned agent-browser and Chromium remain in one private networkless Bubblewrap namespace. No external network, JavaScript eval, auth, upload, download, alternate session/profile or host browser attach.",
    promptSnippet: "Use browser_engine only for a local index.html fixture in your allocated worktree; the exact session/profile/port come from your runtime allocation",
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal, _update, ctx) {
      const owner = ctx.sessionManager.getSessionId();
      if (!engine) engine = new BrowserEngine({ cwd: ctx.cwd, ownerSession: owner });
      if (signal?.aborted) throw new Error("BROWSER_ENGINE_CANCELLED");
      const onAbort = () => { void engine?.terminate(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      let result;
      try { result = await engine.execute(input, owner); }
      finally { signal?.removeEventListener("abort", onAbort); }
      const { text, ...metadata } = result;
      pi.events.emit("pi-overdrive:browser-metadata", { kind: "browser_engine", action: result.action, state: result.state, networkNamespace: result.networkNamespace, sandboxed: true, externalNetwork: false, screenshotDigest: result.screenshot?.digest });
      return { content: [{ type: "text", text: `${JSON.stringify(metadata)}\n${text}` }], details: metadata };
    },
  });
  pi.on("session_shutdown", async () => { if (engine) await engine.terminate(); });
}

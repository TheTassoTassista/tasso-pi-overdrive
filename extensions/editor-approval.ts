import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EDITOR_APPROVAL_TITLE, editorApprovalIntent, encodeEditorApproval } from "../lib/editor-bridge.mjs";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (process.env.PI_OVERDRIVE_EDITOR_BRIDGE !== "1") return undefined;
    if (ctx.mode !== "rpc") return { block: true as const, reason: "Editor approval bridge is valid only in Pi RPC mode." };
    const intent = editorApprovalIntent(event.toolName, event.input);
    if (!intent) return undefined;
    const confirmed = await ctx.ui.confirm(
      EDITOR_APPROVAL_TITLE,
      encodeEditorApproval(event.toolCallId, intent.toolName, intent.toolKind, intent.inputDigest),
      { timeout: 120_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (!confirmed) return { block: true as const, reason: `Editor client did not approve governed ${intent.toolKind} tool ${intent.toolName}.` };
    return undefined;
  });
}

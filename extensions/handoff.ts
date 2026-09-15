import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { CONTEXT_FIT_STATUS, contextFitMetadata, governContext, readContextGovernorPolicy, renderContextFit } from "../lib/context-governor.mjs";
import { NOTEBOOK_ENTRY_TYPE, formatNotebook, isNotebookState } from "./notebook.ts";

const SYSTEM_PROMPT = `Create a concise, self-contained handoff prompt for a new coding session. Preserve only verified facts, decisions, constraints, relevant files, current repository state, unresolved risks, and the next task. Distinguish evidence from assumptions. Never reproduce credentials, environment values, or secret material. Output only the handoff prompt.`;
const MAX_SERIALIZED_CHARS = 120000;

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "compaction") {
    return { role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: new Date(entry.timestamp).getTime() };
  }
  return undefined;
}

function relevantMessages(branch: SessionEntry[]): AgentMessage[] {
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  const selected = compactionIndex < 0 ? branch : branch.slice(compactionIndex);
  return selected.map(entryToMessage).filter((message): message is AgentMessage => message !== undefined);
}

function isCustomEntry(entry: SessionEntry): entry is CustomEntry {
  return entry.type === "custom" && "customType" in entry;
}

function notebookText(branch: SessionEntry[]): string {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry && isCustomEntry(entry) && entry.customType === NOTEBOOK_ENTRY_TYPE && isNotebookState(entry.data)) return formatNotebook(entry.data);
  }
  return "(no task notebook entries)";
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Distill this phase into an editable prompt for a clean new session",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        ctx.ui.notify("/handoff requires TUI or an RPC client that handles extension UI requests", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }
      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /handoff <next phase goal>", "error");
        return;
      }

      const branch = ctx.sessionManager.getBranch();
      let conversation = serializeConversation(convertToLlm(relevantMessages(branch)));
      if (conversation.length > MAX_SERIALIZED_CHARS) conversation = `[older context omitted]\n${conversation.slice(-MAX_SERIALIZED_CHARS)}`;
      const previousSession = ctx.sessionManager.getSessionFile();
      const userMessage: Message = {
        role: "user",
        content: [{ type: "text", text: `## Canonical notebook\n${notebookText(branch)}\n\n## Recent/compacted conversation\n${conversation}\n\n## Next phase\n${goal}` }],
        timestamp: Date.now(),
      };
      const fit = governContext({
        messages: [userMessage],
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        activeToolNames: [],
        model: ctx.model,
        reserveOutputTokens: 5000,
        policy: readContextGovernorPolicy(),
      });
      const fitMetadata = { ...contextFitMetadata(fit), kind: "context_fit_direct_handoff" };
      pi.events.emit("pi-overdrive:context-metadata", fitMetadata);
      if (fit.proof.status !== CONTEXT_FIT_STATUS.PASS) {
        ctx.ui.notify(renderContextFit(fit), "error");
        return;
      }
      const generate = async (signal?: AbortSignal): Promise<string | null> => {
        const response = await ctx.modelRegistry.complete(ctx.model!, { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] }, {
          ...(signal ? { signal } : {}),
          cacheRetention: "none",
          sessionId: uuidv7(),
          maxTokens: 5000,
        });
        if (response.stopReason === "aborted") return null;
        return response.content.filter((item): item is { type: "text"; text: string } => item.type === "text").map((item) => item.text).join("\n");
      };

      const generated = ctx.mode === "tui"
        ? await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
            const loader = new BorderedLoader(tui, theme, "Distilling handoff...");
            loader.onAbort = () => done(null);
            generate(loader.signal).then(done).catch(() => done(null));
            return loader;
          })
        : await generate().catch(() => null);

      if (!generated) {
        ctx.ui.notify("Handoff cancelled or generation failed", "warning");
        return;
      }
      const edited = await ctx.ui.editor("Review handoff prompt", generated);
      if (edited === undefined) return;
      const switched = await ctx.newSession({
        ...(previousSession ? { parentSession: previousSession } : {}),
        withSession: async (replacement) => {
          replacement.ui.setEditorText(edited);
          replacement.ui.notify("Handoff ready; review and submit.", "info");
        },
      });
      if (switched.cancelled) ctx.ui.notify("New session cancelled", "info");
    },
  });
}

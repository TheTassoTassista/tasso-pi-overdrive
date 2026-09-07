import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENTRY_TYPE = "tasso-pi-overdrive.notebook";
const MAX_NOTEBOOK_CHARS = 12000;

interface NotebookState {
  topic?: string;
  goal?: string;
  decisions: string[];
  constraints: string[];
  evidence: string[];
  next: string[];
}

const emptyState = (): NotebookState => ({ decisions: [], constraints: [], evidence: [], next: [] });

function isNotebookState(value: unknown): value is NotebookState {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["decisions", "constraints", "evidence", "next"].every((key) => Array.isArray(row[key]));
}

function latestState(ctx: ExtensionContext): NotebookState {
  let state = emptyState();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE && isNotebookState(entry.data)) {
      state = structuredClone(entry.data);
    }
  }
  return state;
}

function format(state: NotebookState): string {
  const section = (title: string, values: string[]) => `## ${title}\n${values.length ? values.map((item) => `- ${item}`).join("\n") : "- (none)"}`;
  return [
    `# Task Notebook${state.topic ? `: ${state.topic}` : ""}`,
    state.goal ? `\nGoal: ${state.goal}` : "",
    section("Decisions", state.decisions),
    section("Constraints", state.constraints),
    section("Evidence", state.evidence),
    section("Next", state.next),
  ].filter(Boolean).join("\n\n");
}

const Params = Type.Object({
  action: StringEnum(["read", "set-topic", "set-goal", "add", "remove", "clear"] as const),
  section: Type.Optional(StringEnum(["decisions", "constraints", "evidence", "next"] as const)),
  text: Type.Optional(Type.String({ maxLength: 2000 })),
  index: Type.Optional(Type.Integer({ minimum: 1 })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "task_notebook",
    label: "Task notebook",
    description: "Read or update compact session-scoped task state. Store only durable decisions, constraints, evidence, and next actions; never transcripts or secrets.",
    parameters: Params,
    async execute(_id, params, _signal, _update, ctx) {
      const state = latestState(ctx);
      let message = "Notebook read";
      if (params.action === "set-topic") {
        if (!params.text?.trim()) throw new Error("text is required");
        state.topic = params.text.trim();
        message = "Topic updated";
      } else if (params.action === "set-goal") {
        if (!params.text?.trim()) throw new Error("text is required");
        state.goal = params.text.trim();
        message = "Goal updated";
      } else if (params.action === "add") {
        if (!params.section || !params.text?.trim()) throw new Error("section and text are required");
        state[params.section].push(params.text.trim());
        message = `Added ${params.section} item`;
      } else if (params.action === "remove") {
        if (!params.section || params.index === undefined) throw new Error("section and index are required");
        const removed = state[params.section].splice(params.index - 1, 1);
        if (removed.length === 0) throw new Error("index is out of range");
        message = `Removed ${params.section} item`;
      } else if (params.action === "clear") {
        Object.assign(state, emptyState());
        message = "Notebook cleared";
      }

      const rendered = format(state);
      if (rendered.length > MAX_NOTEBOOK_CHARS) throw new Error(`Notebook exceeds ${MAX_NOTEBOOK_CHARS} characters; remove stale detail first`);
      if (params.action !== "read") pi.appendEntry(ENTRY_TYPE, state);
      return {
        content: [{ type: "text", text: `${message}.\n\n${rendered}` }],
        details: { action: params.action, state },
      };
    },
  });

  pi.registerCommand("notebook", {
    description: "Show the current session's compact task notebook",
    handler: async (_args, ctx) => ctx.ui.notify(format(latestState(ctx)), "info"),
  });
}

export { ENTRY_TYPE as NOTEBOOK_ENTRY_TYPE, format as formatNotebook, isNotebookState };

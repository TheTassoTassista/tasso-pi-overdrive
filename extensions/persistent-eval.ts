import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PersistentEvalEngine, persistentEvalErrorCode } from "../lib/persistent-eval.mjs";

const Action = Type.Union([Type.Literal("execute"), Type.Literal("reset"), Type.Literal("status"), Type.Literal("terminate")]);
const Common = {
  action: Action,
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 65536, description: "One bounded cell. State persists only in this Pi session and language kernel." })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 15000 })),
};
const PythonParameters = Type.Object(Common, { additionalProperties: false });
const JavaScriptParameters = Type.Object({
  ...Common,
  dialect: Type.Optional(Type.Union([Type.Literal("javascript"), Type.Literal("typescript")])),
}, { additionalProperties: false });

function metadata(language: string, action: string, status: string, result?: Record<string, any>, errorCode?: string) {
  const session = result?.session && typeof result.session === "object" ? result.session : result;
  return {
    kind: "persistent_eval",
    language,
    dialect: typeof result?.dialect === "string" ? result.dialect : undefined,
    action,
    status,
    errorCode,
    state: typeof session?.state === "string" ? session.state : undefined,
    sandboxed: session?.sandboxed === true,
    network: session?.network === false ? false : undefined,
    projectWorkspaceMounted: session?.projectWorkspaceMounted === false ? false : undefined,
    hostUserFilesystem: session?.hostUserFilesystem === false ? false : undefined,
    systemRuntimeReadOnly: session?.systemRuntimeReadOnly === true,
    subprocessBridge: session?.subprocessBridge === false ? false : undefined,
    persistent: typeof session?.persistent === "boolean" ? session.persistent : undefined,
    activeKernels: Number.isSafeInteger(session?.activeKernels) ? session.activeKernels : undefined,
    durationMs: typeof result?.durationMs === "number" ? result.durationMs : undefined,
    outputBytes: Number.isSafeInteger(result?.outputBytes) ? Number(result?.outputBytes) : undefined,
    outputTruncated: typeof result?.outputTruncated === "boolean" ? result.outputTruncated : undefined,
    valueTruncated: typeof result?.valueTruncated === "boolean" ? result.valueTruncated : undefined,
    starts: Number.isSafeInteger(session?.stats?.starts) ? session.stats.starts : undefined,
    executions: Number.isSafeInteger(session?.stats?.executions) ? session.stats.executions : undefined,
    timeouts: Number.isSafeInteger(session?.stats?.timeouts) ? session.stats.timeouts : undefined,
    crashes: Number.isSafeInteger(session?.stats?.crashes) ? session.stats.crashes : undefined,
    cleanups: Number.isSafeInteger(session?.stats?.cleanups) ? session.stats.cleanups : undefined,
  };
}

function resultDetails(result: Record<string, any>) {
  return {
    kind: "PERSISTENT_EVAL_RESULT",
    status: result.status,
    language: result.language,
    dialect: result.dialect,
    durationMs: result.durationMs,
    outputBytes: result.outputBytes,
    outputTruncated: result.outputTruncated,
    valueTruncated: result.valueTruncated,
    errorType: result.errorType,
    session: result.session,
  };
}

function chunk(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.split("\n").flatMap((line) => line.length === 0 ? [""] : line.match(/[\s\S]{1,512}/gu) ?? [""]).join("\n");
}

function renderResult(result: Record<string, any>): string {
  if (result.kind !== "PERSISTENT_EVAL_RESULT") return JSON.stringify(result);
  const header = {
    kind: result.kind,
    status: result.status,
    language: result.language,
    dialect: result.dialect,
    durationMs: result.durationMs,
    outputBytes: result.outputBytes,
    outputTruncated: result.outputTruncated,
    valueTruncated: result.valueTruncated,
    errorType: result.errorType,
    error: result.error,
    session: result.session,
  };
  const sections = [JSON.stringify(header)];
  if (result.stdout) sections.push(`stdout:\n${chunk(result.stdout)}`);
  if (result.stderr) sections.push(`stderr:\n${chunk(result.stderr)}`);
  if (result.value) sections.push(`value:\n${chunk(result.value)}`);
  return sections.join("\n");
}

export default function persistentEvalExtension(pi: ExtensionAPI): void {
  let engine: PersistentEvalEngine | undefined;
  let initializationError: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    try {
      engine = new PersistentEvalEngine({ cwd: ctx.cwd });
      initializationError = undefined;
    } catch (error) {
      engine = undefined;
      initializationError = persistentEvalErrorCode(error);
      pi.events.emit("pi-overdrive:eval-metadata", metadata("all", "initialize", "DEGRADED", undefined, initializationError));
    }
  });

  const register = (name: "persistent_python" | "persistent_javascript", language: "python" | "javascript", parameters: any, label: string) => {
    pi.registerTool({
      name,
      label,
      description: language === "python"
        ? "Run bounded persistent Python cells in a private networkless Bubblewrap kernel. No project mount, ambient credentials, shell, subprocess bridge, host user files, or tool bridge is exposed; only the read-only system runtime and a private temporary filesystem remain."
        : "Run bounded persistent JavaScript or TypeScript cells in a private networkless Bubblewrap kernel. No project mount, ambient credentials, require/process/fetch, shell, host user files, or tool bridge is exposed; only the read-only system runtime and a private temporary filesystem remain.",
      promptSnippet: `Use ${name} only for calculations, parsing, bounded experiments, data/AST transformations, and reproductions that benefit from session-local state`,
      promptGuidelines: [
        "Use execute for one cell; later calls reuse this language's state. Use reset to discard it, and terminate when finished.",
        "Read repository or artifact evidence through normal governed tools first, then pass only the required data into eval. Eval cannot bypass ResourceFS or request mutation/network/shell authority.",
        "A timeout or kernel crash discards that kernel. The next execute starts a clean one.",
      ],
      parameters,
      executionMode: "sequential",
      async execute(_toolCallId, input, signal) {
        if (!engine) throw new Error(`Persistent eval unavailable (${initializationError ?? "EVAL_ENGINE_UNAVAILABLE"}).`);
        const request = input as Record<string, any>;
        try {
          const result = await engine.execute(language, request, signal) as Record<string, any>;
          pi.events.emit("pi-overdrive:eval-metadata", metadata(language, request.action, result.status ?? "PASS", result));
          return { content: [{ type: "text", text: renderResult(result) }], details: resultDetails(result) };
        } catch (error) {
          const code = persistentEvalErrorCode(error);
          pi.events.emit("pi-overdrive:eval-metadata", metadata(language, request.action, "FAIL", engine.status(language) as Record<string, any>, code));
          throw new Error(`Persistent eval denied (${code}).`);
        }
      },
    });
  };

  register("persistent_python", "python", PythonParameters, "Persistent Python Eval");
  register("persistent_javascript", "javascript", JavaScriptParameters, "Persistent JavaScript/TypeScript Eval");

  pi.registerCommand("eval-engine", {
    description: "Show lazy persistent-eval policy/session status without starting a kernel",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(engine ? { python: engine.status("python"), javascript: engine.status("javascript") } : { status: "DEGRADED", errorCode: initializationError ?? "EVAL_ENGINE_UNAVAILABLE" }, null, 2), "info"),
  });

  pi.on("session_shutdown", async () => { if (engine) await engine.terminateAll("SESSION_SHUTDOWN"); });
}

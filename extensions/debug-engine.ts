import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DapEngine, dapErrorCode } from "../lib/dap-engine.mjs";

const Action = Type.Union([
  Type.Literal("launch"), Type.Literal("set_breakpoint"), Type.Literal("continue"), Type.Literal("step_over"),
  Type.Literal("stack_trace"), Type.Literal("scopes"), Type.Literal("variables"), Type.Literal("output"),
  Type.Literal("status"), Type.Literal("terminate"),
]);

const Parameters = Type.Object({
  action: Action,
  program: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, description: "Workspace-relative executable or .py source for launch; adapter selected by controller." })),
  args: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64, description: "Bounded debuggee arguments; never a shell command." })),
  file: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, description: "Workspace-relative source file for a breakpoint." })),
  line: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000000 })),
  frameId: Type.Optional(Type.Integer({ minimum: 0 })),
  variablesReference: Type.Optional(Type.Integer({ minimum: 1 })),
  levels: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  start: Type.Optional(Type.Integer({ minimum: 0 })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 15000 })),
}, { additionalProperties: false });

function metadata(action: string, status: string, result?: Record<string, any>, errorCode?: string) {
  const session = result?.session && typeof result.session === "object" ? result.session : result;
  return {
    kind: "dap_engine", action, status, errorCode,
    adapter: typeof session?.adapter === "string" ? session.adapter : undefined,
    state: typeof session?.state === "string" ? session.state : undefined,
    sandboxed: session?.sandboxed === true,
    network: session?.network === false ? false : undefined,
    workspaceReadOnly: session?.workspaceReadOnly === true,
    programDigest: typeof session?.programDigest === "string" ? session.programDigest : undefined,
    breakpointCount: Number.isSafeInteger(session?.breakpointCount) ? session.breakpointCount : undefined,
    outputBytes: Number.isSafeInteger(session?.outputBytes) ? session.outputBytes : undefined,
    outputTruncated: typeof session?.outputTruncated === "boolean" ? session.outputTruncated : undefined,
    frameCount: Array.isArray(result?.frames) ? result.frames.length : undefined,
    scopeCount: Array.isArray(result?.scopes) ? result.scopes.length : undefined,
    variableCount: Array.isArray(result?.variables) ? result.variables.length : undefined,
  };
}

function resultDetails(result: Record<string, any>) {
  const session = result.session && typeof result.session === "object" ? result.session : result;
  return {
    kind: typeof result.kind === "string" ? result.kind : "DAP_SESSION",
    session,
    frameCount: Array.isArray(result.frames) ? result.frames.length : undefined,
    scopeCount: Array.isArray(result.scopes) ? result.scopes.length : undefined,
    variableCount: Array.isArray(result.variables) ? result.variables.length : undefined,
    breakpointCount: Array.isArray(result.breakpoints) ? result.breakpoints.length : undefined,
    outputBytes: Number.isSafeInteger(result.totalBytes) ? result.totalBytes : undefined,
    outputTruncated: typeof result.truncated === "boolean" ? result.truncated : undefined,
  };
}

function boundedToolText(result: Record<string, any>): string {
  if (result.kind !== "DAP_OUTPUT" || typeof result.output !== "string") return JSON.stringify(result);
  const { output, ...metadataOnly } = result;
  const wrapped = output.split("\n").flatMap((line: string) => line.length === 0 ? [""] : line.match(/[\s\S]{1,512}/gu) ?? [""]).join("\n");
  return `${JSON.stringify(metadataOnly)}\n${wrapped}`;
}

export default function debugEngineExtension(pi: ExtensionAPI): void {
  let engine: DapEngine | undefined;
  let initializationError: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    try {
      engine = new DapEngine({ cwd: ctx.cwd });
      initializationError = undefined;
    } catch (error) {
      engine = undefined;
      initializationError = dapErrorCode(error);
      pi.events.emit("pi-overdrive:dap-metadata", metadata("initialize", "DEGRADED", undefined, initializationError));
    }
  });

  pi.registerTool({
    name: "debug_engine",
    label: "Sandboxed Debug Engine",
    description: "Use one lazy GDB or debugpy DAP session for a workspace executable or Python source. The controller selects the pinned adapter. Both adapter and debuggee run inside a networkless Bubblewrap sandbox with the workspace read-only. No attach, raw debugger command, arbitrary adapter, memory write, or function evaluation is exposed.",
    promptSnippet: "Use debug_engine for bounded launch, breakpoints, stepping, stack/scopes/variables, output, and deterministic cleanup",
    promptGuidelines: [
      "Launch only an existing workspace-relative executable or .py source. Set source breakpoints while CONFIGURING, then continue to complete DAP configuration.",
      "Inspect stack_trace, then scopes for a returned frameId, then variables for a returned variablesReference.",
      "Always terminate the session when debugging is complete. Any timeout or protocol failure cleans up fail closed.",
    ],
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal) {
      if (!engine) throw new Error(`Debug engine unavailable (${initializationError ?? "DAP_ENGINE_UNAVAILABLE"}).`);
      try {
        const result = await engine.execute(parameters, signal);
        pi.events.emit("pi-overdrive:dap-metadata", metadata(parameters.action, "PASS", result as Record<string, any>));
        return { content: [{ type: "text", text: boundedToolText(result as Record<string, any>) }], details: resultDetails(result as Record<string, any>) };
      } catch (error) {
        const code = dapErrorCode(error);
        pi.events.emit("pi-overdrive:dap-metadata", metadata(parameters.action, "FAIL", engine.status() as Record<string, any>, code));
        throw new Error(`Debug engine denied (${code}).`);
      }
    },
  });

  pi.registerCommand("debug-engine", {
    description: "Show lazy debugger policy/session status without starting an adapter",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(engine?.status() ?? { status: "DEGRADED", errorCode: initializationError ?? "DAP_ENGINE_UNAVAILABLE" }, null, 2), "info"),
  });

  pi.on("session_shutdown", async () => {
    if (engine) await engine.terminate("SESSION_SHUTDOWN");
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRuntimeAllocation } from "../lib/runtime-isolation.mjs";
import { consumeBlockedStreamGuard } from "../lib/stream-guard.mjs";
import {
  classifyCommand,
  inspectWorkspaceConstraint,
  inspectWorkspacePath,
  isAlwaysProtectedWritePath,
  isSecretPath,
  validateSubagentCall,
  validateAllocatedBrowserCall,
  validateAstGrepCall,
} from "../lib/safety.mjs";

function inputPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    const candidate = inputPath(input);
    const block = (reason: string) => {
      const correction = consumeBlockedStreamGuard(ctx.sessionManager.getSessionId(), event.toolCallId, event.toolName);
      return {
        block: true as const,
        reason: correction ? `${correction.reminder}\n\nBlocked by governing safety policy: ${reason}` : reason,
      };
    };

    if (event.toolName === "debug_engine") {
      for (const key of ["program", "file"] as const) {
        const requested = input[key];
        if (requested === undefined) continue;
        if (typeof requested !== "string" || isSecretPath(requested) || isAlwaysProtectedWritePath(requested)) return block(`Debugger workspace path denied: ${key}`);
        const inspected = inspectWorkspacePath(ctx.cwd, requested, { mustExist: true });
        if (!inspected.allowed || !("stat" in inspected) || !inspected.stat?.isFile() || isSecretPath(inspected.canonical) || isAlwaysProtectedWritePath(inspected.canonical)) return block(`Debugger workspace path denied: ${key}`);
      }
    }

    if (["ffgrep", "fffind"].includes(event.toolName) && candidate) {
      const inspected = inspectWorkspaceConstraint(ctx.cwd, candidate);
      if (!inspected.allowed) return block(`FFF workspace constraint denied (${"reason" in inspected ? inspected.reason : "policy"}): ${candidate}`);
    }

    if ([
      "read", "grep", "find", "ls",
      "ast_grep_run", "ast_grep_scan", "ast_grep_outline", "ast_grep_debug_query",
      "semantic_nav",
    ].includes(event.toolName) && candidate) {
      if (isSecretPath(candidate)) return block(`Protected secret path cannot be read: ${candidate}`);
      const inspected = inspectWorkspacePath(ctx.cwd, candidate, { mustExist: true });
      if (!inspected.allowed) return block(`Workspace read denied (${"reason" in inspected ? inspected.reason : "policy"}): ${candidate}`);
      if (!("canonical" in inspected)) return block(`Workspace read denied: ${candidate}`);
      if (isSecretPath(inspected.canonical)) return block(`Protected canonical path cannot be read: ${candidate}`);
    }

    if (event.toolName.startsWith("ast_grep_")) {
      const policy = validateAstGrepCall(ctx.cwd, input);
      if (!policy.allowed) return block(`AST workspace policy denied (${"reason" in policy ? policy.reason : "policy"})`);
    }

    if ((event.toolName === "write" || event.toolName === "edit" || event.toolName === "transactional_edit" || event.toolName === "transactional_ast_edit" || event.toolName === "ast_grep_rewrite") && candidate) {
      if (isAlwaysProtectedWritePath(candidate)) {
        return block(`Protected path cannot be modified: ${candidate}`);
      }
      const inspected = inspectWorkspacePath(ctx.cwd, candidate, { mustExist: event.toolName === "edit", forWrite: true });
      if (!inspected.allowed) return block(`Workspace write denied (${"reason" in inspected ? inspected.reason : "policy"}): ${candidate}`);
      if (!("canonical" in inspected)) return block(`Workspace write denied: ${candidate}`);
      if (isAlwaysProtectedWritePath(inspected.canonical)) return block(`Protected canonical path cannot be modified: ${candidate}`);
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const finding = classifyCommand(command);
      if (!finding) return undefined;
      return block(finding.reason);
    }

    if (event.toolName === "subagent") {
      const input = event.input as Record<string, unknown>;
      const policy = validateSubagentCall(input);
      if (!policy.allowed) return block(`${"reason" in policy ? policy.reason : "subagent policy denied"}; use secure_coding_workflow`);
    }

    if (event.toolName === "agent_browser") {
      if (findRuntimeAllocation(ctx.cwd)) return block("Browser runtime isolation denied: autonomous allocations require browser_engine inside the networkless runner");
      const policy = validateAllocatedBrowserCall(event.input, undefined);
      if (!policy.allowed) return block(`Browser runtime isolation denied: ${"reason" in policy ? policy.reason : "policy"}`);
    }

    return undefined;
  });
}

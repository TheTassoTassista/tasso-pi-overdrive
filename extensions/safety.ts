import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRuntimeAllocation } from "../lib/runtime-isolation.mjs";
import {
  classifyCommand,
  inspectWorkspaceConstraint,
  inspectWorkspacePath,
  isAlwaysProtectedWritePath,
  isSecretPath,
  validateSubagentCall,
  validateAllocatedBrowserCall,
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

    if (["ffgrep", "fffind"].includes(event.toolName) && candidate) {
      const inspected = inspectWorkspaceConstraint(ctx.cwd, candidate);
      if (!inspected.allowed) return { block: true, reason: `FFF workspace constraint denied (${"reason" in inspected ? inspected.reason : "policy"}): ${candidate}` };
    }

    if ([
      "read", "grep", "find", "ls",
      "ast_grep_run", "ast_grep_scan", "ast_grep_outline", "ast_grep_debug_query",
      "semantic_nav",
    ].includes(event.toolName) && candidate) {
      if (isSecretPath(candidate)) return { block: true, reason: `Protected secret path cannot be read: ${candidate}` };
      const inspected = inspectWorkspacePath(ctx.cwd, candidate, { mustExist: true });
      if (!inspected.allowed) return { block: true, reason: `Workspace read denied (${"reason" in inspected ? inspected.reason : "policy"}): ${candidate}` };
      if (!("canonical" in inspected)) return { block: true, reason: `Workspace read denied: ${candidate}` };
      if (isSecretPath(inspected.canonical)) return { block: true, reason: `Protected canonical path cannot be read: ${candidate}` };
    }

    if (["ast_grep_scan", "ast_grep_debug_query"].includes(event.toolName) && typeof input.rule_file === "string") {
      const rule = inspectWorkspacePath(ctx.cwd, input.rule_file, { mustExist: true });
      if (!rule.allowed) return { block: true, reason: `AST rule file denied (${"reason" in rule ? rule.reason : "policy"})` };
    }

    if ((event.toolName === "write" || event.toolName === "edit" || event.toolName === "ast_grep_rewrite") && candidate) {
      if (isAlwaysProtectedWritePath(candidate)) {
        return { block: true, reason: `Protected path cannot be modified: ${candidate}` };
      }
      const inspected = inspectWorkspacePath(ctx.cwd, candidate, { mustExist: event.toolName === "edit", forWrite: true });
      if (!inspected.allowed) return { block: true, reason: `Workspace write denied (${"reason" in inspected ? inspected.reason : "policy"}): ${candidate}` };
      if (!("canonical" in inspected)) return { block: true, reason: `Workspace write denied: ${candidate}` };
      if (isAlwaysProtectedWritePath(inspected.canonical)) return { block: true, reason: `Protected canonical path cannot be modified: ${candidate}` };
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const finding = classifyCommand(command);
      if (!finding) return undefined;
      return { block: true, reason: finding.reason };
    }

    if (event.toolName === "subagent") {
      const input = event.input as Record<string, unknown>;
      const policy = validateSubagentCall(input);
      if (!policy.allowed) return { block: true, reason: `${"reason" in policy ? policy.reason : "subagent policy denied"}; use secure_coding_workflow` };
    }

    if (event.toolName === "agent_browser") {
      const policy = validateAllocatedBrowserCall(event.input, findRuntimeAllocation(ctx.cwd));
      if (!policy.allowed) return { block: true, reason: `Browser runtime isolation denied: ${"reason" in policy ? policy.reason : "policy"}` };
    }

    return undefined;
  });
}

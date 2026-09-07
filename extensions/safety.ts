import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  classifyCommand,
  isAlwaysProtectedWritePath,
  isInside,
  isSecretPath,
  resolveToolPath,
} from "../lib/safety.mjs";

function inputPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const candidate = inputPath(event.input);

    if ((event.toolName === "read" || event.toolName === "grep") && candidate && isSecretPath(candidate)) {
      return { block: true, reason: `Protected secret path cannot be read: ${candidate}` };
    }

    if ((event.toolName === "write" || event.toolName === "edit") && candidate) {
      const resolved = resolveToolPath(ctx.cwd, candidate);
      if (isAlwaysProtectedWritePath(candidate)) {
        return { block: true, reason: `Protected path cannot be modified: ${candidate}` };
      }
      if (resolved && !isInside(ctx.cwd, resolved)) {
        if (!ctx.hasUI) return { block: true, reason: `Write outside the active workspace blocked: ${candidate}` };
        const approved = await ctx.ui.confirm("Write outside workspace?", `${resolved}\n\nAllow this one operation?`);
        if (!approved) return { block: true, reason: "Write outside workspace declined" };
      }
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const finding = classifyCommand(command);
      if (!finding) return undefined;
      if (finding.level === "block") return { block: true, reason: finding.reason };
      if (!ctx.hasUI) return { block: true, reason: `${finding.reason} blocked without interactive confirmation` };
      const approved = await ctx.ui.confirm("Potentially destructive command", `${finding.reason}\n\n${command}\n\nAllow this one command?`);
      if (!approved) return { block: true, reason: `${finding.reason} declined` };
    }

    return undefined;
  });
}

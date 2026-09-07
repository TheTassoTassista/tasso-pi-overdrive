import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactToolText } from "../lib/output-optimizer.mjs";

interface OptimizerStats {
  calls: number;
  inputLines: number;
  outputLines: number;
}

export default function (pi: ExtensionAPI) {
  const stats: OptimizerStats = { calls: 0, inputLines: 0, outputLines: 0 };

  pi.on("tool_result", async (event) => {
    if (event.isError || event.toolName !== "bash") return undefined;
    let changed = false;
    const content = event.content.map((block) => {
      if (block.type !== "text") return block;
      const compacted = compactToolText(block.text);
      if (!compacted.compacted) return block;
      changed = true;
      stats.calls += 1;
      stats.inputLines += compacted.originalLines;
      stats.outputLines += compacted.outputLines;
      return { ...block, text: compacted.text };
    });
    return changed ? { content } : undefined;
  });

  pi.registerCommand("output-stats", {
    description: "Show this session's deterministic tool-output compaction statistics",
    handler: async (_args, ctx) => {
      const saved = stats.inputLines - stats.outputLines;
      ctx.ui.notify(`Output optimizer: ${stats.calls} result(s), ${saved.toLocaleString()} line(s) omitted`, "info");
    },
  });
}

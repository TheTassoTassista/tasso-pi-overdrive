import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const names = [
  "ffgrep", "fffind", "ast_grep_run", "ast_grep_scan", "ast_grep_outline", "ast_grep_debug_query", "transactional_ast_edit", "ast_grep_rewrite",
  "transactional_edit", "semantic_nav", "task_notebook", "verification_gate", "secure_coding_workflow", "debug_engine", "persistent_python", "persistent_javascript", "agent_browser", "web_research", "safe_web_fetch",
  "resource_fs", "smart_read", "safe_exec", "mcp", "subagent", "safe_remove_file", "third_party_unknown",
];

export default function registerToolGovernorFixtures(pi: ExtensionAPI): void {
  for (const name of names) {
    pi.registerTool({
      name,
      label: `Deterministic ${name} fixture`,
      description: `Non-executing schema fixture for measuring Tool Governor visibility of ${name}.`,
      parameters: Type.Object({
        path: Type.Optional(Type.String({ maxLength: 2048, description: "Workspace-relative fixture path" })),
        query: Type.Optional(Type.String({ maxLength: 1000, description: "Bounded fixture query" })),
        operation: Type.Optional(Type.String({ maxLength: 64, description: "Fixture operation selector" })),
      }),
      async execute() {
        return { content: [{ type: "text", text: "fixture" }], details: { fixture: true } };
      },
    });
  }
}

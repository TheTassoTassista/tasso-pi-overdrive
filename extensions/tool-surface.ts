import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CORE_TOOLS = Object.freeze([
  "read",
  "edit",
  "write",
  "secure_coding_workflow",
  "task_notebook",
  "verification_gate",
]);

const TOOL_FLAGS = new Set(["--tools", "-t", "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--exclude-tools", "-xt"]);

export function selectInitialToolSurface(active: string[], available: string[], argv: string[]): string[] {
  if (argv.some((argument) => TOOL_FLAGS.has(argument))) return active;
  const known = new Set(available);
  return CORE_TOOLS.filter((name) => known.has(name));
}

export default function toolSurface(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const available = pi.getAllTools().map((tool) => tool.name);
    pi.setActiveTools(selectInitialToolSurface(active, available, process.argv.slice(2)));
  });
}

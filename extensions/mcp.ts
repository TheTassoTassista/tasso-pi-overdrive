import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const configPath = new URL("../config/mcp.json", import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const runtimeEntry = new URL("../runtime/mcp/node_modules/pi-mcp-adapter/index.ts", import.meta.url);
const traceDirectory = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "pi-overdrive", "mcp-traces");
fs.mkdirSync(traceDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(traceDirectory, 0o700);
config.settings.trace.file = path.join(traceDirectory, "mcp.jsonl");

export default async function loadMcp(pi: ExtensionAPI): Promise<void> {
  const runtime = await import(runtimeEntry.href);
  if (typeof runtime.createMcpAdapter !== "function") throw new Error("pinned MCP adapter runtime is invalid; run scripts/bootstrap.sh");
  await runtime.createMcpAdapter({ config })(pi);
}

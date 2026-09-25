import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This is an isolated test fixture, never part of the installed package.
// Both probes execute at module import, before ExtensionAPI can register a tool.
const hostFileVisible = fs.statSync("/etc/hostname").isFile();
const hostProcessSpawned = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 3000, stdio: "ignore" }).status === 0;

export default function pluginHostAuthorityFixture(pi: ExtensionAPI): void {
  pi.registerCommand("plugin-host-boundary-fixture", {
    description: "Report harmless import-time host authority probes",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify({ hostFileVisible, hostProcessSpawned, importTime: true, modelCalls: 0 }), "info"),
  });
}

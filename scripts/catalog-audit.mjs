#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || "pi";
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });

const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc"], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
let stderr = "";
let response;
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/u, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "response" && event.id === "catalog") response = event;
    } catch {}
  }
});
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-6000); });
child.stdin.write(`${JSON.stringify({ id: "catalog", type: "get_commands" })}\n`);
const deadline = Date.now() + 30000;
while (!response && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
child.stdin.end();
await new Promise((resolve) => {
  const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 3000);
  child.once("close", () => { clearTimeout(timer); resolve(); });
});

if (!response?.success) {
  check("pi-command-catalog", false, stderr || "missing RPC response");
} else {
  const commands = response.data?.commands ?? [];
  const expectedPrompts = fs.readdirSync(path.join(root, "prompts")).filter((name) => name.endsWith(".md")).map((name) => path.basename(name, ".md")).sort();
  const expectedSkills = fs.readdirSync(path.join(root, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `skill:${entry.name}`).sort();
  const expectedExtensionCommands = [];
  for (const file of fs.readdirSync(path.join(root, "extensions")).filter((name) => name.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(root, "extensions", file), "utf8");
    for (const match of source.matchAll(/registerCommand\(["']([^"']+)["']/gu)) expectedExtensionCommands.push(match[1]);
  }
  const sourcePath = (entry) => entry.sourceInfo?.path;
  const promptCommands = commands.filter((entry) => entry.source === "prompt" && sourcePath(entry)?.startsWith(`${root}${path.sep}`));
  const skillCommands = commands.filter((entry) => entry.source === "skill" && sourcePath(entry)?.startsWith(`${root}${path.sep}`));
  const extensionCommands = commands.filter((entry) => entry.source === "extension" && sourcePath(entry)?.startsWith(`${root}${path.sep}`));
  check("pi-command-catalog", true, { total: commands.length });
  check("dynamic-prompt-discovery", expectedPrompts.every((name) => promptCommands.some((entry) => entry.name === name)) && promptCommands.length === expectedPrompts.length, { expected: expectedPrompts, loaded: promptCommands.map((entry) => entry.name).sort() });
  check("dynamic-skill-discovery", expectedSkills.every((name) => skillCommands.some((entry) => entry.name === name)) && skillCommands.length === expectedSkills.length, { expected: expectedSkills, loaded: skillCommands.map((entry) => entry.name).sort() });
  check("custom-extension-slash-commands", expectedExtensionCommands.every((name) => extensionCommands.some((entry) => entry.name === name)), { expected: expectedExtensionCommands.sort(), loaded: extensionCommands.map((entry) => entry.name).sort() });
  check("catalog-uses-stable-package", [...promptCommands, ...skillCommands, ...extensionCommands].every((entry) => sourcePath(entry)?.startsWith(`${root}${path.sep}`)), root);
}

const status = results.length >= 5 && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);

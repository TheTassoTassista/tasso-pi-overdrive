import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, readPrivateJson, safeRelativeMemoryPath, writePrivateJsonAtomic } from "./memory-security.mjs";

function parseScalar(value) {
  const text = value.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith("[") && text.endsWith("]")) return text.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
  return text.replace(/^['"]|['"]$/gu, "");
}

export function parseMemoryNote(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(text);
  if (!match) return undefined;
  const metadata = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/u.exec(line);
    if (pair) metadata[pair[1]] = parseScalar(pair[2]);
  }
  return { metadata, body: match[2].trim() };
}

function markdownFiles(root) {
  const output = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error("obsidian_symlink_rejected");
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile() && entry.name.endsWith(".md")) output.push(candidate);
    }
  };
  walk(root);
  return output;
}

export function syncObsidianVault({ vaultRoot, projectId, ledger, publishResource } = {}) {
  const root = ensurePrivateDirectory(vaultRoot);
  const indexFile = path.join(path.dirname(root), "obsidian-sync-index.json");
  const index = readPrivateJson(indexFile, { version: 1, files: {} });
  if (index.version !== 1 || typeof index.files !== "object") throw new Error("obsidian_sync_index_invalid");
  const result = { scanned: 0, changed: 0, accepted: 0, rejected: 0, published: 0, publishFailed: 0 };
  for (const file of markdownFiles(root)) {
    result.scanned += 1;
    const relative = safeRelativeMemoryPath(path.relative(root, file));
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("obsidian_note_unsafe");
      const signature = `${stat.mtimeMs}:${stat.size}`;
      if (index.files[relative] === signature) continue;
      const parsed = parseMemoryNote(fs.readFileSync(descriptor, "utf8"));
      if (!parsed?.metadata.memory || !parsed.body) continue;
      result.changed += 1;
      const declaredTrust = ["USER", "PROJECT_DOC", "EXTERNAL"].includes(parsed.metadata.trust) ? parsed.metadata.trust : "PROJECT_DOC";
      const accepted = ledger.accept({
        type: parsed.metadata.type ?? "resource",
        project: projectId,
        scope: "project",
        content: `${parsed.metadata.title ?? path.basename(file, ".md")}: ${parsed.body}`,
        source: `obsidian:${relative}`,
        sourceType: "obsidian_note",
        trustLevel: declaredTrust,
        confidence: parsed.metadata.verified === true ? 1 : 0.8,
        verified: parsed.metadata.verified === true,
        importance: parsed.metadata.importance ?? "medium",
        retentionDays: parsed.metadata.retentionDays ?? 365,
        tags: Array.isArray(parsed.metadata.tags) ? parsed.metadata.tags : ["obsidian"],
        reason: "Human-authored Obsidian note explicitly marked memory=true",
      });
      if (accepted.status === "ACCEPTED") result.accepted += 1;
      else result.rejected += 1;
      if (publishResource && accepted.status === "ACCEPTED") {
        try { publishResource(file, relative); result.published += 1; } catch { result.publishFailed += 1; }
      }
      index.files[relative] = signature;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  writePrivateJsonAtomic(indexFile, index);
  return result;
}

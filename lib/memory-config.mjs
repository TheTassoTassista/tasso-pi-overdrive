import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultMemoryRoot, safeMemoryId } from "./memory-security.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SECOND_BRAIN_CONFIG_FILE = path.join(packageRoot, "config", "second-brain.json");

function loopbackEndpoint(value, label) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error(`${label}_must_be_loopback_http`);
  parsed.pathname = parsed.pathname.replace(/\/$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

function readSmallNoFollow(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    return fs.readFileSync(descriptor, "utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function repositoryIdentity(canonicalCwd) {
  let cursor = canonicalCwd;
  while (true) {
    const marker = path.join(cursor, ".git");
    try {
      const stat = fs.lstatSync(marker);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const common = fs.realpathSync(marker);
        return { name: path.basename(cursor), key: `git-common-dir:${common}` };
      }
      if (stat.isFile() && !stat.isSymbolicLink()) {
        const pointer = /^gitdir:\s*(.+)\s*$/imu.exec(readSmallNoFollow(marker) ?? "")?.[1];
        if (pointer) {
          const gitDirectory = fs.realpathSync(path.resolve(cursor, pointer));
          const commonPointer = readSmallNoFollow(path.join(gitDirectory, "commondir"))?.trim();
          const common = fs.realpathSync(commonPointer ? path.resolve(gitDirectory, commonPointer) : gitDirectory);
          return { name: path.basename(path.dirname(common)), key: `git-common-dir:${common}` };
        }
      }
    } catch {}
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { name: path.basename(canonicalCwd), key: `directory:${canonicalCwd}` };
}

export function deriveProjectIdentity(cwd) {
  const canonical = fs.realpathSync(cwd);
  const identity = repositoryIdentity(canonical);
  const slug = identity.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "project";
  const digest = createHash("sha256").update(identity.key).digest("hex").slice(0, 12);
  return safeMemoryId(`${slug}-${digest}`, "project_id");
}

export function readSecondBrainConfig(options = {}) {
  const source = options.file ?? SECOND_BRAIN_CONFIG_FILE;
  const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  if (parsed.version !== 1 || parsed.enabled !== true) throw new Error("second_brain_config_invalid");
  const environment = options.environment ?? process.env;
  const root = path.resolve(options.root ?? environment.PI_OVERDRIVE_MEMORY_ROOT ?? defaultMemoryRoot(environment));
  const openVikingEndpoint = loopbackEndpoint(environment.PI_OVERDRIVE_OPENVIKING_URL ?? parsed.openViking.endpoint, "openviking_endpoint");
  const hindsightEndpoint = loopbackEndpoint(environment.PI_OVERDRIVE_HINDSIGHT_URL ?? parsed.hindsight.endpoint, "hindsight_endpoint");
  return Object.freeze({
    ...parsed,
    root,
    vaultRoot: path.resolve(options.vaultRoot ?? environment.PI_OVERDRIVE_VAULT_ROOT ?? path.join(root, "vault", "SecondBrain")),
    openViking: Object.freeze({ ...parsed.openViking, endpoint: openVikingEndpoint }),
    hindsight: Object.freeze({ ...parsed.hindsight, endpoint: hindsightEndpoint }),
  });
}

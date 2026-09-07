import path from "node:path";

const SECRET_BASENAMES = new Set([
  ".env",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ed25519",
  "id_ecdsa",
  "id_rsa",
  "known_hosts",
  "netrc",
]);

const SECRET_SEGMENTS = new Set([
  ".aws",
  ".gnupg",
  ".password-store",
  ".ssh",
  "browser-data",
  "keyrings",
]);

const ALWAYS_PROTECTED_WRITE_SEGMENTS = new Set([".git", "node_modules"]);

export function resolveToolPath(cwd, candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") return undefined;
  return path.resolve(cwd, candidate);
}

export function isSecretPath(candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  const normalized = path.normalize(candidate);
  const parts = normalized.split(path.sep).filter(Boolean);
  const base = path.basename(normalized).toLowerCase();
  if (SECRET_BASENAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  if (/\.(pem|p12|pfx|key)$/iu.test(base)) return true;
  return parts.some((part) => SECRET_SEGMENTS.has(part.toLowerCase()));
}

export function isAlwaysProtectedWritePath(candidate) {
  if (isSecretPath(candidate)) return true;
  const parts = path.normalize(candidate).split(path.sep).filter(Boolean);
  return parts.some((part) => ALWAYS_PROTECTED_WRITE_SEGMENTS.has(part));
}

export function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

const CRITICAL_COMMANDS = [
  { pattern: /(^|[;&|]\s*)rm\s+[^\n]*(?:-r[^\s]*|-f[^\s]*r|--recursive)/iu, reason: "recursive removal" },
  { pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f)/iu, reason: "destructive Git cleanup" },
  { pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs|fdisk|parted)\b/iu, reason: "disk or filesystem modification" },
  { pattern: /\bdd\b[^\n]*\bof=\s*\/dev\//iu, reason: "raw device write" },
  { pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/iu, reason: "system shutdown" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/u, reason: "fork bomb" },
  { pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|fi)?sh\b/iu, reason: "download piped to a shell" },
];

const CONFIRM_COMMANDS = [
  { pattern: /\bsudo\b/iu, reason: "privileged command" },
  { pattern: /\b(?:chmod|chown)\s+(?:-[^\s]+\s+)*-?R\b/iu, reason: "recursive permission change" },
  { pattern: /\b(?:pacman|apt|dnf|zypper)\s+[^\n]*(?:-R|remove|purge)\b/iu, reason: "system package removal" },
  { pattern: /\bgit\s+push\b[^\n]*(?:--force|-f)\b/iu, reason: "forced Git push" },
];

const SECRET_READ_COMMAND = /\b(?:cat|head|tail|less|more|sed|awk|grep|rg|strings|base64)\b[^\n]*(?:\.env(?:\.[^\s'"]+)?|auth\.json|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.ssh\/|\.gnupg\/|\.(?:pem|p12|pfx|key)\b)/iu;

export function classifyCommand(command) {
  if (typeof command !== "string") return undefined;
  if (SECRET_READ_COMMAND.test(command)) return { level: "block", reason: "attempt to read a protected secret path" };
  for (const rule of CRITICAL_COMMANDS) {
    if (rule.pattern.test(command)) return { level: "confirm", reason: rule.reason };
  }
  for (const rule of CONFIRM_COMMANDS) {
    if (rule.pattern.test(command)) return { level: "confirm", reason: rule.reason };
  }
  return undefined;
}

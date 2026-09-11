#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs";
import { finished } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promoteManagedRuntime, recoverManagedRuntime } from "../lib/managed-runtime-transaction.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = path.join(packageRoot, "config", "managed-lsp.json");
const manifestText = fs.readFileSync(manifestFile, "utf8");
const manifest = JSON.parse(manifestText);
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const runtimeIndex = args.indexOf("--runtime");
if (args.some((value, index) => value !== "--check" && value !== "--runtime" && index !== runtimeIndex + 1) || (runtimeIndex >= 0 && !args[runtimeIndex + 1])) {
  process.stderr.write("usage: install-managed-lsp.mjs [--check] [--runtime DIRECTORY]\n");
  process.exit(2);
}
const runtimeRoot = path.resolve(runtimeIndex >= 0 ? args[runtimeIndex + 1] : process.env.PI_OVERDRIVE_LSP_RUNTIME ?? path.join(packageRoot, "runtime", "lsp"));
const managedRoot = path.join(runtimeRoot, "managed");
const downloadRoot = path.resolve(process.env.PI_OVERDRIVE_DOWNLOAD_CACHE ?? path.join(runtimeRoot, "download-cache"));
const manifestDigest = createHash("sha256").update(manifestText).digest("hex");

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.status}`;
    throw new Error(`${command} failed: ${Buffer.isBuffer(detail) ? detail.toString("utf8").trim() : String(detail).trim()}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : result.stdout.trim();
}

function removeTree(directory) {
  if (!fs.existsSync(directory)) return;
  spawnSync("chmod", ["-R", "u+w", directory], { stdio: "ignore" });
  fs.rmSync(directory, { recursive: true, force: true });
}

function syncTree(directory) {
  const directories = [];
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("managed_lsp_symlink_rejected");
    if (stat.isDirectory()) {
      directories.push(current);
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
      return;
    }
    if (stat.isFile()) {
      const descriptor = fs.openSync(current, "r");
      try { fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    }
  };
  visit(directory);
  for (const current of directories.reverse()) {
    const descriptor = fs.openSync(current, "r");
    try { fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  }
}

function validateArchive(file, mode) {
  const listing = run("tar", [mode, file]).split("\n").filter(Boolean);
  if (!listing.length || listing.some((entry) => path.posix.isAbsolute(entry) || entry.split("/").includes(".."))) throw new Error("managed_lsp_archive_path_rejected");
}

async function download(url, checksum, name) {
  fs.mkdirSync(downloadRoot, { recursive: true, mode: 0o700 });
  const target = path.join(downloadRoot, name);
  if (fs.existsSync(target) && sha256(target) === checksum) return target;
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`download_failed:${response.status}`);
    await finished(Readable.fromWeb(response.body).pipe(createWriteStream(temporary, { flags: "wx", mode: 0o600 })));
    if (sha256(temporary) !== checksum) throw new Error(`checksum_mismatch:${name}`);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    return target;
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function inspectManaged(root = managedRoot) {
  const rustAnalyzer = path.join(root, "bin", "rust-analyzer");
  const gopls = path.join(root, "bin", "gopls");
  const go = path.join(root, "go", "bin", "go");
  const rustSource = path.join(root, "rust-src", "lib", "rustlib", "src", "rust", "library", "core", "src", "lib.rs");
  const recordFile = path.join(root, "install-record.json");
  const errors = [];
  for (const file of [rustAnalyzer, gopls, go, rustSource, recordFile]) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) errors.push(`invalid:${file}`);
    } catch { errors.push(`missing:${file}`); }
  }
  if (!errors.length) {
    if (sha256(rustAnalyzer) !== manifest.rustAnalyzer.binarySha256) errors.push("rust_analyzer_binary_hash");
    if (sha256(go) !== manifest.go.binarySha256) errors.push("go_binary_hash");
    if (sha256(gopls) !== manifest.gopls.binarySha256) errors.push("gopls_binary_hash");
    const rustVersion = run(rustAnalyzer, ["--version"]);
    if (rustVersion !== `rust-analyzer ${manifest.rustAnalyzer.version}`) errors.push("rust_analyzer_version");
    const goVersion = run(go, ["version"]);
    if (!goVersion.includes(`go${manifest.go.version} `)) errors.push("go_version");
    const goplsVersion = run(gopls, ["version"]);
    if (!goplsVersion.includes(manifest.gopls.version)) errors.push("gopls_version");
    const buildInfo = run(go, ["version", "-m", gopls]);
    if (!buildInfo.includes(`mod\tgolang.org/x/tools/gopls\t${manifest.gopls.version}\t${manifest.gopls.moduleSum}`)) errors.push("gopls_module_identity");
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    if (record.version !== 1 || record.manifestDigest !== manifestDigest) errors.push("install_record_digest");
  }
  return {
    status: errors.length ? "FAIL" : "PASS",
    runtimeRoot,
    manifestDigest,
    rustAnalyzer: { version: manifest.rustAnalyzer.version, path: rustAnalyzer, source: manifest.rustAnalyzer.provenance },
    rustSource: { version: manifest.rustSource.version, path: path.dirname(rustSource), source: manifest.rustSource.provenance },
    gopls: { version: manifest.gopls.version, path: gopls, source: manifest.gopls.provenance },
    go: { version: manifest.go.version, path: go, source: manifest.go.provenance },
    errors,
  };
}

if (checkOnly) {
  const result = inspectManaged();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === "PASS" ? 0 : 1);
}

fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
recoverManagedRuntime({ runtimeRoot, inspect: inspectManaged, removeTree });
const current = inspectManaged();
if (current.status === "PASS") {
  process.stdout.write(`${JSON.stringify({ ...current, installed: false }, null, 2)}\n`);
  process.exit(0);
}

const staging = fs.mkdtempSync(path.join(runtimeRoot, ".managed-install-"));
try {
  fs.mkdirSync(path.join(staging, "bin"), { recursive: true, mode: 0o755 });

  const rustArchive = await download(manifest.rustAnalyzer.url, manifest.rustAnalyzer.archiveSha256, `rust-analyzer-${manifest.rustAnalyzer.release}.gz`);
  const rustBinary = path.join(staging, "bin", "rust-analyzer");
  const decompressed = run("gzip", ["-dc", rustArchive], { encoding: null, maxBuffer: 256 * 1024 * 1024 });
  fs.writeFileSync(rustBinary, decompressed, { mode: 0o755 });
  if (sha256(rustBinary) !== manifest.rustAnalyzer.binarySha256) throw new Error("rust_analyzer_binary_checksum_mismatch");

  const rustSourceArchive = await download(manifest.rustSource.url, manifest.rustSource.archiveSha256, `rust-src-${manifest.rustSource.version}.tar.xz`);
  validateArchive(rustSourceArchive, "-tJf");
  const rustExtract = path.join(staging, "rust-source-extract");
  fs.mkdirSync(rustExtract);
  run("tar", ["-xJf", rustSourceArchive, "-C", rustExtract]);
  fs.renameSync(path.join(rustExtract, `rust-src-${manifest.rustSource.version}`, "rust-src"), path.join(staging, "rust-src"));
  fs.rmSync(rustExtract, { recursive: true, force: true });

  const goArchive = await download(manifest.go.url, manifest.go.archiveSha256, `go${manifest.go.version}.linux-amd64.tar.gz`);
  validateArchive(goArchive, "-tzf");
  run("tar", ["-xzf", goArchive, "-C", staging]);
  const managedGo = path.join(staging, "go", "bin", "go");
  if (sha256(managedGo) !== manifest.go.binarySha256) throw new Error("go_binary_checksum_mismatch");
  const buildHome = path.join(staging, "build-home");
  const goPath = path.join(staging, "build-gopath");
  const goCache = path.join(staging, "build-cache");
  fs.mkdirSync(buildHome, { recursive: true, mode: 0o700 });
  const goBuildEnvironment = {
    ...process.env,
    HOME: buildHome,
    GOBIN: path.join(staging, "bin"),
    GOPATH: goPath,
    GOMODCACHE: path.join(goPath, "pkg", "mod"),
    GOCACHE: goCache,
    GOTOOLCHAIN: "local",
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
    GOPRIVATE: "",
    GONOPROXY: "",
    GONOSUMDB: "",
    GOENV: "off",
    GOFLAGS: "-trimpath -buildvcs=false",
    CGO_ENABLED: "0",
  };
  const downloadedModule = JSON.parse(run(managedGo, ["mod", "download", "-json", manifest.gopls.module], { env: goBuildEnvironment, timeout: 20 * 60 * 1000 }));
  if (downloadedModule.Sum !== manifest.gopls.moduleSum || downloadedModule.GoModSum !== manifest.gopls.goModSum) throw new Error("gopls_module_checksum_mismatch");
  if (downloadedModule.Origin?.Hash !== manifest.gopls.sourceCommit) throw new Error("gopls_source_commit_mismatch");
  run(managedGo, ["install", manifest.gopls.module], { env: goBuildEnvironment, timeout: 20 * 60 * 1000 });
  if (sha256(path.join(staging, "bin", "gopls")) !== manifest.gopls.binarySha256) throw new Error("gopls_binary_checksum_mismatch");
  removeTree(buildHome);
  removeTree(goPath);
  removeTree(goCache);

  fs.writeFileSync(path.join(staging, "install-record.json"), `${JSON.stringify({
    version: 1,
    manifestDigest,
    installedAt: new Date().toISOString(),
    rustAnalyzerBinarySha256: sha256(rustBinary),
    goplsBinarySha256: sha256(path.join(staging, "bin", "gopls")),
  }, null, 2)}\n`, { mode: 0o600 });

  syncTree(staging);
  promoteManagedRuntime({ runtimeRoot, stagingRoot: staging, inspect: inspectManaged, removeTree });
  const result = inspectManaged();
  process.stdout.write(`${JSON.stringify({ ...result, installed: true }, null, 2)}\n`);
} catch (error) {
  if (fs.existsSync(staging)) removeTree(staging);
  throw error;
}

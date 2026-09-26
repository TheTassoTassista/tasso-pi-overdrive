import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findRuntimeAllocation } from "../lib/runtime-isolation.mjs";
import { inspectWorkspacePath, removeVerifiedWorkspaceFile } from "../lib/safety.mjs";
import { requireCodingBackend, sandboxInvocation } from "../platform/shared/coding-execution.mjs";

const PROGRAMS = ["git", "rg", "fd", "jq", "node", "npm", "pnpm", "python", "python3", "pytest", "pyright", "cargo", "go", "cmake", "ctest", "make", "gcc", "g++"] as const;
const READ_ONLY_GIT = new Set(["status", "diff", "show", "log", "rev-parse", "ls-files", "branch"]);
const READ_ONLY_PROGRAMS = new Set(["rg", "fd", "jq"]);

const Params = Type.Object({
  program: Type.Union(PROGRAMS.map((value) => Type.Literal(value))),
  args: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 128, default: [] })),
  cwd: Type.Optional(Type.String({ maxLength: 1024, description: "Workspace-relative directory" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 900000, default: 120000 })),
});

const RemoveParams = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1024, description: "Workspace-relative regular file" }),
});

function isReadOnly(program: string, args: string[]) {
  if (READ_ONLY_PROGRAMS.has(program)) return true;
  if (program !== "git") return false;
  const first = args.find((arg) => !arg.startsWith("-"));
  return first !== undefined && READ_ONLY_GIT.has(first);
}

function validateArguments(program: string, args: string[]) {
  if (program === "git" && !isReadOnly(program, args)) return "Only read-only Git subcommands are allowed.";
  if (program === "node" && args.some((arg) => ["-e", "--eval", "-p", "--print", "-i", "--interactive"].includes(arg))) {
    return "Inline or interactive Node execution is disabled; run a repository file or package script.";
  }
  if ((program === "python" || program === "python3") && args.some((arg) => arg === "-c")) {
    return "Inline Python execution is disabled; run a repository file, module, or test runner.";
  }
  if ((program === "npm" || program === "pnpm") && args.some((arg) => ["exec", "x", "dlx"].includes(arg))) {
    return "Ad-hoc package execution is disabled; use pinned repository scripts.";
  }
  if (program === "fd" && args.some((arg) => ["-x", "-X", "--exec", "--exec-batch"].includes(arg) || arg.startsWith("--exec="))) {
    return "fd execution hooks are disabled.";
  }
  if (program === "rg" && args.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) {
    return "ripgrep preprocessor execution is disabled.";
  }
  if (program === "git" && args.some((arg) => ["--ext-diff", "--textconv"].includes(arg))) {
    return "Git external diff/text conversion hooks are disabled.";
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "safe_remove_file",
    label: "Remove worktree file",
    description: "Remove one regular, single-linked file from an Overdrive-managed disposable worktree. Directories, symlinks, secrets, .git, and paths outside the worktree are denied.",
    parameters: RemoveParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      requireCodingBackend("safe-remove");
      const allocation = findRuntimeAllocation(ctx.cwd);
      if (!allocation) throw new Error("File removal requires an Overdrive-managed worktree allocation.");
      removeVerifiedWorkspaceFile(ctx.cwd, params.path);
      return { content: [{ type: "text", text: `Removed ${params.path}` }], details: { removed: true, sandboxedWorktree: true } };
    },
  });

  pi.registerTool({
    name: "safe_exec",
    label: "Sandboxed command",
    description: "Run an argument-vector command in Bubblewrap with no network or host home. Mutating/executable commands require an Overdrive-managed disposable worktree. Shell strings are not accepted.",
    parameters: Params,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      requireCodingBackend("safe-exec");
      const args = params.args ?? [];
      if (args.some((arg) => arg.includes("\0"))) {
        throw new Error("NUL bytes are not allowed in arguments");
      }
      const argumentDenial = validateArguments(params.program, args);
      if (argumentDenial) throw new Error(argumentDenial);
      const requestedCwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
      const inspected = inspectWorkspacePath(ctx.cwd, requestedCwd, { mustExist: true });
      if (!inspected.allowed) {
        throw new Error(`Sandbox cwd denied: ${"reason" in inspected ? inspected.reason : "policy"}`);
      }
      if (!("stat" in inspected) || !inspected.stat?.isDirectory()) {
        throw new Error("Sandbox cwd denied: not a directory");
      }
      const allocation = findRuntimeAllocation(ctx.cwd);
      if (!allocation && !isReadOnly(params.program, args)) {
        throw new Error("Executable or mutating safe_exec calls require an Overdrive-managed worktree allocation.");
      }
      const relative = path.relative(inspected.workspace, inspected.canonical) || ".";
      const sandboxArgs = [
        ...(allocation ? [
          "--runtime-state", allocation.stateDir,
          "--browser-profile", allocation.browserProfile,
          "--port", String(allocation.port),
          "--database", allocation.database,
          "--schema", allocation.schema,
        ] : []),
        ...(isReadOnly(params.program, args) ? ["--workspace-read-only"] : []),
        inspected.workspace,
        "--cwd", relative,
        "--",
        params.program,
        ...args,
      ];
      const invocation = sandboxInvocation("safe-exec", sandboxArgs);
      const result = await pi.exec(invocation.command, [...invocation.args], { cwd: inspected.workspace, ...(signal ? { signal } : {}), timeout: params.timeoutMs ?? 120000 });
      const output = `${result.stdout}${result.stderr}`.trim() || `[exit ${result.code}]`;
      if (result.code !== 0) throw new Error(`Sandboxed command failed with exit ${result.code}: ${output}`);
      return {
        content: [{ type: "text", text: output }],
        details: {
          sandboxed: true,
          network: false,
          exitCode: result.code,
          allocationId: allocation?.allocationId,
          worktree: allocation?.worktree,
          port: allocation?.port,
          stateDir: allocation?.stateDir,
          browserProfile: allocation?.browserProfile,
          database: allocation?.database,
          schema: allocation?.schema,
        },
      };
    },
  });
}

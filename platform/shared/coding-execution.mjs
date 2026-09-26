import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformAdapter } from '../index.mjs';

// Production plumbing, not native certification. Only code-owned capabilities
// may select an adapter. Neither model input nor an environment variable can
// choose the host platform, enable Windows, or substitute the trusted Job runner.
const OPERATIONS = Object.freeze({
  workflow: 'orchestration',
  verification: 'verification',
  'safe-exec': 'command',
  lsp: 'language-server',
  debug: 'debug-adapter',
  eval: 'eval-kernel',
  'edit-engine': 'transactional-filesystem',
  'safe-remove': 'workspace-filesystem',
});
const linuxRunner = fileURLToPath(new URL('../../scripts/sandbox-run.sh', import.meta.url));

function denied(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function requireCodingBackend(operation) {
  if (typeof operation !== 'string' || !Object.hasOwn(OPERATIONS, operation)) denied('PHI_CODING_OPERATION_INVALID');
  const adapter = platformAdapter();
  // Do not infer production readiness from a working fixed LPAC probe or Job.
  if (!adapter.sandbox.implemented || !adapter.sandbox.autonomousReady) denied('PHI_CODING_BACKEND_UNAVAILABLE');
  if (adapter.id !== 'linux') denied('PHI_CODING_BACKEND_UNAVAILABLE');
  return Object.freeze({ platform: adapter.id, backend: adapter.sandbox.id, operation, capability: OPERATIONS[operation] });
}

export function sandboxInvocation(operation, args, options = {}) {
  const backend = requireCodingBackend(operation); // before any caller override
  if (!['safe-exec', 'lsp', 'debug', 'eval', 'verification'].includes(operation)) denied('PHI_CODING_OPERATION_INVALID');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) denied('PHI_CODING_ARGUMENTS_INVALID');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'runner')) denied('PHI_CODING_OPTIONS_INVALID');
  // Existing controller-only Linux LSP failure fixture. This is not a tool
  // schema field and cannot bypass the Windows gate above.
  if (options.runner !== undefined && operation !== 'lsp') denied('PHI_CODING_OPTIONS_INVALID');
  const command = options.runner ?? linuxRunner;
  if (typeof command !== 'string' || !path.isAbsolute(command) || command.includes('\0')) denied('PHI_CODING_RUNNER_INVALID');
  return Object.freeze({ ...backend, command, args: Object.freeze([...args]), shell: false });
}

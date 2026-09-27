import { executeCodingTool } from './coding-execution.mjs';
import { windowsWorkerAuthority } from '../../lib/phi-worker-authority.mjs';

// Actual Windows branch of the registered safe_exec tool, importable by the
// source-only native gate without emulating Pi's virtual schema loader.
export async function executeBrokeredSafeExec(params, ctx, signal, emitMetadata) {
  if (!params || Object.keys(params).some((key) => !['program', 'args', 'cwd', 'timeoutMs'].includes(key))) throw new Error('PHI_TOOL_REQUEST_INVALID');
  if (params.cwd && params.cwd !== '.') throw new Error('PHI_TOOL_CWD_UNSUPPORTED');
  const sessionId = ctx.sessionManager.getSessionId();
  const authority = windowsWorkerAuthority(sessionId);
  const result = await executeCodingTool({
    program: params.program, args: params.args ?? [], cwd: ctx.cwd, timeoutMs: params.timeoutMs ?? 120000,
  }, { operation: 'safe-exec', sessionId, signal, ...(authority ? { workerAuthority: authority } : {}) });
  emitMetadata?.(result.metadata);
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (result.code !== 0) {
    const error = new Error(result.metadata.failureReason + ': ' + JSON.stringify(result.metadata) + '\n' + output);
    error.code = result.metadata.failureReason;
    error.receipt = result.metadata;
    throw error;
  }
  return { content: [{ type: /** @type {"text"} */ ('text'), text: output.trim() || '[exit ' + result.code + ']' }],
    details: { sandboxed: true, network: false, receipt: result.metadata, lspOnWritePaths: result.lspOnWritePaths ?? [] } };
}

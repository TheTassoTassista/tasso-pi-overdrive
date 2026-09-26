import { spawn } from 'node:child_process';

export function processBackendStatus() {
  return { id: 'exec-and-posix-groups', available: typeof process.execve === 'function', scope: 'trusted ownership; sandbox separate', evidence: 'runtime API presence only; not a live cleanup probe' };
}

export function execEngine(command, args, env = process.env) {
  if (typeof process.execve !== 'function') throw new Error('PHI_EXEC_BACKEND_UNAVAILABLE');
  // Preserve the legacy launcher's exec semantics: same PID and no additional
  // supervisor that could leave Pi behind if the wrapper itself is SIGKILLed.
  process.execve(command, [command, ...args], env);
}

// Trusted launcher process ownership, NOT sandboxing. Autonomous tools continue
// to use their existing Bubblewrap backend. Never kill arbitrary stored PIDs.
export async function runOwnedEngine(command, args, { env = process.env, stdio = 'inherit', timeoutMs = 0 } = {}) {
  const child = spawn(command, args, { env, stdio, shell: false, detached: true });
  const killGroup = (signal) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => killGroup(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killGroup('SIGKILL'); }, timeoutMs) : null;
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status) => resolve(status ?? 1));
    });
    // Children may survive their parent. Reap the owned group before returning,
    // including on successful exit; optional shared services aren't in it.
    killGroup('SIGKILL');
    return timedOut ? 124 : code;
  } finally {
    if (timer) clearTimeout(timer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

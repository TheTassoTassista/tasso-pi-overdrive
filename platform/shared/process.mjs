import { platformAdapter } from '../index.mjs';

export async function runOwnedEngine(command, args, options = {}) {
  const platform = platformAdapter();
  const backend = platform.id === 'linux' ? await import('../linux/process.mjs') : await import('../windows/process.mjs');
  return backend.runOwnedEngine(command, args, options);
}

export async function launchEngine(command, args, env = process.env) {
  const platform = platformAdapter();
  if (platform.id !== 'linux') throw new Error('PHI_PROCESS_BACKEND_UNAVAILABLE');
  const backend = await import('../linux/process.mjs');
  backend.execEngine(command, args, env);
}

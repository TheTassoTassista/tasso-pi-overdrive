import { platformAdapter } from '../index.mjs';

export async function runOwnedEngine(command, args, options = {}) {
  const platform = platformAdapter();
  if (platform.id !== 'linux') throw new Error('PHI_PROCESS_BACKEND_UNAVAILABLE');
  const backend = await import('../linux/process.mjs');
  return backend.runOwnedEngine(command, args, options);
}

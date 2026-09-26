import { platformAdapter } from '../index.mjs';

async function ownedBackend() {
  return platformAdapter().id === 'linux' ? import('../linux/process.mjs') : import('../windows/process.mjs');
}

export async function processBackendStatus() { return (await ownedBackend()).processBackendStatus(); }

export async function runOwnedEngine(command, args, options = {}) {
  const backend = await ownedBackend();
  return backend.runOwnedEngine(command, args, options);
}

export async function launchEngine(command, args, env = process.env) {
  const platform = platformAdapter();
  if (platform.id !== 'linux') throw new Error('PHI_PROCESS_BACKEND_UNAVAILABLE');
  const backend = await import('../linux/process.mjs');
  backend.execEngine(command, args, env);
}

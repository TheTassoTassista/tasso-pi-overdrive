import os from 'node:os';
import { linuxPlatform } from './linux/index.mjs';
import { windowsPlatform } from './windows/index.mjs';

export function platformAdapter(id = process.platform) {
  if (id === 'linux') return linuxPlatform;
  if (id === 'win32') return windowsPlatform;
  throw new Error('PHI_PLATFORM_UNSUPPORTED');
}

export function localDirectories({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  return platformAdapter(platform).directories(home, env);
}

export function requireAutonomousBackend(id = process.platform) {
  const adapter = platformAdapter(id);
  if (!adapter.sandbox.autonomousReady) throw new Error('PHI_SANDBOX_UNAVAILABLE: native Windows isolation is not yet verified; engine execution is blocked');
  return adapter;
}

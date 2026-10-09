import path from 'node:path';

export const windowsPlatform = Object.freeze({
  id: 'win32',
  path: path.win32,
  directories(home, env) {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return { config: path.win32.join(local, 'Phi', 'config'), state: path.win32.join(local, 'Phi', 'state'), bin: path.win32.join(local, 'Phi', 'bin'), agent: env.PI_CODING_AGENT_DIR || path.win32.join(home, '.pi', 'agent'), legacyConfig: path.win32.join(home, '.config', 'pi-overdrive') };
  },
  // A Job Object alone is NOT a filesystem/network sandbox. Never substitute
  // unrestricted execution while the AppContainer backend is unverified.
  sandbox: Object.freeze({ id: 'appcontainer-pending', implemented: false, autonomousReady: false }),
  // Operation-specific journaled publication is narrower than full backend
  // readiness and grants no command/tool surface. Ordinary workflow admission
  // additionally requires an exact trusted task envelope for each operation.
  boundedPublication: Object.freeze({ CREATE: 'NATIVE_VERIFIED_V6', MODIFY: 'NATIVE_VERIFIED_V2',
    DELETE: 'NATIVE_VERIFIED_V3', RENAME: 'NATIVE_VERIFIED_V4' }),
});

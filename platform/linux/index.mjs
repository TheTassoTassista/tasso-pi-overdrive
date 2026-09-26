import path from 'node:path';

export const linuxPlatform = Object.freeze({
  id: 'linux',
  path,
  directories(home, env) {
    return { config: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'phi'), state: path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'phi'), bin: path.join(home, '.local', 'bin'), agent: env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'), legacyConfig: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'pi-overdrive') };
  },
  sandbox: Object.freeze({ id: 'bubblewrap', implemented: true, autonomousReady: true }),
});

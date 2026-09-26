import { PRODUCT, renderSplash, terminalCapabilities, themeName } from '../branding/terminal.mjs';
import { readPhiConfig } from './phi-config.mjs';
import path from 'node:path';
import { localDirectories } from '../platform/index.mjs';
import { readLocalJson } from '../platform/shared/filesystem.mjs';

// Display-only adapter: no tools, schemas, provider calls, routing or authority.
// Legacy `pi` and noninteractive/RPC sessions retain their existing UI behavior.
export function installPhiUI(pi, env = process.env) {
  if (env.PHI_LAUNCH !== '1') return;
  const update = (_event, ctx) => {
    if (!ctx.hasUI) return;
    let theme = PRODUCT.defaultTheme;
    try { theme = themeName(env.PHI_THEME ?? readPhiConfig().theme); } catch {}
    let preset = 'unavailable';
    // Do not import the routing controller here: loading/freeze order of its
    // JSON modules is significant to Pi's extension loader. Display reads only
    // the bounded preset field and cannot acquire routing authority.
    try {
      const value = readLocalJson(path.join(localDirectories().legacyConfig, 'model-policy.json'));
      if (value && ['normal', 'token-saver', 'custom'].includes(value.preset)) preset = value.preset;
    } catch {}
    ctx.ui.setHeader(() => ({
      render(width) {
        const capabilities = { ...terminalCapabilities(process.stdout, env), width };
        return renderSplash({ theme, capabilities, state: { piVersion: PRODUCT.piVersion, preset, model: ctx.model?.id ?? 'not selected', memory: 'on demand', omniroute: 'on demand', searxng: 'on demand' } }).trimEnd().split('\n');
      },
      invalidate() {},
    }));
  };
  pi.on('session_start', update);
  pi.on('model_select', update);
}

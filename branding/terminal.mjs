import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCT = Object.freeze(JSON.parse(fs.readFileSync(path.join(root, 'config', 'phi-product.json'), 'utf8')));
export const THEMES = Object.freeze(JSON.parse(fs.readFileSync(path.join(root, 'themes', 'builtin.json'), 'utf8')));
const MARK = Object.freeze(['       │       ', '   ╭───┼───╮   ', '   │   │   │   ', '   ╰───┼───╯   ', '       │       ']);

export function themeName(name) {
  if (typeof name !== 'string' || !Object.hasOwn(THEMES, name)) throw new Error('PHI_UNKNOWN_THEME');
  return name;
}

export function terminalCapabilities(stream = process.stdout, env = process.env, platform = process.platform) {
  const tty = stream.isTTY === true;
  const disabled = !tty || Object.hasOwn(env, 'NO_COLOR') || env.TERM === 'dumb';
  const truecolor = !disabled && (/^(truecolor|24bit)$/iu.test(env.COLORTERM ?? '') || Boolean(env.WT_SESSION));
  // Windows Terminal is known UTF-8; ambiguous legacy Windows consoles use ASCII.
  const unicode = tty && env.TERM !== 'dumb' && (platform === 'win32' ? Boolean(env.WT_SESSION) : /utf-?8/iu.test(`${env.LC_ALL ?? ''} ${env.LC_CTYPE ?? ''} ${env.LANG ?? ''}`));
  return { tty, color: !disabled, truecolor, unicode, width: Math.max(1, Math.min(240, Number(stream.columns) || 80)) };
}

function clean(value) { return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/gu, '').slice(0, 96); }
function color(text, hex, caps) {
  if (!caps.color || !hex) return text;
  const rgb = hex.slice(1).match(/../gu).map((item) => Number.parseInt(item, 16));
  const escape = caps.truecolor ? `\x1b[38;2;${rgb.join(';')}m` : '\x1b[36m';
  return `${escape}${text}\x1b[0m`;
}

export function renderSplash({ theme = PRODUCT.defaultTheme, capabilities = terminalCapabilities(), state = {}, compact = false } = {}) {
  const colors = THEMES[themeName(theme)].colors;
  const width = capabilities.width;
  const narrow = compact || width < 46;
  let lines = capabilities.unicode && !narrow ? [...MARK, '', 'P H I', 'intelligent coding system'] : [capabilities.unicode ? 'Φ  PHI' : 'PHI', ...(narrow ? [] : ['intelligent coding system'])];
  lines = lines.map((line, index) => {
    const cropped = line.slice(0, width);
    const left = narrow ? 0 : Math.max(0, Math.floor((Math.min(width, 64) - cropped.length) / 2));
    return `${' '.repeat(left)}${color(cropped, colors[index % Math.max(1, colors.length)], capabilities)}`;
  });
  lines.push('');
  const rows = [`Phi ${PRODUCT.version} · Pi ${clean(state.piVersion ?? PRODUCT.piVersion)}`, `${clean(state.preset ?? 'normal')} · ${clean(state.model ?? 'not configured')}`, `Second Brain ${clean(state.memory ?? 'lazy')} · OmniRoute ${clean(state.omniroute ?? 'lazy')} · SearXNG ${clean(state.searxng ?? 'lazy')}`];
  if (!capabilities.unicode) rows.splice(0, rows.length, ...rows.map((line) => line.replaceAll('·', '|')));
  for (const row of rows) lines.push(row.slice(0, width));
  return `${lines.join('\n')}\n`;
}

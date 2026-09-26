import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installPhiUI } from '../lib/phi-ui.mjs';

export default function phiBranding(pi: ExtensionAPI) {
  installPhiUI(pi);
}

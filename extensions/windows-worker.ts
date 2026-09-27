import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerWindowsWorkerBoundary } from '../lib/phi-worker-authority.mjs';

export default function windowsWorker(pi: ExtensionAPI) {
  if (process.platform === 'win32') registerWindowsWorkerBoundary(pi);
}

// Pi otherwise falls back to any authenticated provider when the configured
// default is unavailable. Keep that choice explicit in fresh Phi sessions.
export function pinFreshSessionDefault(args, settings) {
  if (!Array.isArray(args) || !settings || typeof settings.defaultProvider !== 'string' || typeof settings.defaultModel !== 'string') {
    throw new Error('PHI_MODEL_DEFAULT_UNAVAILABLE');
  }
  const explicit = args.some((arg) => ['--provider', '--model', '--models'].includes(arg) ||
    arg.startsWith('--provider=') || arg.startsWith('--model=') || arg.startsWith('--models='));
  const restoring = args.some((arg) => ['--continue', '-c', '--resume', '-r', '--session', '--session-id', '--fork'].includes(arg) ||
    arg.startsWith('--session=') || arg.startsWith('--session-id=') || arg.startsWith('--fork='));
  if (explicit || restoring) return args;
  if (!/^[A-Za-z0-9._-]+$/u.test(settings.defaultProvider) || !/^[A-Za-z0-9._:/-]+$/u.test(settings.defaultModel)) {
    throw new Error('PHI_MODEL_DEFAULT_INVALID');
  }
  return ['--provider', settings.defaultProvider, '--model', settings.defaultModel, ...args];
}

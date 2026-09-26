#!/usr/bin/env node
import { buildWindowsProcess } from '../platform/windows/build-process.mjs';
try {
  if (process.argv.length !== 2) throw new Error('PHI_WINDOWS_BUILD_ARGUMENT_INVALID');
  console.log(JSON.stringify(buildWindowsProcess()));
} catch (error) {
  console.error(/^PHI_WINDOWS_BUILD_[A-Z_]+$/u.test(error.message ?? '') ? error.message : 'PHI_WINDOWS_BUILD_STATE_INVALID');
  process.exitCode = 1;
}

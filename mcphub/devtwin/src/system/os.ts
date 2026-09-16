/**
 * Operating system / platform inspection.
 */

import { arch, machine, release, version } from 'node:os';

export interface OsInfo {
  /** "Darwin", "Linux", "Windows" */
  system: string;
  release: string;
  version: string;
  machine: string;
  /** runtime version of the host process (the Node analogue of python_version) */
  node_version: string;
  is_macos: boolean;
  is_linux: boolean;
  is_windows: boolean;
}

/** Normalize `process.platform` onto the names Python's `platform.system()` reports. */
export function platformSystem(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Darwin';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return process.platform.charAt(0).toUpperCase() + process.platform.slice(1);
  }
}

export function getOsInfo(): OsInfo {
  const system = platformSystem();
  return {
    system,
    release: safe(() => release(), ''),
    version: safe(() => version(), ''),
    // os.machine() is the closest match to platform.machine(); arch() is the fallback.
    machine: safe(() => machine(), arch()),
    node_version: process.versions.node,
    is_macos: system === 'Darwin',
    is_linux: system === 'Linux',
    is_windows: system === 'Windows',
  };
}

/** Never crash on a platform where one of the os.* getters is unavailable. */
function safe(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

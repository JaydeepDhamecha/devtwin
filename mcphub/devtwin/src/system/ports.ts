/**
 * Port inspection.
 *
 * Listening-state checks use plain TCP sockets only (works identically on
 * macOS/Linux/Windows). Identifying the *owning process* is best-effort: it
 * shells out to platform-native tools (`lsof`, `ss`, or PowerShell's
 * `Get-NetTCPConnection`) and gracefully returns null when those aren't
 * available -- this is metadata, not something the health score should ever
 * depend on.
 */

import { Socket } from 'node:net';

import type { PortInfo } from '../core/models.js';
import { runCommand, which } from '../core/runner.js';
import { platformSystem } from './os.js';

/** Attempt one TCP connect on a single address family; always destroys the socket. */
function connectOnce(port: number, host: string, family: 4 | 6, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new Socket();

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout * 1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    // Any OSError equivalent (ECONNREFUSED, EAFNOSUPPORT, ...) is just "not listening here".
    socket.once('error', () => finish(false));

    try {
      socket.connect({ port, host, family });
    } catch {
      finish(false);
    }
  });
}

export async function isPortListening(
  port: number,
  host = '127.0.0.1',
  timeout = 0.5,
): Promise<boolean> {
  for (const family of [4, 6] as const) {
    if (await connectOnce(port, host, family, timeout)) {
      return true;
    }
  }
  return false;
}

async function findOwnerMacosLinux(port: number): Promise<[string | null, number | null]> {
  if (which('lsof')) {
    const result = await runCommand(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      timeout: 5,
    });
    if (result.available && result.returncode === 0) {
      const lines = result.stdout.split(/\r?\n/).filter((line) => line);
      if (lines.length >= 2) {
        const parts = lines[1]!.split(/\s+/).filter((p) => p);
        if (parts.length >= 2) {
          const name = parts[0]!;
          const parsed = Number.parseInt(parts[1]!, 10);
          const pid = Number.isNaN(parsed) ? null : parsed;
          return [name, pid];
        }
      }
    }
  }
  return [null, null];
}

async function findOwnerWindows(port: number): Promise<[string | null, number | null]> {
  const result = await runCommand(
    [
      'powershell',
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen ` +
        '-ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)',
    ],
    { timeout: 5 },
  );
  if (result.available && result.returncode === 0 && result.stdout.trim()) {
    const pid = Number.parseInt(result.stdout.trim(), 10);
    if (Number.isNaN(pid)) {
      return [null, null];
    }
    const nameResult = await runCommand(
      ['powershell', '-NoProfile', '-Command', `(Get-Process -Id ${pid}).ProcessName`],
      { timeout: 5 },
    );
    const name = nameResult.available ? nameResult.stdout.trim() : null;
    return [name || null, pid];
  }
  return [null, null];
}

export async function checkPort(port: number, host = '127.0.0.1'): Promise<PortInfo> {
  const listening = await isPortListening(port, host);
  let process_name: string | null = null;
  let pid: number | null = null;
  if (listening) {
    if (platformSystem() === 'Windows') {
      [process_name, pid] = await findOwnerWindows(port);
    } else {
      [process_name, pid] = await findOwnerMacosLinux(port);
    }
  }
  return { port, listening, protocol: 'tcp', process_name, pid };
}

export async function checkPorts(ports: number[], host = '127.0.0.1'): Promise<PortInfo[]> {
  const results: PortInfo[] = [];
  for (const p of ports) {
    results.push(await checkPort(p, host));
  }
  return results;
}

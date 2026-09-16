/**
 * Process inspection.
 *
 * Best-effort, platform-native tools only (no extra dependency). Never
 * exposes full command lines by default -- only pid/name -- to avoid leaking
 * secrets that are sometimes passed as CLI arguments (e.g.
 * `--password=...`).
 */

import type { ProcessInfo } from '../core/models.js';
import { runCommand } from '../core/runner.js';
import { platformSystem } from './os.js';

/** Equivalent of Python's `str.strip('"')`: drop leading/trailing quote chars. */
function stripQuotes(value: string): string {
  return value.replace(/^"+/, '').replace(/"+$/, '');
}

/** Find running processes whose name contains `nameSubstring`. */
export async function listProcessesMatching(nameSubstring: string): Promise<ProcessInfo[]> {
  const system = platformSystem();
  const processes: ProcessInfo[] = [];
  const needle = nameSubstring.toLowerCase();

  if (system === 'Windows') {
    const result = await runCommand(['tasklist', '/FO', 'CSV', '/NH'], { timeout: 5 });
    if (!result.available || result.returncode !== 0) {
      return processes;
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      const fields = line.split('","').map((f) => stripQuotes(f));
      if (fields.length < 2) {
        continue;
      }
      const procName = stripQuotes(fields[0]!);
      if (!procName.toLowerCase().includes(needle)) {
        continue;
      }
      const pid = Number.parseInt(fields[1]!, 10);
      if (Number.isNaN(pid)) {
        continue;
      }
      processes.push({ pid, name: procName, port: null });
    }
    return processes;
  }

  const result = await runCommand(['ps', '-eo', 'pid,comm'], { timeout: 5 });
  if (!result.available || result.returncode !== 0) {
    return processes;
  }
  // Skip the header row.
  for (const rawLine of result.stdout.split(/\r?\n/).slice(1)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    // Split once on whitespace: "<pid> <command name>".
    const parts = /^(\S+)\s+(.*)$/.exec(line);
    if (!parts) {
      continue;
    }
    const pidStr = parts[1]!;
    const comm = parts[2]!;
    if (!comm.toLowerCase().includes(needle)) {
      continue;
    }
    const pid = Number.parseInt(pidStr, 10);
    if (Number.isNaN(pid)) {
      continue;
    }
    processes.push({ pid, name: comm, port: null });
  }
  return processes;
}

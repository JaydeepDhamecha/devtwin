/**
 * Ecosystem adapter contract.
 *
 * Every language adapter implements this interface. `run()` is the only
 * method callers use directly -- it calls each inspection step and catches
 * exceptions per-step, so one broken/missing tool (e.g. Java not installed)
 * degrades that single field instead of crashing the whole adapter or plugin.
 */

import {
  emptyAdapterResult,
  type AdapterResult,
  type DependencyInfo,
  type EnvironmentVariableStatus,
  type HealthIssue,
  type RuntimeInfo,
} from '../core/models.js';

const VERSION_RE = /(\d+(?:\.\d+){0,3})/;

/** Pull the first dotted-number version string out of free-form CLI output. */
export function extractVersion(text: string): string | null {
  const match = VERSION_RE.exec(text);
  return match ? match[1]! : null;
}

export function versionTuple(version: string): number[] {
  return version.split('.').map((chunk) => {
    const digits = chunk.replace(/\D/g, '');
    return digits ? parseInt(digits, 10) : 0;
  });
}

export function majorVersion(version: string | null | undefined): number | null {
  if (!version) return null;
  const t = versionTuple(version);
  return t.length > 0 ? t[0]! : null;
}

function pad(parts: number[], length: number): number[] {
  const out = parts.slice();
  while (out.length < length) out.push(0);
  return out;
}

function gte(a: number[], b: number[]): boolean {
  const n = Math.max(a.length, b.length);
  const left = pad(a, n);
  const right = pad(b, n);
  for (let i = 0; i < n; i += 1) {
    if (left[i]! > right[i]!) return true;
    if (left[i]! < right[i]!) return false;
  }
  return true;
}

function samePrefix(a: number[], b: number[], length: number): boolean {
  for (let i = 0; i < length; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return false;
  }
  return true;
}

/**
 * Return true if `installed` does not satisfy `required`.
 *
 * - ">=X": satisfied by any installed version >= X (a newer version is fine).
 * - "^X" (npm caret): satisfied by same major, installed >= X.
 * - "~X" (npm tilde): satisfied by same major.minor, installed >= X.
 * - Bare ("21", "3.12", or any other prefix we don't special-case): compared
 *   as an approximate pin -- only as many components as given are checked
 *   for equality. A single-number pin ("21") checks major only; a two-part
 *   pin ("3.12", "1.22") checks major.minor.
 */
export function versionMismatch(required: string, installed: string): boolean {
  const stripped = required.trim();
  const installedParts = versionTuple(installed);

  if (stripped.startsWith('>=')) {
    const expected = versionTuple(stripped.slice(2));
    return expected.length > 0 && !gte(installedParts, expected);
  }

  if (stripped.startsWith('^')) {
    const expected = versionTuple(stripped.slice(1));
    if (expected.length === 0) return false;
    return !(samePrefix(installedParts, expected, 1) && gte(installedParts, expected));
  }

  if (stripped.startsWith('~')) {
    const expected = versionTuple(stripped.slice(1));
    if (expected.length === 0) return false;
    const compareLen = Math.min(2, expected.length);
    return !(samePrefix(installedParts, expected, compareLen) && gte(installedParts, expected));
  }

  const cleaned = stripped.replace(/^[=v< ]+/, '').split(',')[0]!.trim();
  const expected = versionTuple(cleaned);
  if (expected.length === 0) return false;
  return !samePrefix(installedParts, expected, expected.length);
}

export abstract class EcosystemAdapter {
  abstract readonly ecosystem: string;

  /** Cheap, file-based check for whether this adapter applies. */
  abstract detect(root: string): Promise<boolean> | boolean;

  async inspectRuntime(_root: string): Promise<RuntimeInfo[]> {
    return [];
  }

  async inspectDependencies(_root: string): Promise<DependencyInfo | null> {
    return null;
  }

  async inspectBuild(_root: string): Promise<RuntimeInfo[]> {
    return [];
  }

  async inspectTests(_root: string): Promise<string[]> {
    return [];
  }

  async inspectBuildCommands(_root: string): Promise<string[]> {
    return [];
  }

  async inspectEnvironment(_root: string): Promise<EnvironmentVariableStatus[]> {
    return [];
  }

  async healthChecks(_root: string, _runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    return [];
  }

  async run(root: string): Promise<AdapterResult> {
    const applicable = await this.safe(() => this.detect(root), false);
    const result = emptyAdapterResult(this.ecosystem, Boolean(applicable));
    if (!applicable) return result;

    result.runtimes = await this.safe(() => this.inspectRuntime(root), []);
    result.dependencies = await this.safe(() => this.inspectDependencies(root), null);
    result.build_tools = await this.safe(() => this.inspectBuild(root), []);
    result.test_commands = await this.safe(() => this.inspectTests(root), []);
    result.build_commands = await this.safe(() => this.inspectBuildCommands(root), []);
    result.environment = await this.safe(() => this.inspectEnvironment(root), []);
    result.issues = await this.safe(() => this.healthChecks(root, result.runtimes), []);
    return result;
  }

  /** Adapters must never crash the plugin: every step degrades to `fallback`. */
  protected async safe<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }
}

/**
 * Filesystem helpers used by detection and inspection.
 *
 * Kept intentionally simple: a bounded, non-recursive-into-ignored-dirs walk
 * that's fast enough to run on every devtwin_detect call.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'target',
  'build',
  'dist',
  '.gradle',
  '.idea',
  '.vscode',
  'bin',
  'obj',
  '.terraform',
]);

export const GENERATED_MARKERS = [
  'dist',
  'build',
  'target',
  '.next',
  'out',
  'node_modules',
  '__pycache__',
  '.venv',
];

const GLOBSTAR = 'GLOBSTAR_PLACEHOLDER_TOKEN';

/** Return which of `names` exist directly under `root`. */
export function existsAny(root: string, names: string[]): string[] {
  return names.filter((name) => existsSync(join(root, name)));
}

function matcherFor(pattern: string): RegExp {
  // Supports the glob subset the Python implementation relied on: `*`, `**/`, `?`.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .split('**/')
    .join(GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(GLOBSTAR)
    .join('(?:.*/)?');
  return new RegExp('^' + escaped + '$');
}

function walk(root: string, maxDepth: number): string[] {
  const results: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      results.push(relative(root, full).split(sep).join('/'));
      if (isDir && !IGNORED_DIRS.has(entry) && depth + 1 < maxDepth) {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return results;
}

/** Return up to `maxMatches` relative paths matching any glob pattern. */
export function globAny(root: string, patterns: string[], maxMatches = 5): string[] {
  const matches: string[] = [];
  const needsWalk = patterns.some((p) => p.includes('**') || p.includes('/'));
  let candidates: string[];
  if (needsWalk) {
    candidates = walk(root, 6);
  } else {
    try {
      candidates = readdirSync(root);
    } catch {
      candidates = [];
    }
  }

  for (const pattern of patterns) {
    const re = matcherFor(pattern);
    for (const candidate of candidates) {
      if (!re.test(candidate)) continue;
      if (!matches.includes(candidate)) matches.push(candidate);
      if (matches.length >= maxMatches) return matches;
    }
  }
  return matches;
}

export function listTopLevel(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries.filter((name) => !IGNORED_DIRS.has(name)).sort();
}

export function hasGeneratedArtifacts(root: string): string[] {
  return GENERATED_MARKERS.filter((marker) => existsSync(join(root, marker)));
}

/** Read a text file, returning null instead of throwing when it is missing or unreadable. */
export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Read and parse a JSON file, returning null on any read or parse failure. */
export function readJsonFile<T = Record<string, unknown>>(path: string): T | null {
  const text = readTextFile(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

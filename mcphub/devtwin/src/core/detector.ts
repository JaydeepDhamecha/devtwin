/**
 * Project/ecosystem detection based on repository files.
 *
 * Detection is evidence-based: every ecosystem's confidence score is derived
 * directly from which indicator files are present, and the indicator list is
 * returned alongside the score so callers (and the model) can see exactly why
 * a project was classified the way it was. No ecosystem is ever reported as
 * present without a matching file.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { ProjectProfile } from './models.js';
import { existsAny, globAny } from '../system/filesystem.js';

// Each indicator has a weight; confidence is capped at 1.0.
export const PYTHON_INDICATORS: Record<string, number> = {
  'pyproject.toml': 0.5,
  'requirements.txt': 0.35,
  'uv.lock': 0.4,
  'poetry.lock': 0.4,
  Pipfile: 0.35,
  'Pipfile.lock': 0.3,
  '.python-version': 0.25,
};

export const NODE_INDICATORS: Record<string, number> = {
  'package.json': 0.6,
  'package-lock.json': 0.3,
  'pnpm-lock.yaml': 0.3,
  'yarn.lock': 0.3,
  'bun.lock': 0.3,
  'bun.lockb': 0.3,
  '.nvmrc': 0.2,
  '.node-version': 0.2,
};

export const JVM_INDICATORS: Record<string, number> = {
  'pom.xml': 0.55,
  'build.gradle': 0.55,
  'build.gradle.kts': 0.55,
  'settings.gradle': 0.3,
  'settings.gradle.kts': 0.3,
  gradlew: 0.25,
  'gradle/wrapper/gradle-wrapper.properties': 0.25,
  'gradle.properties': 0.15,
};

export const GO_INDICATORS: Record<string, number> = {
  'go.mod': 0.6,
  'go.sum': 0.3,
  'go.work': 0.3,
};

export const RUST_INDICATORS: Record<string, number> = {
  'Cargo.toml': 0.6,
  'Cargo.lock': 0.3,
  'rust-toolchain.toml': 0.25,
  'rust-toolchain': 0.25,
};

export const DOTNET_GLOB_INDICATORS: Record<string, number> = {
  '*.csproj': 0.55,
  '*.fsproj': 0.55,
  '*.vbproj': 0.55,
  '*.sln': 0.35,
};
export const DOTNET_FILE_INDICATORS: Record<string, number> = {
  'global.json': 0.2,
};

export const GENERIC_INDICATORS: Record<string, number> = {
  Makefile: 0.3,
  'Taskfile.yml': 0.3,
  justfile: 0.3,
  Dockerfile: 0.3,
  'compose.yaml': 0.3,
  'compose.yml': 0.3,
  'docker-compose.yml': 0.3,
  'docker-compose.yaml': 0.3,
  'README.md': 0.1,
  README: 0.1,
  scripts: 0.1,
};

/**
 * Python's `round()` uses banker's rounding while this uses half-away-from-zero;
 * for these 2-decimal confidence values (sums of 2-decimal weights) the
 * difference is immaterial.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function score(root: string, indicators: Record<string, number>): [number, string[]] {
  const names = Object.keys(indicators);
  const found = existsAny(root, names);
  const total = found.reduce((sum, name) => sum + (indicators[name] ?? 0), 0);
  return [Math.min(1.0, total), found];
}

function hasKotlinSources(root: string): boolean {
  return globAny(root, ['**/*.kt'], 1).length > 0 || globAny(root, ['*.kt'], 1).length > 0;
}

function hasJavaSources(root: string): boolean {
  return globAny(root, ['**/*.java'], 1).length > 0 || globAny(root, ['*.java'], 1).length > 0;
}

export function detectProject(root: string): ProjectProfile {
  // Mirrors Python's `Path(root).expanduser().resolve()`.
  const expanded =
    root === '~' || root.startsWith('~/') ? homedir() + root.slice(1) : root;
  const path = resolve(expanded);

  const indicators: Record<string, string[]> = {};
  const confidence: Record<string, number> = {};

  const [pythonScore, pythonFound] = score(path, PYTHON_INDICATORS);
  const [nodeScore, nodeFound] = score(path, NODE_INDICATORS);
  let [jvmScore, jvmFound] = score(path, JVM_INDICATORS);
  const [goScore, goFound] = score(path, GO_INDICATORS);
  const [rustScore, rustFound] = score(path, RUST_INDICATORS);

  const dotnetGlobFound = globAny(path, Object.keys(DOTNET_GLOB_INDICATORS));
  const dotnetFileFound = existsAny(path, Object.keys(DOTNET_FILE_INDICATORS));
  const dotnetScore = Math.min(
    1.0,
    (dotnetGlobFound.length > 0 ? 0.55 : 0.0) +
      dotnetFileFound.reduce((sum, n) => sum + (DOTNET_FILE_INDICATORS[n] ?? 0), 0),
  );
  const dotnetFound = [...dotnetGlobFound, ...dotnetFileFound];

  const [genericScore, genericFound] = score(path, GENERIC_INDICATORS);

  // Kotlin sources on top of a Gradle/Maven project are extra evidence for the
  // JVM ecosystem; Java sources are recorded as evidence without a bonus.
  if (jvmFound.length > 0 && hasKotlinSources(path)) {
    jvmScore = Math.min(1.0, jvmScore + 0.15);
    jvmFound = [...jvmFound, '*.kt'];
  }
  if (jvmFound.length > 0 && hasJavaSources(path)) {
    jvmFound = [...jvmFound, '*.java'];
  }

  // Insertion order matters: it is the tie-break for the ranking below.
  const candidates: Array<[string, number, string[]]> = [
    ['python', pythonScore, pythonFound],
    ['node', nodeScore, nodeFound],
    ['jvm', jvmScore, jvmFound],
    ['go', goScore, goFound],
    ['rust', rustScore, rustFound],
    ['dotnet', dotnetScore, dotnetFound],
  ];

  const ecosystems: string[] = [];
  for (const [name, candidateScore, found] of candidates) {
    if (candidateScore > 0) {
      ecosystems.push(name);
      indicators[name] = found;
      confidence[name] = round2(candidateScore);
    }
  }

  if (genericScore > 0) {
    indicators['generic'] = genericFound;
    confidence['generic'] = round2(genericScore);
    if (ecosystems.length === 0) {
      ecosystems.push('generic');
    }
  }

  let primaryEcosystem: string | null = null;
  // Stable sort, like Python's `sorted(..., reverse=True)`: equal scores keep
  // the candidate declaration order above.
  const ranked = ecosystems
    .map((name): [string, number] => [name, confidence[name] ?? 0.0])
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length > 0) {
    primaryEcosystem = ranked[0]![0];
  }

  return {
    root: path,
    ecosystems,
    primary_ecosystem: primaryEcosystem,
    indicators,
    confidence,
  };
}

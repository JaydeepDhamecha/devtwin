/**
 * Node.js ecosystem adapter: node, npm, pnpm, yarn, bun.
 */

import { join } from 'node:path';

import {
  Presence,
  Severity,
  type DependencyInfo,
  type EnvironmentVariableStatus,
  type HealthIssue,
  type RuntimeInfo,
} from '../core/models.js';
import { runCommand, which } from '../core/runner.js';
import { checkEnvVar } from '../system/environment.js';
import { existsAny, pathExists, readJsonFile, readTextFile } from '../system/filesystem.js';
import { EcosystemAdapter, extractVersion } from './base.js';

// Insertion order matters: it is the precedence used when a project somehow
// carries more than one lockfile. Object key order is preserved for string
// keys, so this stands in for the ordered Python dict.
export const LOCKFILE_MANAGERS: Record<string, string> = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
};

type PackageJson = Record<string, unknown>;

/** Read package.json, degrading to `{}` on a missing, unreadable, or invalid file. */
function readPackageJson(root: string): PackageJson {
  const pkgPath = join(root, 'package.json');
  if (!pathExists(pkgPath)) {
    return {};
  }
  const parsed = readJsonFile<unknown>(pkgPath);
  // Guard against valid-but-not-an-object JSON (e.g. `null`, `"x"`, `[]`) so
  // field lookups below can never blow up.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as PackageJson;
}

/** True for a JSON object (not an array, not null) -- Python's `isinstance(x, dict)`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Python's `str.lstrip(char)`: drop every leading occurrence of `char`. */
function stripLeading(text: string, char: string): string {
  let start = 0;
  while (start < text.length && text[start] === char) start += 1;
  return text.slice(start);
}

export class NodeAdapter extends EcosystemAdapter {
  readonly ecosystem = 'node';

  detect(root: string): boolean {
    const indicators = [
      'package.json',
      ...Object.keys(LOCKFILE_MANAGERS),
      '.nvmrc',
      '.node-version',
    ];
    return existsAny(root, indicators).length > 0;
  }

  /** Returns [required version, where it was read from]. */
  private requiredVersion(root: string): [string | null, string | null] {
    for (const filename of ['.nvmrc', '.node-version']) {
      const f = join(root, filename);
      if (pathExists(f)) {
        const raw = readTextFile(f);
        if (raw !== null) {
          // `.nvmrc` commonly reads `v20.11.0`; strip the leading `v`s.
          const content = stripLeading(raw.trim(), 'v');
          if (content) {
            return [content, filename];
          }
        }
      }
    }
    const pkg = readPackageJson(root);
    const engines = pkg['engines'];
    if (isPlainObject(engines) && engines['node']) {
      return [String(engines['node']), 'package.json engines.node'];
    }
    return [null, null];
  }

  /** Returns [manager name, pinned manager version (from packageManager)]. */
  private detectManager(root: string): [string | null, string | null] {
    const pkg = readPackageJson(root);
    const packageManagerField = pkg['packageManager'];
    if (typeof packageManagerField === 'string' && packageManagerField.includes('@')) {
      const at = packageManagerField.indexOf('@');
      const name = packageManagerField.slice(0, at);
      const version = packageManagerField.slice(at + 1);
      return [name, version];
    }
    for (const [lockfile, manager] of Object.entries(LOCKFILE_MANAGERS)) {
      if (pathExists(join(root, lockfile))) {
        return [manager, null];
      }
    }
    return [null, null];
  }

  async inspectRuntime(root: string): Promise<RuntimeInfo[]> {
    const [required, source] = this.requiredVersion(root);
    const nodePath = which('node');
    if (nodePath === null) {
      return [
        {
          name: 'node',
          presence: Presence.NOT_INSTALLED,
          installed_version: null,
          required_version: required,
          path: null,
          source,
        },
      ];
    }
    const result = await runCommand([nodePath, '--version'], { timeout: 5 });
    const installed = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'node',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        required_version: required,
        path: nodePath,
        source,
      },
    ];
  }

  async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    const pkgJsonPresent = pathExists(join(root, 'package.json'));
    if (!pkgJsonPresent) {
      return null;
    }

    const [manager, requiredManagerVersion] = this.detectManager(root);
    let lockfile: string | null = null;
    for (const name of Object.keys(LOCKFILE_MANAGERS)) {
      if (pathExists(join(root, name))) {
        lockfile = name;
        break;
      }
    }

    const pkg = readPackageJson(root);
    const deps = pkg['dependencies'];
    const devDeps = pkg['devDependencies'];

    const notes: string[] = [];
    const nodeModulesPresent = pathExists(join(root, 'node_modules'));
    const installed = nodeModulesPresent ? Presence.INSTALLED : Presence.NOT_INSTALLED;
    if (!nodeModulesPresent) {
      notes.push('node_modules/ not found -- run install before building/testing');
    }
    if (requiredManagerVersion) {
      notes.push(`packageManager pins ${manager}@${requiredManagerVersion}`);
    }

    return {
      ecosystem: 'node',
      manager,
      lockfile,
      lockfile_present: lockfile !== null,
      manifest_present: true,
      installed,
      dependency_count: isPlainObject(deps) ? Object.keys(deps).length : null,
      dev_dependency_count: isPlainObject(devDeps) ? Object.keys(devDeps).length : null,
      notes,
    };
  }

  async inspectBuild(root: string): Promise<RuntimeInfo[]> {
    const tools: RuntimeInfo[] = [];
    const [manager, requiredVersion] = this.detectManager(root);
    // The project's own manager plus npm, deduplicated -- npm is the fallback
    // runner even when the project pins something else.
    const candidateTools = new Set<string>();
    if (manager !== null) {
      candidateTools.add(manager);
    }
    candidateTools.add('npm');
    for (const tool of candidateTools) {
      const path = which(tool);
      if (path === null) {
        tools.push({
          name: tool,
          presence: Presence.NOT_INSTALLED,
          installed_version: null,
          required_version: null,
          path: null,
          source: null,
        });
        continue;
      }
      const result = await runCommand([tool, '--version'], { timeout: 5 });
      const version = result.available ? extractVersion(result.stdout) : null;
      tools.push({
        name: tool,
        presence: Presence.INSTALLED,
        installed_version: version,
        required_version: tool === manager ? requiredVersion : null,
        path,
        source: null,
      });
    }
    return tools;
  }

  async inspectTests(root: string): Promise<string[]> {
    const pkg = readPackageJson(root);
    const scripts = pkg['scripts'];
    const [manager] = this.detectManager(root);
    const runner = manager || 'npm';
    const runPrefix = runner === 'npm' ? 'npm run' : `${runner} run`;
    const commands: string[] = [];
    if (isPlainObject(scripts)) {
      if ('test' in scripts) {
        commands.push(runner !== 'npm' ? `${runner} test` : 'npm test');
      }
      if ('lint' in scripts) {
        commands.push(`${runPrefix} lint`);
      }
    }
    return commands;
  }

  async inspectBuildCommands(root: string): Promise<string[]> {
    const pkg = readPackageJson(root);
    const scripts = pkg['scripts'];
    const [manager] = this.detectManager(root);
    const runner = manager || 'npm';
    const runPrefix = runner === 'npm' ? 'npm run' : `${runner} run`;
    if (isPlainObject(scripts) && 'build' in scripts) {
      return [`${runPrefix} build`];
    }
    return [];
  }

  async inspectEnvironment(_root: string): Promise<EnvironmentVariableStatus[]> {
    const candidates = ['NODE_ENV', 'NODE_OPTIONS'];
    return candidates.map((name) => checkEnvVar(name)).filter((status) => status.present);
  }

  async healthChecks(_root: string, runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const rt of runtimes) {
      if (rt.name === 'node' && rt.presence === Presence.NOT_INSTALLED) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'node.not_installed',
          title: 'Node.js runtime not found',
          message: 'No `node` executable was found on PATH.',
          evidence: ['which node -> not found'],
          recommendation: 'Install Node.js (e.g. via nvm, fnm, or your OS package manager).',
          confidence: null,
        });
      }
    }
    return issues;
  }
}

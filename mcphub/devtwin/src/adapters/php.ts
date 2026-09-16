/** PHP ecosystem adapter: Composer-based projects. */

import { join } from 'node:path';

import {
  Presence,
  Severity,
  type DependencyInfo,
  type HealthIssue,
  type RuntimeInfo,
} from '../core/models.js';
import { runCommand, which } from '../core/runner.js';
import { pathExists, readJsonFile } from '../system/filesystem.js';
import { EcosystemAdapter, extractVersion } from './base.js';

/** Read composer.json, degrading to `{}` on a missing file or malformed JSON. */
function readComposerJson(root: string): Record<string, unknown> {
  const file = join(root, 'composer.json');
  if (!pathExists(file)) {
    return {};
  }
  const data = readJsonFile<Record<string, unknown>>(file);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {};
  }
  return data;
}

export class PhpAdapter extends EcosystemAdapter {
  readonly ecosystem = 'php';

  detect(root: string): boolean {
    return pathExists(join(root, 'composer.json'));
  }

  private requiredVersion(root: string): string | null {
    const require = readComposerJson(root)['require'];
    // Only a JSON object counts -- a scalar or array `require` is ignored.
    if (typeof require !== 'object' || require === null || Array.isArray(require)) {
      return null;
    }
    const php = (require as Record<string, unknown>)['php'];
    return typeof php === 'string' ? php : null;
  }

  async inspectRuntime(root: string): Promise<RuntimeInfo[]> {
    const required = this.requiredVersion(root);
    const phpPath = which('php');
    if (phpPath === null) {
      return [
        {
          name: 'php',
          presence: Presence.NOT_INSTALLED,
          installed_version: null,
          required_version: required,
          path: null,
          source: required ? 'composer.json [require.php]' : null,
        },
      ];
    }
    const result = await runCommand([phpPath, '--version'], { timeout: 5 });
    const installed = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'php',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        required_version: required,
        path: phpPath,
        source: required ? 'composer.json [require.php]' : null,
      },
    ];
  }

  async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    if (!pathExists(join(root, 'composer.json'))) {
      return null;
    }
    const lockfilePresent = pathExists(join(root, 'composer.lock'));
    return {
      ecosystem: 'php',
      manager: 'composer',
      lockfile: lockfilePresent ? 'composer.lock' : null,
      lockfile_present: lockfilePresent,
      manifest_present: true,
      installed: Presence.UNKNOWN,
      dependency_count: null,
      dev_dependency_count: null,
      notes: [],
    };
  }

  async inspectTests(root: string): Promise<string[]> {
    const scripts = readComposerJson(root)['scripts'];
    if (
      typeof scripts === 'object' &&
      scripts !== null &&
      !Array.isArray(scripts) &&
      'test' in (scripts as Record<string, unknown>)
    ) {
      return ['composer test'];
    }
    if (pathExists(join(root, 'phpunit.xml')) || pathExists(join(root, 'phpunit.xml.dist'))) {
      return ['vendor/bin/phpunit'];
    }
    return [];
  }

  async healthChecks(_root: string, runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const rt of runtimes) {
      if (rt.name === 'php' && rt.presence === Presence.NOT_INSTALLED) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'php.not_installed',
          title: 'PHP not found',
          message: 'No `php` executable was found on PATH.',
          evidence: ['which php -> not found'],
          recommendation: 'Install PHP via https://www.php.net/manual/en/install.php.',
          confidence: null,
        });
      }
    }
    return issues;
  }
}

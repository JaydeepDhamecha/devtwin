/**
 * .NET ecosystem adapter (C#/F#/VB).
 */

import { join } from 'node:path';

import {
  Presence,
  Severity,
  type DependencyInfo,
  type HealthIssue,
  type RuntimeInfo,
} from '../core/models.js';
import { runCommand, which } from '../core/runner.js';
import { globAny, pathExists, readJsonFile } from '../system/filesystem.js';
import { EcosystemAdapter, extractVersion } from './base.js';

const PROJECT_GLOBS = [
  '*.csproj',
  '*.fsproj',
  '*.vbproj',
  '**/*.csproj',
  '**/*.fsproj',
  '**/*.vbproj',
];
const SLN_GLOBS = ['*.sln'];

// Upper bound on how many project files we enumerate; the Python glob was
// unbounded but only the count and "did we find any" ever get used.
const MAX_PROJECT_MATCHES = 200;

export class DotnetAdapter extends EcosystemAdapter {
  readonly ecosystem = 'dotnet';

  detect(root: string): boolean {
    if (pathExists(join(root, 'global.json'))) {
      return true;
    }
    // One match from any project/solution glob is enough to claim the project.
    return globAny(root, [...PROJECT_GLOBS, ...SLN_GLOBS], 1).length > 0;
  }

  private requiredVersion(root: string): [string | null, string | null] {
    const globalJson = join(root, 'global.json');
    if (!pathExists(globalJson)) {
      return [null, null];
    }
    // readJsonFile degrades to null on unreadable *or* malformed JSON.
    const data = readJsonFile(globalJson);
    if (data === null) {
      return [null, null];
    }
    const sdk = (data as Record<string, unknown>)['sdk'];
    const version =
      sdk !== null && typeof sdk === 'object' && !Array.isArray(sdk)
        ? ((sdk as Record<string, unknown>)['version'] as string | undefined) ?? null
        : null;
    return [version, version ? 'global.json' : null];
  }

  override async inspectRuntime(root: string): Promise<RuntimeInfo[]> {
    const [required, source] = this.requiredVersion(root);
    const dotnetPath = which('dotnet');
    if (dotnetPath === null) {
      return [
        {
          name: 'dotnet',
          presence: Presence.NOT_INSTALLED,
          installed_version: null,
          required_version: required,
          path: null,
          source,
        },
      ];
    }
    const result = await runCommand([dotnetPath, '--version'], { timeout: 10 });
    const installed = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'dotnet',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        required_version: required,
        path: dotnetPath,
        source,
      },
    ];
  }

  override async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    // globAny already de-duplicates, so this list plays the role of the
    // Python `set(projects)` used for the count.
    const projects = globAny(root, PROJECT_GLOBS, MAX_PROJECT_MATCHES);
    if (projects.length === 0) {
      return null;
    }
    return {
      ecosystem: 'dotnet',
      manager: 'nuget',
      lockfile: null,
      lockfile_present: false,
      manifest_present: true,
      installed: Presence.UNKNOWN,
      dependency_count: null,
      dev_dependency_count: null,
      notes: [`${projects.length} project file(s) found`],
    };
  }

  override async inspectTests(root: string): Promise<string[]> {
    return this.detect(root) ? ['dotnet test'] : [];
  }

  override async inspectBuildCommands(root: string): Promise<string[]> {
    return this.detect(root) ? ['dotnet build'] : [];
  }

  override async healthChecks(_root: string, runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const rt of runtimes) {
      if (rt.name === 'dotnet' && rt.presence === Presence.NOT_INSTALLED) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'dotnet.not_installed',
          title: '.NET SDK not found',
          message: 'No `dotnet` executable was found on PATH.',
          evidence: ['which dotnet -> not found'],
          recommendation:
            'Install the .NET SDK from https://dotnet.microsoft.com/download.',
          confidence: null,
        });
      }
    }
    return issues;
  }
}

/**
 * Go ecosystem adapter.
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
import { pathExists, readTextFile } from '../system/filesystem.js';
import { EcosystemAdapter, extractVersion } from './base.js';

const GO_MOD_VERSION_RE = /^go\s+(\d+(?:\.\d+){1,2})/m;
const GO_MOD_MODULE_RE = /^module\s+(\S+)/m;

export class GoAdapter extends EcosystemAdapter {
  readonly ecosystem = 'go';

  detect(root: string): boolean {
    return ['go.mod', 'go.sum', 'go.work'].some((n) => pathExists(join(root, n)));
  }

  private requiredVersion(root: string): string | null {
    const gomod = join(root, 'go.mod');
    if (!pathExists(gomod)) {
      return null;
    }
    // readTextFile returns null instead of raising when the file is unreadable.
    const text = readTextFile(gomod);
    if (text === null) {
      return null;
    }
    const match = GO_MOD_VERSION_RE.exec(text);
    return match ? match[1]! : null;
  }

  override async inspectRuntime(root: string): Promise<RuntimeInfo[]> {
    const required = this.requiredVersion(root);
    const goPath = which('go');
    if (goPath === null) {
      return [
        {
          name: 'go',
          presence: Presence.NOT_INSTALLED,
          installed_version: null,
          required_version: required,
          path: null,
          source: null,
        },
      ];
    }
    const result = await runCommand([goPath, 'version'], { timeout: 5 });
    const installed = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'go',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        required_version: required,
        path: goPath,
        source: required ? 'go.mod' : null,
      },
    ];
  }

  override async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    const gomod = join(root, 'go.mod');
    if (!pathExists(gomod)) {
      return null;
    }
    const text = readTextFile(gomod) ?? '';
    const moduleMatch = GO_MOD_MODULE_RE.exec(text);
    const notes = moduleMatch ? [`module ${moduleMatch[1]!}`] : [];
    const gosumPresent = pathExists(join(root, 'go.sum'));
    return {
      ecosystem: 'go',
      manager: 'go modules',
      lockfile: gosumPresent ? 'go.sum' : null,
      lockfile_present: gosumPresent,
      manifest_present: true,
      installed: Presence.UNKNOWN,
      dependency_count: null,
      dev_dependency_count: null,
      notes,
    };
  }

  override async inspectTests(root: string): Promise<string[]> {
    return pathExists(join(root, 'go.mod')) ? ['go test ./...'] : [];
  }

  override async inspectBuildCommands(root: string): Promise<string[]> {
    return pathExists(join(root, 'go.mod')) ? ['go build ./...'] : [];
  }

  override async healthChecks(_root: string, runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const rt of runtimes) {
      if (rt.name === 'go' && rt.presence === Presence.NOT_INSTALLED) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'go.not_installed',
          title: 'Go runtime not found',
          message: 'No `go` executable was found on PATH.',
          evidence: ['which go -> not found'],
          recommendation: 'Install Go from https://go.dev/dl/ or your OS package manager.',
          confidence: null,
        });
      }
    }
    return issues;
  }
}

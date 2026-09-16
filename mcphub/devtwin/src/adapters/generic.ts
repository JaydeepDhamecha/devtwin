/**
 * Fallback adapter: useful signal for any project, recognized or not.
 *
 * Every other adapter's `detect()` can return false for a project DevTwin
 * doesn't specifically understand (Ruby, PHP, C++/CMake, ...). This adapter
 * never returns false -- it always looks at Makefile/Taskfile/justfile/
 * Dockerfile/compose files/README/scripts and surfaces whatever it finds, so
 * an unsupported language still gets a useful answer instead of silence.
 */

import { join } from 'node:path';

import {
  Presence,
  Severity,
  type DependencyInfo,
  type HealthIssue,
  type RuntimeInfo,
} from '../core/models.js';
import { existsAny, listTopLevel, pathExists, readTextFile } from '../system/filesystem.js';
import { findComposeFiles } from '../system/docker.js';
import { EcosystemAdapter } from './base.js';

const MAKE_TARGET_RE = /^([a-zA-Z0-9_.-]+):(?!=)/gm;

export class GenericAdapter extends EcosystemAdapter {
  readonly ecosystem = 'generic';

  detect(_root: string): boolean {
    return true;
  }

  override async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    const found = existsAny(root, [
      'Makefile',
      'makefile',
      'Taskfile.yml',
      'justfile',
      'Dockerfile',
    ]);
    const compose = findComposeFiles(root);
    if (found.length === 0 && compose.length === 0) {
      return null;
    }
    return {
      ecosystem: 'generic',
      manager: null,
      lockfile: null,
      lockfile_present: false,
      manifest_present: found.length > 0 || compose.length > 0,
      installed: Presence.UNKNOWN,
      dependency_count: null,
      dev_dependency_count: null,
      notes: [...found, ...compose],
    };
  }

  override async inspectTests(root: string): Promise<string[]> {
    const commands: string[] = [];
    const makefile = join(root, 'Makefile');
    if (pathExists(makefile)) {
      const targets = GenericAdapter.makeTargets(makefile);
      for (const candidate of ['test', 'check']) {
        if (targets.has(candidate)) {
          commands.push(`make ${candidate}`);
        }
      }
    }
    if (pathExists(join(root, 'justfile'))) {
      commands.push('just test');
    }
    if (pathExists(join(root, 'Taskfile.yml'))) {
      commands.push('task test');
    }
    return commands;
  }

  /**
   * Build commands `devtwin_build`/`devtwin_build_all` are allowed to execute.
   *
   * Container commands are deliberately absent: `docker build .` is a real
   * image build (killed half-done at the build timeout, leaving a partial
   * build behind in the shared image store) and `docker compose up` starts
   * containers. Neither is a read-only build check, so they are surfaced as
   * advice by `healthChecks()` -- which nothing ever executes -- instead.
   */
  override async inspectBuildCommands(root: string): Promise<string[]> {
    const commands: string[] = [];
    const makefile = join(root, 'Makefile');
    if (pathExists(makefile)) {
      const targets = GenericAdapter.makeTargets(makefile);
      if (targets.has('build')) {
        commands.push('make build');
      }
    }
    return commands;
  }

  /** Surface container commands as advice, never as something DevTwin runs. */
  override async healthChecks(root: string, _runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    if (pathExists(join(root, 'Dockerfile'))) {
      issues.push({
        severity: Severity.INFO,
        code: 'generic.docker_image_build_available',
        title: 'Dockerfile present -- image build is not run automatically',
        message:
          'DevTwin does not run `docker build .` as a build check: building an image is ' +
          'slow, writes to the local image store, and would be killed mid-way by the ' +
          'build timeout.',
        evidence: ['Dockerfile'],
        recommendation: 'Run `docker build .` yourself when you need the image.',
        confidence: null,
      });
    }
    const compose = findComposeFiles(root);
    if (compose.length > 0) {
      issues.push({
        severity: Severity.INFO,
        code: 'generic.compose_services_available',
        title: 'Compose file present -- containers are not started automatically',
        message:
          'DevTwin never starts containers. Use devtwin_services to see which services ' +
          'this project expects and whether they are already running.',
        evidence: [...compose],
        recommendation: `Run \`docker compose -f ${compose[0]!} up -d\` yourself if needed.`,
        confidence: null,
      });
    }
    return issues;
  }

  notes(root: string): string[] {
    return listTopLevel(root);
  }

  /** Pull `target:` names out of a Makefile, skipping `VAR:=` assignments. */
  private static makeTargets(makefile: string): Set<string> {
    const text = readTextFile(makefile);
    if (text === null) {
      return new Set();
    }
    const targets = new Set<string>();
    // Fresh lastIndex per call: MAKE_TARGET_RE is a module-level /g regex.
    MAKE_TARGET_RE.lastIndex = 0;
    for (const match of text.matchAll(MAKE_TARGET_RE)) {
      targets.add(match[1]!);
    }
    return targets;
  }
}

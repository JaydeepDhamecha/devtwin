/**
 * Swift ecosystem adapter: Swift Package Manager and Xcode (iOS/macOS) projects.
 */

import { basename, join } from 'node:path';

import {
  Presence,
  Severity,
  type DependencyInfo,
  type HealthIssue,
  type RuntimeInfo,
} from '../core/models.js';
import { runCommand, which } from '../core/runner.js';
import { globAny, pathExists, readTextFile } from '../system/filesystem.js';
import { EcosystemAdapter, extractVersion } from './base.js';

const TOOLS_VERSION_RE = /swift-tools-version:\s*([\d.]+)/;

/** Handles Swift Package Manager projects and Xcode (iOS/macOS) projects. */
/** Narrow parsed JSON to a non-empty array of strings, or null. Exported for tests. */
export function asNonEmptyStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const strings = value.filter((v): v is string => typeof v === 'string');
  return strings.length > 0 ? strings : null;
}

export class SwiftAdapter extends EcosystemAdapter {
  readonly ecosystem = 'swift';

  detect(root: string): boolean {
    if (pathExists(join(root, 'Package.swift')) || pathExists(join(root, 'Podfile'))) {
      return true;
    }
    return globAny(root, ['*.xcodeproj'], 1).length > 0 || globAny(root, ['*.xcworkspace'], 1).length > 0;
  }

  private usesSpm(root: string): boolean {
    return pathExists(join(root, 'Package.swift'));
  }

  private usesCocoapods(root: string): boolean {
    return pathExists(join(root, 'Podfile'));
  }

  private usesXcode(root: string): boolean {
    return globAny(root, ['*.xcodeproj'], 1).length > 0 || globAny(root, ['*.xcworkspace'], 1).length > 0;
  }

  /** First `*.xcworkspace` in `root`, or null -- the `next(root.glob(...), None)` equivalent. */
  private firstWorkspace(root: string): string | null {
    const matches = globAny(root, ['*.xcworkspace'], 1);
    return matches.length > 0 ? basename(matches[0]!) : null;
  }

  /** First `*.xcodeproj` in `root`, or null. */
  private firstProject(root: string): string | null {
    const matches = globAny(root, ['*.xcodeproj'], 1);
    return matches.length > 0 ? basename(matches[0]!) : null;
  }

  /**
   * Detect the first buildable scheme from xcodebuild -list -json.
   * Returns null if xcodebuild is missing, not executable, or no scheme found.
   */
  private async detectScheme(root: string): Promise<string | null> {
    if (!this.usesXcode(root)) {
      return null;
    }
    const xcodebuildPath = which('xcodebuild');
    if (xcodebuildPath === null) {
      return null;
    }
    const workspace = this.firstWorkspace(root);
    const project = this.firstProject(root);
    if (!workspace && !project) {
      return null;
    }
    const args = [xcodebuildPath, '-list', '-json'];
    if (workspace) {
      args.push('-workspace', workspace);
    } else if (project) {
      args.push('-project', project);
    }
    const result = await runCommand(args, { cwd: root, timeout: 10 });
    if (!result.available || result.returncode !== 0) {
      return null;
    }
    try {
      const data = JSON.parse(result.stdout) as {
        project?: { schemes?: unknown };
        workspace?: { schemes?: unknown };
      };
      // The Python original relies on an empty list being falsy, so it falls
      // through to the workspace schemes. `[]` is truthy in JS, so the
      // fall-through has to be written out, and an empty list must not
      // produce `undefined` from `schemes[0]`.
      const projectSchemes = asNonEmptyStringArray(data.project?.schemes);
      const workspaceSchemes = asNonEmptyStringArray(data.workspace?.schemes);
      const schemes = projectSchemes ?? workspaceSchemes;
      if (schemes) {
        // ponytail: takes first scheme; explicit param if multi-target needed
        return schemes[0]!;
      }
    } catch {
      // Malformed/absent JSON is a "no scheme found", never an error.
    }
    return null;
  }

  private requiredToolsVersion(root: string): string | null {
    const f = join(root, 'Package.swift');
    if (!pathExists(f)) {
      return null;
    }
    const text = readTextFile(f);
    if (text === null) {
      return null;
    }
    const match = TOOLS_VERSION_RE.exec(text);
    return match ? match[1]! : null;
  }

  override async inspectRuntime(root: string): Promise<RuntimeInfo[]> {
    const required = this.requiredToolsVersion(root);
    const swiftPath = which('swift');
    if (swiftPath === null) {
      return [
        {
          name: 'swift',
          presence: Presence.NOT_INSTALLED,
          required_version: required,
          source: required ? 'Package.swift' : null,
        },
      ];
    }
    const result = await runCommand([swiftPath, '--version'], { timeout: 5 });
    const installed = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'swift',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        required_version: required,
        path: swiftPath,
        source: required ? 'Package.swift' : null,
      },
    ];
  }

  override async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    if (this.usesCocoapods(root)) {
      const lockfile = pathExists(join(root, 'Podfile.lock'));
      return {
        ecosystem: 'swift',
        manager: 'cocoapods',
        lockfile: lockfile ? 'Podfile.lock' : null,
        lockfile_present: lockfile,
        manifest_present: true,
        installed: Presence.UNKNOWN,
        dependency_count: null,
        dev_dependency_count: null,
        notes: [],
      };
    }
    if (this.usesSpm(root)) {
      const lockfile = pathExists(join(root, 'Package.resolved'));
      return {
        ecosystem: 'swift',
        manager: 'spm',
        lockfile: lockfile ? 'Package.resolved' : null,
        lockfile_present: lockfile,
        manifest_present: true,
        installed: Presence.UNKNOWN,
        dependency_count: null,
        dev_dependency_count: null,
        notes: [],
      };
    }
    return null;
  }

  override async inspectBuild(root: string): Promise<RuntimeInfo[]> {
    if (!this.usesXcode(root)) {
      return [];
    }
    const xcodebuildPath = which('xcodebuild');
    if (xcodebuildPath === null) {
      return [{ name: 'xcodebuild', presence: Presence.NOT_INSTALLED }];
    }
    const result = await runCommand([xcodebuildPath, '-version'], { timeout: 5 });
    const installed = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'xcodebuild',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        path: xcodebuildPath,
      },
    ];
  }

  override async inspectTests(root: string): Promise<string[]> {
    const commands: string[] = [];
    if (this.usesSpm(root)) {
      commands.push('swift test');
    } else if (this.usesXcode(root)) {
      const scheme = await this.detectScheme(root);
      if (scheme) {
        const workspace = this.firstWorkspace(root);
        let target: string[];
        if (workspace) {
          target = ['-workspace', workspace];
        } else {
          // Defensive: the .xcodeproj can disappear between the glob in
          // detectScheme and this one -- degrade instead of throwing.
          const project = this.firstProject(root);
          if (project) {
            target = ['-project', project];
          } else {
            return commands;
          }
        }
        commands.push(
          `xcodebuild test -scheme ${scheme} -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' ${target.join(' ')}`,
        );
      }
    }
    return commands;
  }

  override async inspectBuildCommands(root: string): Promise<string[]> {
    const commands: string[] = [];
    if (this.usesSpm(root)) {
      commands.push('swift build');
    } else if (this.usesXcode(root)) {
      const scheme = await this.detectScheme(root);
      if (scheme) {
        const workspace = this.firstWorkspace(root);
        let target: string[];
        if (workspace) {
          target = ['-workspace', workspace];
        } else {
          // Defensive: the .xcodeproj can disappear between the glob in
          // detectScheme and this one -- degrade instead of throwing.
          const project = this.firstProject(root);
          if (project) {
            target = ['-project', project];
          } else {
            return commands;
          }
        }
        commands.push(
          `xcodebuild build -scheme ${scheme} -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO ${target.join(' ')}`,
        );
      }
    }
    return commands;
  }

  override async healthChecks(_root: string, runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const rt of runtimes) {
      if (rt.name === 'swift' && rt.presence === Presence.NOT_INSTALLED) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'swift.not_installed',
          title: 'Swift toolchain not found',
          message: 'No `swift` executable was found on PATH.',
          evidence: ['which swift -> not found'],
          recommendation: 'Install Xcode or the Swift toolchain from https://swift.org/install.',
        });
      }
    }
    return issues;
  }
}

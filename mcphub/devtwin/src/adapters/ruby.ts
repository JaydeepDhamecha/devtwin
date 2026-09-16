/** Ruby ecosystem adapter. */

import { join } from 'node:path';

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

export class RubyAdapter extends EcosystemAdapter {
  readonly ecosystem = 'ruby';

  detect(root: string): boolean {
    if (pathExists(join(root, 'Gemfile'))) {
      return true;
    }
    return globAny(root, ['*.gemspec'], 1).length > 0;
  }

  private requiredVersion(root: string): string | null {
    const file = join(root, '.ruby-version');
    if (!pathExists(file)) {
      return null;
    }
    // readTextFile already degrades to null on any read error (the Python
    // equivalent swallows OSError here).
    const text = readTextFile(file);
    if (text === null) {
      return null;
    }
    return text.trim() || null;
  }

  async inspectRuntime(root: string): Promise<RuntimeInfo[]> {
    const required = this.requiredVersion(root);
    const rubyPath = which('ruby');
    if (rubyPath === null) {
      return [
        {
          name: 'ruby',
          presence: Presence.NOT_INSTALLED,
          installed_version: null,
          required_version: required,
          path: null,
          source: required ? '.ruby-version' : null,
        },
      ];
    }
    const result = await runCommand([rubyPath, '--version'], { timeout: 5 });
    const version = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'ruby',
        presence: version ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: version,
        required_version: required,
        path: rubyPath,
        source: required ? '.ruby-version' : null,
      },
    ];
  }

  async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    if (!pathExists(join(root, 'Gemfile'))) {
      return null;
    }
    const lockfilePresent = pathExists(join(root, 'Gemfile.lock'));
    return {
      ecosystem: 'ruby',
      manager: 'bundler',
      lockfile: lockfilePresent ? 'Gemfile.lock' : null,
      lockfile_present: lockfilePresent,
      manifest_present: true,
      installed: Presence.UNKNOWN,
      dependency_count: null,
      dev_dependency_count: null,
      notes: [],
    };
  }

  async inspectTests(root: string): Promise<string[]> {
    if (pathExists(join(root, 'spec'))) {
      return ['bundle exec rspec'];
    }
    if (pathExists(join(root, 'Rakefile'))) {
      return ['bundle exec rake test'];
    }
    return [];
  }

  async healthChecks(_root: string, runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const rt of runtimes) {
      if (rt.name === 'ruby' && rt.presence === Presence.NOT_INSTALLED) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'ruby.not_installed',
          title: 'Ruby not found',
          message: 'No `ruby` executable was found on PATH.',
          evidence: ['which ruby -> not found'],
          recommendation:
            'Install Ruby via rbenv, rvm, or https://www.ruby-lang.org/en/downloads.',
          confidence: null,
        });
      }
    }
    return issues;
  }
}

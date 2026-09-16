/**
 * Rust ecosystem adapter.
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

const TOOLCHAIN_CHANNEL_RE = /channel\s*=\s*"([^"]+)"/;

export class RustAdapter extends EcosystemAdapter {
  readonly ecosystem = 'rust';

  detect(root: string): boolean {
    return pathExists(join(root, 'Cargo.toml'));
  }

  /**
   * Targeted line/regex read of the toolchain file -- no TOML parser needed:
   * we only ever want the `channel` key, and the bare `rust-toolchain` form
   * is a plain version string on its own.
   */
  private requiredVersion(root: string): [string | null, string | null] {
    for (const filename of ['rust-toolchain.toml', 'rust-toolchain']) {
      const f = join(root, filename);
      if (!pathExists(f)) {
        continue;
      }
      const text = readTextFile(f);
      if (text === null) {
        continue;
      }
      const match = TOOLCHAIN_CHANNEL_RE.exec(text);
      if (match) {
        return [match[1]!, filename];
      }
      const stripped = text.trim();
      if (stripped && filename === 'rust-toolchain') {
        return [stripped, filename];
      }
    }
    return [null, null];
  }

  override async inspectRuntime(root: string): Promise<RuntimeInfo[]> {
    const [required, source] = this.requiredVersion(root);
    const rustcPath = which('rustc');
    if (rustcPath === null) {
      return [
        {
          name: 'rustc',
          presence: Presence.NOT_INSTALLED,
          installed_version: null,
          required_version: required,
          path: null,
          source,
        },
      ];
    }
    const result = await runCommand([rustcPath, '--version'], { timeout: 5 });
    const installed = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'rustc',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        required_version: required,
        path: rustcPath,
        source,
      },
    ];
  }

  override async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    if (!pathExists(join(root, 'Cargo.toml'))) {
      return null;
    }
    const lockfilePresent = pathExists(join(root, 'Cargo.lock'));
    return {
      ecosystem: 'rust',
      manager: 'cargo',
      lockfile: lockfilePresent ? 'Cargo.lock' : null,
      lockfile_present: lockfilePresent,
      manifest_present: true,
      installed: Presence.UNKNOWN,
      dependency_count: null,
      dev_dependency_count: null,
      notes: [],
    };
  }

  override async inspectBuild(_root: string): Promise<RuntimeInfo[]> {
    const cargoPath = which('cargo');
    if (cargoPath === null) {
      return [
        {
          name: 'cargo',
          presence: Presence.NOT_INSTALLED,
          installed_version: null,
          required_version: null,
          path: null,
          source: null,
        },
      ];
    }
    const result = await runCommand([cargoPath, '--version'], { timeout: 5 });
    const installed = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'cargo',
        presence: Presence.INSTALLED,
        installed_version: installed,
        required_version: null,
        path: cargoPath,
        source: null,
      },
    ];
  }

  override async inspectTests(root: string): Promise<string[]> {
    return pathExists(join(root, 'Cargo.toml')) ? ['cargo test'] : [];
  }

  override async inspectBuildCommands(root: string): Promise<string[]> {
    return pathExists(join(root, 'Cargo.toml')) ? ['cargo build'] : [];
  }

  override async healthChecks(_root: string, runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const rt of runtimes) {
      if (rt.name === 'rustc' && rt.presence === Presence.NOT_INSTALLED) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'rust.not_installed',
          title: 'Rust toolchain not found',
          message: 'No `rustc` executable was found on PATH.',
          evidence: ['which rustc -> not found'],
          recommendation: 'Install Rust via https://rustup.rs.',
          confidence: null,
        });
      }
    }
    return issues;
  }
}

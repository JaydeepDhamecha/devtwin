/**
 * Python ecosystem adapter: CPython, uv, pip, poetry, pytest, ruff, mypy.
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
import { existsAny, globAny, pathExists, readTextFile } from '../system/filesystem.js';
import { EcosystemAdapter, extractVersion } from './base.js';

// pyproject.toml is read with targeted regexes rather than a TOML parser: the
// adapter only ever needs `requires-python` and the length of the top-level
// `dependencies` array, so a full parser (and the dependency it would cost)
// buys nothing. Anything these patterns cannot match degrades to null/unknown.
export const REQUIRES_PYTHON_RE = /requires-python\s*=\s*"([^"]+)"/;
// Python's re.DOTALL | re.MULTILINE -- `[\s\S]` stands in for DOTALL here.
export const DEP_ARRAY_RE = /^dependencies\s*=\s*\[([\s\S]*?)\]/m;
export const OPTIONAL_DEP_SECTION_RE = /^\[project\.optional-dependencies\]/m;

/** Python's `str.strip(chars)`: trim any character in `chars` off both ends. */
function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start]!)) start += 1;
  while (end > start && chars.includes(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

/** Python's `str.splitlines()` for the line endings that show up in real files. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function countTomlListItems(block: string): number {
  const items = splitLines(block)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  // Handle single-line arrays: dependencies = ["a", "b"]
  if (items.length === 1 && items[0]!.includes(',')) {
    return items[0]!
      .split(',')
      .filter((p) => stripChars(stripChars(p.trim(), '"'), "'") !== '').length;
  }
  return items.filter((i) => stripChars(i, ',').trim() !== '').length;
}

export class PythonAdapter extends EcosystemAdapter {
  readonly ecosystem = 'python';

  detect(root: string): boolean {
    const indicators = [
      'pyproject.toml',
      'requirements.txt',
      'uv.lock',
      'poetry.lock',
      'Pipfile',
      '.python-version',
    ];
    return existsAny(root, indicators).length > 0;
  }

  /** Returns [required version, where it was read from]. */
  private requiredVersion(root: string): [string | null, string | null] {
    const versionFile = join(root, '.python-version');
    if (pathExists(versionFile)) {
      // readTextFile already degrades to null instead of throwing on an
      // unreadable file, which is what the Python OSError guard did.
      const content = (readTextFile(versionFile) ?? '').trim();
      if (content) {
        return [content, '.python-version'];
      }
    }

    const pyproject = join(root, 'pyproject.toml');
    if (pathExists(pyproject)) {
      const text = readTextFile(pyproject) ?? '';
      const match = REQUIRES_PYTHON_RE.exec(text);
      if (match) {
        return [match[1]!, 'pyproject.toml [project.requires-python]'];
      }
    }
    return [null, null];
  }

  async inspectRuntime(root: string): Promise<RuntimeInfo[]> {
    const [required, source] = this.requiredVersion(root);
    const pythonExe = which('python3') ?? which('python');
    if (pythonExe === null) {
      return [
        {
          name: 'python',
          presence: Presence.NOT_INSTALLED,
          installed_version: null,
          required_version: required,
          path: null,
          source,
        },
      ];
    }
    const result = await runCommand([pythonExe, '--version'], { timeout: 5 });
    // Older CPython prints `--version` on stderr, hence the stdout-or-stderr read.
    const installed = result.available ? extractVersion(result.stdout || result.stderr) : null;
    return [
      {
        name: 'python',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        required_version: required,
        path: pythonExe,
        source,
      },
    ];
  }

  private detectManager(root: string): string | null {
    if (pathExists(join(root, 'uv.lock'))) {
      return 'uv';
    }
    if (pathExists(join(root, 'poetry.lock'))) {
      return 'poetry';
    }
    if (pathExists(join(root, 'Pipfile.lock')) || pathExists(join(root, 'Pipfile'))) {
      return 'pipenv';
    }
    if (pathExists(join(root, 'requirements.txt'))) {
      return 'pip';
    }
    if (pathExists(join(root, 'pyproject.toml'))) {
      return 'pip';
    }
    return null;
  }

  async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    const manifestPresent =
      pathExists(join(root, 'pyproject.toml')) || pathExists(join(root, 'requirements.txt'));
    if (!manifestPresent && !this.detect(root)) {
      return null;
    }

    const manager = this.detectManager(root);
    let lockfile: string | null = null;
    for (const candidate of ['uv.lock', 'poetry.lock', 'Pipfile.lock']) {
      if (pathExists(join(root, candidate))) {
        lockfile = candidate;
        break;
      }
    }

    let depCount: number | null = null;
    const notes: string[] = [];
    const reqFile = join(root, 'requirements.txt');
    const pyproject = join(root, 'pyproject.toml');
    if (pathExists(reqFile)) {
      const text = readTextFile(reqFile);
      if (text !== null) {
        const lines = splitLines(text).filter(
          (ln) => ln.trim() !== '' && !ln.trim().startsWith('#'),
        );
        depCount = lines.length;
      }
    } else if (pathExists(pyproject)) {
      const text = readTextFile(pyproject);
      if (text !== null) {
        const match = DEP_ARRAY_RE.exec(text);
        if (match) {
          depCount = countTomlListItems(match[1]!);
        }
      }
    }

    const venvPresent = pathExists(join(root, '.venv')) || pathExists(join(root, 'venv'));
    const installed = venvPresent ? Presence.INSTALLED : Presence.UNKNOWN;
    if (venvPresent) {
      notes.push('virtual environment found at .venv/ or venv/');
    } else if (manager) {
      notes.push('no .venv/ or venv/ found -- dependencies may not be installed locally');
    }

    return {
      ecosystem: 'python',
      manager,
      lockfile,
      lockfile_present: lockfile !== null,
      manifest_present: manifestPresent,
      installed,
      dependency_count: depCount,
      dev_dependency_count: null,
      notes,
    };
  }

  async inspectBuild(_root: string): Promise<RuntimeInfo[]> {
    const tools: RuntimeInfo[] = [];
    for (const tool of ['uv', 'poetry', 'ruff', 'mypy', 'pytest']) {
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
      const version = result.available ? extractVersion(result.stdout || result.stderr) : null;
      tools.push({
        name: tool,
        presence: Presence.INSTALLED,
        installed_version: version,
        required_version: null,
        path,
        source: null,
      });
    }
    return tools;
  }

  async inspectTests(root: string): Promise<string[]> {
    const commands: string[] = [];
    if (
      pathExists(join(root, 'pyproject.toml')) ||
      globAny(root, ['test_*.py']).length > 0 ||
      pathExists(join(root, 'tests'))
    ) {
      commands.push('pytest');
    }
    if (which('ruff') && pathExists(join(root, 'pyproject.toml'))) {
      commands.push('ruff check .');
    }
    if (which('mypy') && pathExists(join(root, 'pyproject.toml'))) {
      commands.push('mypy .');
    }
    return commands;
  }

  async inspectBuildCommands(root: string): Promise<string[]> {
    if (pathExists(join(root, 'pyproject.toml'))) {
      const manager = this.detectManager(root);
      if (manager === 'uv') {
        return ['uv build'];
      }
      return ['python -m build'];
    }
    return [];
  }

  async inspectEnvironment(_root: string): Promise<EnvironmentVariableStatus[]> {
    const candidates = ['PYTHONPATH', 'VIRTUAL_ENV', 'UV_PROJECT_ENVIRONMENT'];
    return candidates.map((name) => checkEnvVar(name)).filter((status) => status.present);
  }

  async healthChecks(_root: string, runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const rt of runtimes) {
      if (rt.name === 'python' && rt.presence === Presence.NOT_INSTALLED) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'python.not_installed',
          title: 'Python runtime not found',
          message: 'No `python`/`python3` executable was found on PATH.',
          evidence: ['which python3 -> not found', 'which python -> not found'],
          recommendation: 'Install Python (e.g. via pyenv, uv, or your OS package manager).',
          confidence: null,
        });
      }
    }
    return issues;
  }
}

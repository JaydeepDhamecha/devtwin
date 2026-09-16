/**
 * Command allowlisting for anything DevTwin might execute.
 *
 * DevTwin never exposes a generic "run shell command" tool. Every command it
 * can run is a known, read-only or explicitly-approved inspection/check
 * command drawn from this allowlist. This keeps the blast radius of a
 * compromised or confused model bounded to "read version numbers and run
 * recognized test/build commands", not "run arbitrary code".
 */

/**
 * Executables DevTwin is allowed to invoke at all. Anything not in this set
 * is refused before a subprocess is ever started.
 */
export const ALLOWED_EXECUTABLES = new Set([
  // version control
  'git',
  // python
  'python',
  'python3',
  'uv',
  'pip',
  'pip3',
  'poetry',
  'pytest',
  'ruff',
  'mypy',
  // node
  'node',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  // jvm
  'java',
  'javac',
  'gradle',
  'mvn',
  'kotlinc',
  './gradlew',
  'gradlew',
  'gradlew.bat',
  './mvnw',
  'mvnw',
  'mvnw.cmd',
  // go
  'go',
  // rust
  'cargo',
  'rustc',
  // dotnet
  'dotnet',
  // swift
  'swift',
  'xcodebuild',
  'pod',
  // ruby
  'ruby',
  'bundle',
  'rake',
  // php
  'php',
  'composer',
  'phpunit',
  'vendor/bin/phpunit',
  // docker
  'docker',
  'docker-compose',
  // generic task runners -- the generic adapter only ever emits a recognized
  // target it found in the file itself (`make build`, `just test`), and the
  // denylist below still blocks destructive targets such as `make clean`.
  // Equivalent in risk to `npm run build`, which runs an arbitrary script.
  'make',
  'just',
  'task',
]);

/**
 * Explicit denylist of dangerous subcommands, even for allowlisted
 * executables. devtwin_check / devtwin_prepare must never trigger these.
 */
export const DANGEROUS_ARG_PATTERNS = [
  'reset',
  'clean',
  'push',
  '--force',
  '-f',
  'down',
  'rm',
  'kill',
  'delete',
  'prune',
  'uninstall',
  'remove',
];

export function isAllowedExecutable(executable: string): boolean {
  const base = executable.split('/').pop()!.split('\\').pop()!;
  return ALLOWED_EXECUTABLES.has(executable) || ALLOWED_EXECUTABLES.has(base);
}

/** Best-effort check that a command isn't a destructive one in disguise. */
export function isDangerous(args: string[]): boolean {
  const lowered = args.map((a) => a.toLowerCase());
  return DANGEROUS_ARG_PATTERNS.some((pattern) => lowered.includes(pattern));
}

/**
 * Split a recognized command string into argv without ever invoking a shell.
 * Handles the quoting forms that appear in project manifests; anything with
 * shell metacharacters is rejected by the caller's allowlist check anyway.
 */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current.length > 0) args.push(current);
  return args;
}

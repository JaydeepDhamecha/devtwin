/**
 * Safe subprocess execution.
 *
 * Every command DevTwin runs goes through `runCommand`. It never uses a
 * shell, always has a timeout, always captures output, and truncates output
 * to a sane maximum size. Callers pass an explicit argument list -- there is
 * no path from user-supplied text to a shell string anywhere in this module.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve as resolvePath } from 'node:path';

import type { CommandResult } from './models.js';

export const MAX_OUTPUT_CHARS = 20_000;
export const DEFAULT_TIMEOUT_SECONDS = 10;

/**
 * How much output we let a command produce before Node kills it. The Python
 * original captured everything and sliced to MAX_OUTPUT_CHARS; a build log
 * routinely runs past 80KB, so the ceiling is generous and the truncation is
 * done by us, not by the buffer limit.
 */
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

/**
 * What `CommandResult.timed_out` means for every result this module builds:
 * DevTwin stopped the process itself, so it never reached an exit status and
 * there is no verdict to report -- neither a pass nor a failure. Two things
 * cause it: the command outlived its timeout, and the command produced more
 * than MAX_CAPTURE_BYTES of output. `returncode` is null in both cases, which
 * is what keeps them out of the "failed" bucket callers partition on; a
 * genuine non-zero exit always carries a number. The two are told apart by
 * OUTPUT_OVERFLOW_NOTE, which is prefixed to `stderr` for the second.
 */
export const OUTPUT_OVERFLOW_NOTE =
  `devtwin: stopped -- the command produced more than ${MAX_CAPTURE_BYTES} bytes of ` +
  'output. It did not finish, so there is no pass or fail to report.';

/** Resolve an executable on PATH without invoking a shell (the `which` equivalent). */
export function which(executable: string): string | null {
  if (executable.includes('/') || executable.includes('\\')) {
    const candidate = isAbsolute(executable) ? executable : join(process.cwd(), executable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  }

  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Resolve the executable a caller asked for, honouring `cwd`.
 *
 * A bare name (`git`) is a PATH lookup and an absolute path is taken as
 * given -- both are `which`'s job. Anything else is a path relative to the
 * project being inspected: `./gradlew`, but equally `vendor/bin/phpunit` or
 * `node_modules/.bin/tsc`. Those must be joined to the workspace, because
 * `which` resolves relative paths against `process.cwd()` -- the plugin
 * server's directory, which is not where the project lives. `which` is
 * exported and used elsewhere, so the workspace-relative rule lives here in
 * the call path rather than changing its contract.
 */
function resolveExecutable(executable: string, cwd?: string): string | null {
  const isPathLike = executable.includes('/') || executable.includes('\\');
  if (!isPathLike || isAbsolute(executable) || !cwd) return which(executable);

  const candidate = resolvePath(cwd, executable);
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
}

export interface RunOptions {
  cwd?: string;
  /** seconds */
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `args` (argv-style, never a shell string) and capture the result.
 *
 * Returns a structured CommandResult in all cases -- including "executable
 * not found", "timed out", and "permission denied" -- instead of throwing,
 * so callers never need to wrap every call in try/catch.
 */
export async function runCommand(args: string[], options: RunOptions = {}): Promise<CommandResult> {
  if (args.length === 0) {
    throw new Error('args must be a non-empty argument list');
  }

  const executable = args[0]!;
  const rest = args.slice(1);
  const timeoutSeconds = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;

  // A relative executable such as ./gradlew or vendor/bin/phpunit resolves
  // against cwd, not process.cwd().
  const resolved = resolveExecutable(executable, options.cwd);

  if (resolved === null) {
    return {
      executable,
      args: rest,
      returncode: null,
      stdout: '',
      stderr: '',
      timed_out: false,
      available: false,
      duration_ms: 0,
    };
  }

  const start = Date.now();
  const resolvedPath: string = resolved;

  return await new Promise<CommandResult>((resolve) => {
    execFile(
      resolvedPath,
      rest,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: timeoutSeconds * 1000,
        maxBuffer: MAX_CAPTURE_BYTES,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const duration_ms = Date.now() - start;
        const out = truncate(String(stdout ?? ''));
        const err = truncate(String(stderr ?? ''));

        if (error) {
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;

          if (killed || code === 'ETIMEDOUT') {
            resolve({
              executable,
              args: rest,
              returncode: null,
              stdout: out,
              stderr: '',
              timed_out: true,
              available: true,
              duration_ms,
            });
            return;
          }

          if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            // The command ran and produced more output than we allow, so Node
            // killed it: it launched, but it never reached an exit status.
            // `timed_out` is how this module says "we stopped it, there is no
            // verdict" (see OUTPUT_OVERFLOW_NOTE above), and it is what keeps
            // a merely noisy command out of the failed bucket -- a caller
            // partitioning on `returncode === 0` would otherwise report a
            // build error that never happened. The note in stderr is what
            // distinguishes this from a command stopped at the timeout, and
            // the null returncode what distinguishes both from a real
            // non-zero exit. Keep whatever was captured before the kill.
            resolve({
              executable,
              args: rest,
              returncode: null,
              stdout: out,
              stderr: err ? `${OUTPUT_OVERFLOW_NOTE}\n${err}` : OUTPUT_OVERFLOW_NOTE,
              timed_out: true,
              available: true,
              duration_ms,
            });
            return;
          }

          if (typeof code === 'string') {
            // ENOENT / EACCES / EPERM -- the executable could not be run at all.
            resolve({
              executable,
              args: rest,
              returncode: null,
              stdout: '',
              stderr: error.message,
              timed_out: false,
              available: false,
              duration_ms,
            });
            return;
          }

          // Ordinary non-zero exit: this is a result, not a failure to run.
          resolve({
            executable,
            args: rest,
            returncode: typeof code === 'number' ? code : 1,
            stdout: out,
            stderr: err,
            timed_out: false,
            available: true,
            duration_ms,
          });
          return;
        }

        resolve({
          executable,
          args: rest,
          returncode: 0,
          stdout: out,
          stderr: err,
          timed_out: false,
          available: true,
          duration_ms,
        });
      },
    );
  });
}

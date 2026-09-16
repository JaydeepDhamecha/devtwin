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
import { delimiter, isAbsolute, join } from 'node:path';

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

  // A relative executable such as ./gradlew resolves against cwd, not process.cwd().
  let resolved: string | null;
  if (executable.startsWith('./') && options.cwd) {
    const candidate = join(options.cwd, executable.slice(2));
    try {
      accessSync(candidate, constants.X_OK);
      resolved = candidate;
    } catch {
      resolved = null;
    }
  } else {
    resolved = which(executable);
  }

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
            // The command ran and produced more output than we allow. That is
            // a result, not a failure to launch: keep what was captured.
            resolve({
              executable,
              args: rest,
              returncode: null,
              stdout: out,
              stderr: err,
              timed_out: false,
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

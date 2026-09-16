/**
 * Workspace and Git state inspection. Read-only: never mutates Git state.
 *
 * Every Git call goes through `runCommand` (argv, no shell, explicit timeout)
 * and only ever asks Git to *report* -- rev-parse and status. Failures degrade
 * into "not a repo" rather than propagating an exception to the caller.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import type { GitState, WorkspaceState } from './models.js';
import { runCommand } from './runner.js';
import { isDirectory, pathExists } from '../system/filesystem.js';

/** Expand a leading `~` and resolve to an absolute, symlink-free path. */
function expandAndResolve(root: string): string {
  let expanded = root;
  if (expanded === '~') {
    expanded = homedir();
  } else if (expanded.startsWith('~/')) {
    expanded = join(homedir(), expanded.slice(2));
  }
  const absolute = resolvePath(expanded);
  try {
    // Mirrors Path.resolve(): follow symlinks when the path exists, and fall
    // back to the plain absolute path when it does not.
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** A GitState for "this directory is not a Git repository". */
function notARepo(): GitState {
  return {
    is_repo: false,
    branch: null,
    dirty: false,
    staged_files: [],
    unstaged_files: [],
    untracked_files: [],
    has_conflicts: false,
    root: null,
  };
}

export async function inspectGit(root: string): Promise<GitState> {
  const toplevel = await runCommand(['git', 'rev-parse', '--show-toplevel'], {
    cwd: root,
    timeout: 5,
  });
  if (!toplevel.available || toplevel.returncode !== 0) {
    return notARepo();
  }

  const repoRoot = toplevel.stdout.trim() || root;

  const branchResult = await runCommand(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    timeout: 5,
  });
  const branch = branchResult.returncode === 0 ? branchResult.stdout.trim() : null;

  const statusResult = await runCommand(['git', 'status', '--porcelain=v1'], {
    cwd: root,
    timeout: 5,
  });
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  let hasConflicts = false;

  if (statusResult.available && statusResult.returncode === 0) {
    for (const line of statusResult.stdout.split('\n')) {
      if (line.length < 3) continue;
      const indexStatus = line[0]!;
      const worktreeStatus = line[1]!;
      const path = line.slice(3);
      // Unmerged paths: either side flagged "U", or the both-added/both-deleted pairs.
      if (
        indexStatus === 'U' ||
        worktreeStatus === 'U' ||
        (indexStatus === 'A' && worktreeStatus === 'A') ||
        (indexStatus === 'D' && worktreeStatus === 'D')
      ) {
        hasConflicts = true;
      }
      if (indexStatus === '?' && worktreeStatus === '?') {
        untracked.push(path);
        continue;
      }
      if (indexStatus !== ' ' && indexStatus !== '?') {
        staged.push(path);
      }
      if (worktreeStatus !== ' ' && worktreeStatus !== '?') {
        unstaged.push(path);
      }
    }
  }

  const dirty = staged.length > 0 || unstaged.length > 0 || untracked.length > 0;

  return {
    is_repo: true,
    branch,
    dirty,
    staged_files: staged,
    unstaged_files: unstaged,
    untracked_files: untracked,
    has_conflicts: hasConflicts,
    root: repoRoot,
  };
}

export async function inspectWorkspace(root: string): Promise<WorkspaceState> {
  const path = expandAndResolve(root);
  const exists = pathExists(path);
  const isDir = exists ? isDirectory(path) : false;
  const gitState = isDir ? await inspectGit(path) : null;
  return { root: path, exists, is_directory: isDir, git: gitState };
}

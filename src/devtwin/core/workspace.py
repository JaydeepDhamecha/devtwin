"""Workspace and Git state inspection. Read-only: never mutates Git state."""

from __future__ import annotations

from pathlib import Path

from devtwin.core.models import GitState, WorkspaceState
from devtwin.core.runner import run_command


def inspect_git(root: Path) -> GitState:
    toplevel = run_command(["git", "rev-parse", "--show-toplevel"], cwd=str(root), timeout=5)
    if not toplevel.available or toplevel.returncode != 0:
        return GitState(is_repo=False)

    repo_root = toplevel.stdout.strip() or str(root)

    branch_result = run_command(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=str(root), timeout=5
    )
    branch = branch_result.stdout.strip() if branch_result.returncode == 0 else None

    status_result = run_command(["git", "status", "--porcelain=v1"], cwd=str(root), timeout=5)
    staged: list[str] = []
    unstaged: list[str] = []
    untracked: list[str] = []
    has_conflicts = False

    if status_result.available and status_result.returncode == 0:
        for line in status_result.stdout.splitlines():
            if len(line) < 3:
                continue
            index_status, worktree_status, path = line[0], line[1], line[3:]
            if (
                index_status == "U"
                or worktree_status == "U"
                or (index_status, worktree_status)
                in {
                    ("A", "A"),
                    ("D", "D"),
                }
            ):
                has_conflicts = True
            if index_status == "?" and worktree_status == "?":
                untracked.append(path)
                continue
            if index_status not in (" ", "?"):
                staged.append(path)
            if worktree_status not in (" ", "?"):
                unstaged.append(path)

    dirty = bool(staged or unstaged or untracked)

    return GitState(
        is_repo=True,
        branch=branch,
        dirty=dirty,
        staged_files=staged,
        unstaged_files=unstaged,
        untracked_files=untracked,
        has_conflicts=has_conflicts,
        root=repo_root,
    )


def inspect_workspace(root: str) -> WorkspaceState:
    path = Path(root).expanduser().resolve()
    exists = path.exists()
    is_dir = path.is_dir() if exists else False
    git_state = inspect_git(path) if is_dir else None
    return WorkspaceState(root=str(path), exists=exists, is_directory=is_dir, git=git_state)

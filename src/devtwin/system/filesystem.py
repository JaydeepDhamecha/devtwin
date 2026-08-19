"""Filesystem helpers used by detection and inspection.

Kept intentionally simple: a bounded, non-recursive-into-ignored-dirs walk
that's fast enough to run on every ``dev_detect`` call.
"""

from __future__ import annotations

from pathlib import Path

IGNORED_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "target",
    "build",
    "dist",
    ".gradle",
    ".idea",
    ".vscode",
    "bin",
    "obj",
    ".terraform",
}

GENERATED_MARKERS = {
    "dist",
    "build",
    "target",
    ".next",
    "out",
    "node_modules",
    "__pycache__",
    ".venv",
}


def exists_any(root: Path, names: list[str]) -> list[str]:
    """Return which of ``names`` exist directly under ``root``."""
    found = []
    for name in names:
        if (root / name).exists():
            found.append(name)
    return found


def glob_any(root: Path, patterns: list[str], max_matches: int = 5) -> list[str]:
    """Return up to ``max_matches`` relative paths matching any glob pattern."""
    matches: list[str] = []
    for pattern in patterns:
        for path in root.glob(pattern):
            try:
                rel = str(path.relative_to(root))
            except ValueError:
                rel = str(path)
            if rel not in matches:
                matches.append(rel)
            if len(matches) >= max_matches:
                return matches
    return matches


def list_top_level(root: Path) -> list[str]:
    if not root.exists() or not root.is_dir():
        return []
    entries = []
    for entry in sorted(root.iterdir()):
        if entry.name in IGNORED_DIRS:
            continue
        entries.append(entry.name)
    return entries


def has_generated_artifacts(root: Path) -> list[str]:
    return [m for m in GENERATED_MARKERS if (root / m).exists()]

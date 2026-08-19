"""Ecosystem adapter contract.

Every language adapter implements this interface. ``run()`` is the only
method callers use directly -- it calls each inspection step and catches
exceptions per-step, so one broken/missing tool (e.g. Java not installed)
degrades that single field instead of crashing the whole adapter or server.
"""

from __future__ import annotations

import logging
import re
from abc import ABC, abstractmethod
from pathlib import Path

from devtwin.core.models import (
    AdapterResult,
    DependencyInfo,
    EnvironmentVariableStatus,
    HealthIssue,
    RuntimeInfo,
)

logger = logging.getLogger("devtwin.adapters")

_VERSION_RE = re.compile(r"(\d+(?:\.\d+){0,3})")


def extract_version(text: str) -> str | None:
    """Pull the first dotted-number version string out of free-form CLI output."""
    match = _VERSION_RE.search(text)
    return match.group(1) if match else None


def version_tuple(version: str) -> tuple[int, ...]:
    parts = []
    for chunk in version.split("."):
        digits = "".join(c for c in chunk if c.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def major_version(version: str | None) -> int | None:
    if not version:
        return None
    t = version_tuple(version)
    return t[0] if t else None


def _gte(a: tuple[int, ...], b: tuple[int, ...]) -> bool:
    n = max(len(a), len(b))
    return a + (0,) * (n - len(a)) >= b + (0,) * (n - len(b))


def version_mismatch(required: str, installed: str) -> bool:
    """Return True if `installed` does not satisfy `required`.

    - ">=X": satisfied by any installed version >= X (a newer version is fine).
    - "^X" (npm caret): satisfied by same major, installed >= X.
    - "~X" (npm tilde): satisfied by same major.minor, installed >= X.
    - Bare ("21", "3.12", or any other prefix we don't special-case): compared
      as an approximate pin -- only as many components as given are checked
      for equality. A single-number pin ("21") checks major only (matches how
      Java/Node/pnpm compatibility is usually communicated); a two-part pin
      ("3.12", "1.22") checks major.minor (matches Python/Go, where the minor
      version carries real compatibility meaning).
    """
    stripped = required.strip()
    installed_parts = version_tuple(installed)

    if stripped.startswith(">="):
        expected_parts = version_tuple(stripped[2:])
        return bool(expected_parts) and not _gte(installed_parts, expected_parts)

    if stripped.startswith("^"):
        expected_parts = version_tuple(stripped[1:])
        if not expected_parts:
            return False
        return not (
            installed_parts[:1] == expected_parts[:1] and _gte(installed_parts, expected_parts)
        )

    if stripped.startswith("~"):
        expected_parts = version_tuple(stripped[1:])
        if not expected_parts:
            return False
        compare_len = min(2, len(expected_parts))
        return not (
            installed_parts[:compare_len] == expected_parts[:compare_len]
            and _gte(installed_parts, expected_parts)
        )

    cleaned = stripped.lstrip("=v< ").split(",")[0].strip()
    expected_parts = version_tuple(cleaned)
    if not expected_parts:
        return False
    return installed_parts[: len(expected_parts)] != expected_parts


class EcosystemAdapter(ABC):
    ecosystem: str

    @abstractmethod
    def detect(self, root: Path) -> bool:
        """Cheap, file-based check for whether this adapter applies."""

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        return []

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        return None

    def inspect_build(self, root: Path) -> list[RuntimeInfo]:
        return []

    def inspect_tests(self, root: Path) -> list[str]:
        return []

    def inspect_build_commands(self, root: Path) -> list[str]:
        return []

    def inspect_environment(self, root: Path) -> list[EnvironmentVariableStatus]:
        return []

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        return []

    def run(self, root: Path) -> AdapterResult:
        applicable = self._safe(self.detect, root, default=False)
        result = AdapterResult(ecosystem=self.ecosystem, applicable=bool(applicable))
        if not applicable:
            return result

        result.runtimes = self._safe(self.inspect_runtime, root, default=[])
        result.dependencies = self._safe(self.inspect_dependencies, root, default=None)
        result.build_tools = self._safe(self.inspect_build, root, default=[])
        result.test_commands = self._safe(self.inspect_tests, root, default=[])
        result.build_commands = self._safe(self.inspect_build_commands, root, default=[])
        result.environment = self._safe(self.inspect_environment, root, default=[])
        result.issues = self._safe(self.health_checks, root, result.runtimes, default=[])
        return result

    def _safe(self, fn, *args, default):
        try:
            return fn(*args)
        except Exception:  # noqa: BLE001 -- adapters must never crash the server
            logger.warning("adapter %s: %s failed", self.ecosystem, fn.__name__, exc_info=True)
            return default

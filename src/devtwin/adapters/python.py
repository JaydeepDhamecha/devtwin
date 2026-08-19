"""Python ecosystem adapter: CPython, uv, pip, poetry, pytest, ruff, mypy."""

from __future__ import annotations

import re
from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import (
    DependencyInfo,
    EnvironmentVariableStatus,
    HealthIssue,
    Presence,
    RuntimeInfo,
    Severity,
)
from devtwin.core.runner import run_command, which
from devtwin.system.environment import check_env_var

REQUIRES_PYTHON_RE = re.compile(r'requires-python\s*=\s*"([^"]+)"')
DEP_ARRAY_RE = re.compile(r"^dependencies\s*=\s*\[(.*?)\]", re.DOTALL | re.MULTILINE)
OPTIONAL_DEP_SECTION_RE = re.compile(r"^\[project\.optional-dependencies\]", re.MULTILINE)


def _count_toml_list_items(block: str) -> int:
    items = [
        line.strip()
        for line in block.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    # Handle single-line arrays: dependencies = ["a", "b"]
    if len(items) == 1 and "," in items[0]:
        return len([p for p in items[0].split(",") if p.strip().strip('"').strip("'")])
    return len([i for i in items if i.strip(",").strip()])


class PythonAdapter(EcosystemAdapter):
    ecosystem = "python"

    def detect(self, root: Path) -> bool:
        indicators = [
            "pyproject.toml",
            "requirements.txt",
            "uv.lock",
            "poetry.lock",
            "Pipfile",
            ".python-version",
        ]
        return any((root / name).exists() for name in indicators)

    def _required_version(self, root: Path) -> tuple[str | None, str | None]:
        version_file = root / ".python-version"
        if version_file.exists():
            try:
                content = version_file.read_text(encoding="utf-8").strip()
                if content:
                    return content, ".python-version"
            except OSError:
                pass

        pyproject = root / "pyproject.toml"
        if pyproject.exists():
            try:
                text = pyproject.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                text = ""
            match = REQUIRES_PYTHON_RE.search(text)
            if match:
                return match.group(1), "pyproject.toml [project.requires-python]"
        return None, None

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        required, source = self._required_version(root)
        python_exe = which("python3") or which("python")
        if python_exe is None:
            return [
                RuntimeInfo(
                    name="python",
                    presence=Presence.NOT_INSTALLED,
                    required_version=required,
                    source=source,
                )
            ]
        result = run_command([python_exe, "--version"], timeout=5)
        installed = extract_version(result.stdout or result.stderr) if result.available else None
        return [
            RuntimeInfo(
                name="python",
                presence=Presence.INSTALLED if installed else Presence.UNKNOWN,
                installed_version=installed,
                required_version=required,
                path=python_exe,
                source=source,
            )
        ]

    def _detect_manager(self, root: Path) -> str | None:
        if (root / "uv.lock").exists():
            return "uv"
        if (root / "poetry.lock").exists():
            return "poetry"
        if (root / "Pipfile.lock").exists() or (root / "Pipfile").exists():
            return "pipenv"
        if (root / "requirements.txt").exists():
            return "pip"
        if (root / "pyproject.toml").exists():
            return "pip"
        return None

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        manifest_present = (root / "pyproject.toml").exists() or (
            root / "requirements.txt"
        ).exists()
        if not manifest_present and not self.detect(root):
            return None

        manager = self._detect_manager(root)
        lockfile = None
        for candidate in ("uv.lock", "poetry.lock", "Pipfile.lock"):
            if (root / candidate).exists():
                lockfile = candidate
                break

        dep_count = None
        notes: list[str] = []
        req_file = root / "requirements.txt"
        pyproject = root / "pyproject.toml"
        if req_file.exists():
            try:
                lines = [
                    ln
                    for ln in req_file.read_text(encoding="utf-8", errors="ignore").splitlines()
                    if ln.strip() and not ln.strip().startswith("#")
                ]
                dep_count = len(lines)
            except OSError:
                pass
        elif pyproject.exists():
            try:
                text = pyproject.read_text(encoding="utf-8", errors="ignore")
                match = DEP_ARRAY_RE.search(text)
                if match:
                    dep_count = _count_toml_list_items(match.group(1))
            except OSError:
                pass

        venv_present = (root / ".venv").exists() or (root / "venv").exists()
        installed = Presence.INSTALLED if venv_present else Presence.UNKNOWN
        if venv_present:
            notes.append("virtual environment found at .venv/ or venv/")
        elif manager:
            notes.append("no .venv/ or venv/ found -- dependencies may not be installed locally")

        return DependencyInfo(
            ecosystem="python",
            manager=manager,
            lockfile=lockfile,
            lockfile_present=lockfile is not None,
            manifest_present=manifest_present,
            installed=installed,
            dependency_count=dep_count,
            notes=notes,
        )

    def inspect_build(self, root: Path) -> list[RuntimeInfo]:
        tools: list[RuntimeInfo] = []
        for tool in ("uv", "poetry", "ruff", "mypy", "pytest"):
            path = which(tool)
            if path is None:
                tools.append(RuntimeInfo(name=tool, presence=Presence.NOT_INSTALLED))
                continue
            result = run_command([tool, "--version"], timeout=5)
            version = extract_version(result.stdout or result.stderr) if result.available else None
            tools.append(
                RuntimeInfo(
                    name=tool,
                    presence=Presence.INSTALLED,
                    installed_version=version,
                    path=path,
                )
            )
        return tools

    def inspect_tests(self, root: Path) -> list[str]:
        commands = []
        if (
            (root / "pyproject.toml").exists()
            or list(root.glob("test_*.py"))
            or (root / "tests").exists()
        ):
            commands.append("pytest")
        if which("ruff") and (root / "pyproject.toml").exists():
            commands.append("ruff check .")
        if which("mypy") and (root / "pyproject.toml").exists():
            commands.append("mypy .")
        return commands

    def inspect_build_commands(self, root: Path) -> list[str]:
        if (root / "pyproject.toml").exists():
            manager = self._detect_manager(root)
            if manager == "uv":
                return ["uv build"]
            return ["python -m build"]
        return []

    def inspect_environment(self, root: Path) -> list[EnvironmentVariableStatus]:
        candidates = ["PYTHONPATH", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"]
        return [check_env_var(name) for name in candidates if check_env_var(name).present]

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        issues: list[HealthIssue] = []
        for rt in runtimes:
            if rt.name == "python" and rt.presence == Presence.NOT_INSTALLED:
                issues.append(
                    HealthIssue(
                        severity=Severity.CRITICAL,
                        code="python.not_installed",
                        title="Python runtime not found",
                        message="No `python`/`python3` executable was found on PATH.",
                        evidence=["which python3 -> not found", "which python -> not found"],
                        recommendation="Install Python (e.g. via pyenv, uv, or your OS package manager).",
                    )
                )
        return issues

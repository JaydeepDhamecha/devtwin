""" ".NET ecosystem adapter (C#/F#/VB)."""

from __future__ import annotations

import json
from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import DependencyInfo, HealthIssue, Presence, RuntimeInfo, Severity
from devtwin.core.runner import run_command, which

PROJECT_GLOBS = ["*.csproj", "*.fsproj", "*.vbproj", "**/*.csproj", "**/*.fsproj", "**/*.vbproj"]
SLN_GLOBS = ["*.sln"]


class DotnetAdapter(EcosystemAdapter):
    ecosystem = "dotnet"

    def detect(self, root: Path) -> bool:
        if (root / "global.json").exists():
            return True
        for pattern in [*PROJECT_GLOBS, *SLN_GLOBS]:
            if next(root.glob(pattern), None) is not None:
                return True
        return False

    def _required_version(self, root: Path) -> tuple[str | None, str | None]:
        global_json = root / "global.json"
        if not global_json.exists():
            return None, None
        try:
            data = json.loads(global_json.read_text(encoding="utf-8", errors="ignore"))
        except (OSError, json.JSONDecodeError):
            return None, None
        version = data.get("sdk", {}).get("version") if isinstance(data.get("sdk"), dict) else None
        return version, "global.json" if version else None

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        required, source = self._required_version(root)
        dotnet_path = which("dotnet")
        if dotnet_path is None:
            return [
                RuntimeInfo(
                    name="dotnet",
                    presence=Presence.NOT_INSTALLED,
                    required_version=required,
                    source=source,
                )
            ]
        result = run_command([dotnet_path, "--version"], timeout=10)
        installed = extract_version(result.stdout) if result.available else None
        return [
            RuntimeInfo(
                name="dotnet",
                presence=Presence.INSTALLED if installed else Presence.UNKNOWN,
                installed_version=installed,
                required_version=required,
                path=dotnet_path,
                source=source,
            )
        ]

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        projects: list[str] = []
        for pattern in PROJECT_GLOBS:
            projects.extend(str(p.relative_to(root)) for p in root.glob(pattern))
        if not projects:
            return None
        return DependencyInfo(
            ecosystem="dotnet",
            manager="nuget",
            lockfile=None,
            manifest_present=True,
            notes=[f"{len(set(projects))} project file(s) found"],
        )

    def inspect_tests(self, root: Path) -> list[str]:
        return ["dotnet test"] if self.detect(root) else []

    def inspect_build_commands(self, root: Path) -> list[str]:
        return ["dotnet build"] if self.detect(root) else []

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        issues = []
        for rt in runtimes:
            if rt.name == "dotnet" and rt.presence == Presence.NOT_INSTALLED:
                issues.append(
                    HealthIssue(
                        severity=Severity.CRITICAL,
                        code="dotnet.not_installed",
                        title=".NET SDK not found",
                        message="No `dotnet` executable was found on PATH.",
                        evidence=["which dotnet -> not found"],
                        recommendation="Install the .NET SDK from https://dotnet.microsoft.com/download.",
                    )
                )
        return issues

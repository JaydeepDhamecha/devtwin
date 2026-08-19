"""Go ecosystem adapter."""

from __future__ import annotations

import re
from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import DependencyInfo, HealthIssue, Presence, RuntimeInfo, Severity
from devtwin.core.runner import run_command, which

GO_MOD_VERSION_RE = re.compile(r"^go\s+(\d+(?:\.\d+){1,2})", re.MULTILINE)
GO_MOD_MODULE_RE = re.compile(r"^module\s+(\S+)", re.MULTILINE)


class GoAdapter(EcosystemAdapter):
    ecosystem = "go"

    def detect(self, root: Path) -> bool:
        return any((root / n).exists() for n in ("go.mod", "go.sum", "go.work"))

    def _required_version(self, root: Path) -> str | None:
        gomod = root / "go.mod"
        if not gomod.exists():
            return None
        try:
            text = gomod.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return None
        match = GO_MOD_VERSION_RE.search(text)
        return match.group(1) if match else None

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        required = self._required_version(root)
        go_path = which("go")
        if go_path is None:
            return [
                RuntimeInfo(name="go", presence=Presence.NOT_INSTALLED, required_version=required)
            ]
        result = run_command([go_path, "version"], timeout=5)
        installed = extract_version(result.stdout) if result.available else None
        return [
            RuntimeInfo(
                name="go",
                presence=Presence.INSTALLED if installed else Presence.UNKNOWN,
                installed_version=installed,
                required_version=required,
                path=go_path,
                source="go.mod" if required else None,
            )
        ]

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        gomod = root / "go.mod"
        if not gomod.exists():
            return None
        try:
            text = gomod.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            text = ""
        module_match = GO_MOD_MODULE_RE.search(text)
        notes = [f"module {module_match.group(1)}"] if module_match else []
        gosum = root / "go.sum"
        return DependencyInfo(
            ecosystem="go",
            manager="go modules",
            lockfile="go.sum" if gosum.exists() else None,
            lockfile_present=gosum.exists(),
            manifest_present=True,
            notes=notes,
        )

    def inspect_tests(self, root: Path) -> list[str]:
        return ["go test ./..."] if (root / "go.mod").exists() else []

    def inspect_build_commands(self, root: Path) -> list[str]:
        return ["go build ./..."] if (root / "go.mod").exists() else []

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        issues = []
        for rt in runtimes:
            if rt.name == "go" and rt.presence == Presence.NOT_INSTALLED:
                issues.append(
                    HealthIssue(
                        severity=Severity.CRITICAL,
                        code="go.not_installed",
                        title="Go runtime not found",
                        message="No `go` executable was found on PATH.",
                        evidence=["which go -> not found"],
                        recommendation="Install Go from https://go.dev/dl/ or your OS package manager.",
                    )
                )
        return issues

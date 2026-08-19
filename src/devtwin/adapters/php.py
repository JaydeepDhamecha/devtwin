"""PHP ecosystem adapter: Composer-based projects."""

from __future__ import annotations

import json
from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import DependencyInfo, HealthIssue, Presence, RuntimeInfo, Severity
from devtwin.core.runner import run_command, which


def _read_composer_json(root: Path) -> dict:
    f = root / "composer.json"
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8", errors="ignore"))
    except (OSError, json.JSONDecodeError):
        return {}


class PhpAdapter(EcosystemAdapter):
    ecosystem = "php"

    def detect(self, root: Path) -> bool:
        return (root / "composer.json").exists()

    def _required_version(self, root: Path) -> str | None:
        require = _read_composer_json(root).get("require", {})
        return require.get("php") if isinstance(require, dict) else None

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        required = self._required_version(root)
        php_path = which("php")
        if php_path is None:
            return [
                RuntimeInfo(
                    name="php",
                    presence=Presence.NOT_INSTALLED,
                    required_version=required,
                    source="composer.json [require.php]" if required else None,
                )
            ]
        result = run_command([php_path, "--version"], timeout=5)
        installed = extract_version(result.stdout) if result.available else None
        return [
            RuntimeInfo(
                name="php",
                presence=Presence.INSTALLED if installed else Presence.UNKNOWN,
                installed_version=installed,
                required_version=required,
                path=php_path,
                source="composer.json [require.php]" if required else None,
            )
        ]

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        if not (root / "composer.json").exists():
            return None
        lockfile = root / "composer.lock"
        return DependencyInfo(
            ecosystem="php",
            manager="composer",
            lockfile="composer.lock" if lockfile.exists() else None,
            lockfile_present=lockfile.exists(),
            manifest_present=True,
        )

    def inspect_tests(self, root: Path) -> list[str]:
        scripts = _read_composer_json(root).get("scripts", {})
        if isinstance(scripts, dict) and "test" in scripts:
            return ["composer test"]
        if (root / "phpunit.xml").exists() or (root / "phpunit.xml.dist").exists():
            return ["vendor/bin/phpunit"]
        return []

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        issues = []
        for rt in runtimes:
            if rt.name == "php" and rt.presence == Presence.NOT_INSTALLED:
                issues.append(
                    HealthIssue(
                        severity=Severity.CRITICAL,
                        code="php.not_installed",
                        title="PHP not found",
                        message="No `php` executable was found on PATH.",
                        evidence=["which php -> not found"],
                        recommendation="Install PHP via https://www.php.net/manual/en/install.php.",
                    )
                )
        return issues

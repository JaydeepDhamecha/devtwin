"""Ruby ecosystem adapter."""

from __future__ import annotations

from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import DependencyInfo, HealthIssue, Presence, RuntimeInfo, Severity
from devtwin.core.runner import run_command, which


class RubyAdapter(EcosystemAdapter):
    ecosystem = "ruby"

    def detect(self, root: Path) -> bool:
        if (root / "Gemfile").exists():
            return True
        return bool(list(root.glob("*.gemspec")))

    def _required_version(self, root: Path) -> str | None:
        f = root / ".ruby-version"
        if not f.exists():
            return None
        try:
            return f.read_text(encoding="utf-8", errors="ignore").strip() or None
        except OSError:
            return None

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        required = self._required_version(root)
        ruby_path = which("ruby")
        if ruby_path is None:
            return [
                RuntimeInfo(
                    name="ruby",
                    presence=Presence.NOT_INSTALLED,
                    required_version=required,
                    source=".ruby-version" if required else None,
                )
            ]
        result = run_command([ruby_path, "--version"], timeout=5)
        version = extract_version(result.stdout) if result.available else None
        return [
            RuntimeInfo(
                name="ruby",
                presence=Presence.INSTALLED if version else Presence.UNKNOWN,
                installed_version=version,
                required_version=required,
                path=ruby_path,
                source=".ruby-version" if required else None,
            )
        ]

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        if not (root / "Gemfile").exists():
            return None
        lockfile = root / "Gemfile.lock"
        return DependencyInfo(
            ecosystem="ruby",
            manager="bundler",
            lockfile="Gemfile.lock" if lockfile.exists() else None,
            lockfile_present=lockfile.exists(),
            manifest_present=True,
        )

    def inspect_tests(self, root: Path) -> list[str]:
        if (root / "spec").exists():
            return ["bundle exec rspec"]
        if (root / "Rakefile").exists():
            return ["bundle exec rake test"]
        return []

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        issues = []
        for rt in runtimes:
            if rt.name == "ruby" and rt.presence == Presence.NOT_INSTALLED:
                issues.append(
                    HealthIssue(
                        severity=Severity.CRITICAL,
                        code="ruby.not_installed",
                        title="Ruby not found",
                        message="No `ruby` executable was found on PATH.",
                        evidence=["which ruby -> not found"],
                        recommendation="Install Ruby via rbenv, rvm, or https://www.ruby-lang.org/en/downloads.",
                    )
                )
        return issues

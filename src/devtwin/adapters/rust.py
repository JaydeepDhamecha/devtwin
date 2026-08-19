"""Rust ecosystem adapter."""

from __future__ import annotations

import re
from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import DependencyInfo, HealthIssue, Presence, RuntimeInfo, Severity
from devtwin.core.runner import run_command, which

TOOLCHAIN_CHANNEL_RE = re.compile(r'channel\s*=\s*"([^"]+)"')


class RustAdapter(EcosystemAdapter):
    ecosystem = "rust"

    def detect(self, root: Path) -> bool:
        return (root / "Cargo.toml").exists()

    def _required_version(self, root: Path) -> tuple[str | None, str | None]:
        for filename in ("rust-toolchain.toml", "rust-toolchain"):
            f = root / filename
            if not f.exists():
                continue
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            match = TOOLCHAIN_CHANNEL_RE.search(text)
            if match:
                return match.group(1), filename
            stripped = text.strip()
            if stripped and filename == "rust-toolchain":
                return stripped, filename
        return None, None

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        required, source = self._required_version(root)
        rustc_path = which("rustc")
        if rustc_path is None:
            return [
                RuntimeInfo(
                    name="rustc",
                    presence=Presence.NOT_INSTALLED,
                    required_version=required,
                    source=source,
                )
            ]
        result = run_command([rustc_path, "--version"], timeout=5)
        installed = extract_version(result.stdout) if result.available else None
        return [
            RuntimeInfo(
                name="rustc",
                presence=Presence.INSTALLED if installed else Presence.UNKNOWN,
                installed_version=installed,
                required_version=required,
                path=rustc_path,
                source=source,
            )
        ]

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        if not (root / "Cargo.toml").exists():
            return None
        lockfile = root / "Cargo.lock"
        return DependencyInfo(
            ecosystem="rust",
            manager="cargo",
            lockfile="Cargo.lock" if lockfile.exists() else None,
            lockfile_present=lockfile.exists(),
            manifest_present=True,
        )

    def inspect_build(self, root: Path) -> list[RuntimeInfo]:
        cargo_path = which("cargo")
        if cargo_path is None:
            return [RuntimeInfo(name="cargo", presence=Presence.NOT_INSTALLED)]
        result = run_command([cargo_path, "--version"], timeout=5)
        installed = extract_version(result.stdout) if result.available else None
        return [
            RuntimeInfo(
                name="cargo",
                presence=Presence.INSTALLED,
                installed_version=installed,
                path=cargo_path,
            )
        ]

    def inspect_tests(self, root: Path) -> list[str]:
        return ["cargo test"] if (root / "Cargo.toml").exists() else []

    def inspect_build_commands(self, root: Path) -> list[str]:
        return ["cargo build"] if (root / "Cargo.toml").exists() else []

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        issues = []
        for rt in runtimes:
            if rt.name == "rustc" and rt.presence == Presence.NOT_INSTALLED:
                issues.append(
                    HealthIssue(
                        severity=Severity.CRITICAL,
                        code="rust.not_installed",
                        title="Rust toolchain not found",
                        message="No `rustc` executable was found on PATH.",
                        evidence=["which rustc -> not found"],
                        recommendation="Install Rust via https://rustup.rs.",
                    )
                )
        return issues

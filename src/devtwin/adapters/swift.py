"""Swift ecosystem adapter: Swift Package Manager and Xcode (iOS/macOS) projects."""

from __future__ import annotations

import re
from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import DependencyInfo, HealthIssue, Presence, RuntimeInfo, Severity
from devtwin.core.runner import run_command, which

TOOLS_VERSION_RE = re.compile(r"swift-tools-version:\s*([\d.]+)")


class SwiftAdapter(EcosystemAdapter):
    """Handles Swift Package Manager projects and Xcode (iOS/macOS) projects."""

    ecosystem = "swift"

    def detect(self, root: Path) -> bool:
        if (root / "Package.swift").exists() or (root / "Podfile").exists():
            return True
        return bool(list(root.glob("*.xcodeproj"))) or bool(list(root.glob("*.xcworkspace")))

    def _uses_spm(self, root: Path) -> bool:
        return (root / "Package.swift").exists()

    def _uses_cocoapods(self, root: Path) -> bool:
        return (root / "Podfile").exists()

    def _uses_xcode(self, root: Path) -> bool:
        return bool(list(root.glob("*.xcodeproj"))) or bool(list(root.glob("*.xcworkspace")))

    def _required_tools_version(self, root: Path) -> str | None:
        f = root / "Package.swift"
        if not f.exists():
            return None
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return None
        match = TOOLS_VERSION_RE.search(text)
        return match.group(1) if match else None

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        required = self._required_tools_version(root)
        swift_path = which("swift")
        if swift_path is None:
            return [
                RuntimeInfo(
                    name="swift",
                    presence=Presence.NOT_INSTALLED,
                    required_version=required,
                    source="Package.swift" if required else None,
                )
            ]
        result = run_command([swift_path, "--version"], timeout=5)
        installed = extract_version(result.stdout) if result.available else None
        return [
            RuntimeInfo(
                name="swift",
                presence=Presence.INSTALLED if installed else Presence.UNKNOWN,
                installed_version=installed,
                required_version=required,
                path=swift_path,
                source="Package.swift" if required else None,
            )
        ]

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        if self._uses_cocoapods(root):
            lockfile = root / "Podfile.lock"
            return DependencyInfo(
                ecosystem="swift",
                manager="cocoapods",
                lockfile="Podfile.lock" if lockfile.exists() else None,
                lockfile_present=lockfile.exists(),
                manifest_present=True,
            )
        if self._uses_spm(root):
            lockfile = root / "Package.resolved"
            return DependencyInfo(
                ecosystem="swift",
                manager="spm",
                lockfile="Package.resolved" if lockfile.exists() else None,
                lockfile_present=lockfile.exists(),
                manifest_present=True,
            )
        return None

    def inspect_build(self, root: Path) -> list[RuntimeInfo]:
        if not self._uses_xcode(root):
            return []
        xcodebuild_path = which("xcodebuild")
        if xcodebuild_path is None:
            return [RuntimeInfo(name="xcodebuild", presence=Presence.NOT_INSTALLED)]
        result = run_command([xcodebuild_path, "-version"], timeout=5)
        installed = extract_version(result.stdout) if result.available else None
        return [
            RuntimeInfo(
                name="xcodebuild",
                presence=Presence.INSTALLED if installed else Presence.UNKNOWN,
                installed_version=installed,
                path=xcodebuild_path,
            )
        ]

    def inspect_tests(self, root: Path) -> list[str]:
        # `xcodebuild test` needs a -scheme we can't safely guess; only SPM's
        # `swift test` is runnable without project-specific configuration.
        return ["swift test"] if self._uses_spm(root) else []

    def inspect_build_commands(self, root: Path) -> list[str]:
        return ["swift build"] if self._uses_spm(root) else []

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        issues = []
        for rt in runtimes:
            if rt.name == "swift" and rt.presence == Presence.NOT_INSTALLED:
                issues.append(
                    HealthIssue(
                        severity=Severity.CRITICAL,
                        code="swift.not_installed",
                        title="Swift toolchain not found",
                        message="No `swift` executable was found on PATH.",
                        evidence=["which swift -> not found"],
                        recommendation="Install Xcode or the Swift toolchain from https://swift.org/install.",
                    )
                )
        return issues

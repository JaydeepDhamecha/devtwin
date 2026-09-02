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

    def _detect_scheme(self, root: Path) -> str | None:
        """Detect the first buildable scheme from xcodebuild -list -json.
        Returns None if xcodebuild is missing, not executable, or no scheme found."""
        import json

        if not self._uses_xcode(root):
            return None
        xcodebuild_path = which("xcodebuild")
        if xcodebuild_path is None:
            return None
        workspace = next(root.glob("*.xcworkspace"), None)
        project = next(root.glob("*.xcodeproj"), None)
        if not workspace and not project:
            return None
        args = [xcodebuild_path, "-list", "-json"]
        if workspace:
            args.extend(["-workspace", workspace.name])
        elif project:
            args.extend(["-project", project.name])
        result = run_command(args, cwd=str(root), timeout=10)
        if not result.available or result.returncode != 0:
            return None
        try:
            data = json.loads(result.stdout)
            schemes = data.get("project", {}).get("schemes") or data.get("workspace", {}).get(
                "schemes"
            )
            if schemes and isinstance(schemes, list):
                return schemes[0]  # ponytail: takes first scheme; explicit param if multi-target needed
        except (json.JSONDecodeError, KeyError, TypeError):
            pass
        return None

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
        commands = []
        if self._uses_spm(root):
            commands.append("swift test")
        elif self._uses_xcode(root):
            scheme = self._detect_scheme(root)
            if scheme:
                workspace = next(root.glob("*.xcworkspace"), None)
                target = ["-workspace", workspace.name] if workspace else ["-project", next(root.glob("*.xcodeproj")).name]
                commands.append(
                    f"xcodebuild test -scheme {scheme} -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' {' '.join(target)}"
                )
        return commands

    def inspect_build_commands(self, root: Path) -> list[str]:
        commands = []
        if self._uses_spm(root):
            commands.append("swift build")
        elif self._uses_xcode(root):
            scheme = self._detect_scheme(root)
            if scheme:
                workspace = next(root.glob("*.xcworkspace"), None)
                target = ["-workspace", workspace.name] if workspace else ["-project", next(root.glob("*.xcodeproj")).name]
                commands.append(
                    f"xcodebuild build -scheme {scheme} -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO {' '.join(target)}"
                )
        return commands

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

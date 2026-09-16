"""Swift ecosystem adapter: Swift Package Manager and Xcode (iOS/macOS) projects."""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import (
    AdapterResult,
    DependencyInfo,
    HealthIssue,
    Presence,
    RuntimeInfo,
    Severity,
)
from devtwin.core.runner import run_command, which

TOOLS_VERSION_RE = re.compile(r"swift-tools-version:\s*([\d.]+)")
# `SDKROOT = iphoneos;` / `SDKROOT = "macosx";` in an Xcode project's build settings.
SDKROOT_RE = re.compile(r"SDKROOT\s*=\s*\"?([A-Za-z0-9_.]+)\"?")
# `platform :ios, '16.0'` at the top of a Podfile.
PODFILE_PLATFORM_RE = re.compile(r"^\s*platform\s+:(\w+)", re.MULTILINE)

# `xcodebuild -list` populates DerivedData on a cold cache and regularly takes
# longer than the runner's 10s default; bound it generously instead, and report
# a timeout explicitly rather than letting the feature disable itself in silence.
SCHEME_LIST_TIMEOUT_SECONDS = 25

# CocoaPods generates one scheme per pod plus a `Pods-<app>` aggregate. Those
# build a dependency, not the app, so they are never the right default guess.
DEPENDENCY_SCHEME_PREFIXES = ("Pods-", "Pods_")
DEPENDENCY_SCHEME_NAMES = {"Pods"}
TEST_SCHEME_SUFFIXES = ("Tests", "UITests")


@dataclass
class SchemeDetection:
    """Outcome of one ``xcodebuild -list`` probe.

    ``status`` is always populated, so a probe that timed out or failed is
    distinguishable from "this project genuinely has no schemes" -- the caller
    reports the reason instead of quietly emitting no commands.
    """

    status: str  # ok | not_xcode | xcodebuild_missing | timed_out | failed | no_schemes
    scheme: str | None = None
    schemes: list[str] = field(default_factory=list)
    reason: str | None = None  # why this scheme was picked, so a wrong guess is debuggable
    detail: str | None = None  # why detection produced no scheme


class SwiftAdapter(EcosystemAdapter):
    """Handles Swift Package Manager projects and Xcode (iOS/macOS) projects.

    For Xcode projects the emitted commands are tailored to the project's own
    platform (``SDKROOT``): iOS builds target the simulator SDK, macOS builds
    target macOS. Test commands are only emitted when a destination that can
    actually run tests is known.
    """

    ecosystem = "swift"

    def __init__(self) -> None:
        # Adapter instances live in the module-level ADAPTERS list and are reused
        # across workspaces, so scheme detection is cached per root and cleared
        # around each run(): the cache exists to keep one run from forking
        # `xcodebuild -list` twice, not to survive between runs and go stale.
        self._scheme_cache: dict[str, SchemeDetection] = {}

    def run(self, root: Path) -> AdapterResult:
        key = str(root)
        self._scheme_cache.pop(key, None)
        try:
            return super().run(root)
        finally:
            self._scheme_cache.pop(key, None)

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

    def _scheme_detection(self, root: Path) -> SchemeDetection:
        """Cached :meth:`_probe_schemes` -- at most one fork per adapter run."""
        key = str(root)
        cached = self._scheme_cache.get(key)
        if cached is not None:
            return cached
        detection = self._probe_schemes(root)
        self._scheme_cache[key] = detection
        return detection

    def _detect_scheme(self, root: Path) -> str | None:
        """The scheme this adapter would build, or None when none could be chosen.

        Never raises and never blocks twice: see :meth:`_scheme_detection`.
        """
        return self._scheme_detection(root).scheme

    def _probe_schemes(self, root: Path) -> SchemeDetection:
        """Ask ``xcodebuild -list -json`` for this project's schemes.

        Every failure mode returns a populated :class:`SchemeDetection` rather
        than None, so ``health_checks`` can say *why* no command was emitted.
        """
        if not self._uses_xcode(root):
            return SchemeDetection(status="not_xcode")
        xcodebuild_path = which("xcodebuild")
        if xcodebuild_path is None:
            return SchemeDetection(
                status="xcodebuild_missing",
                detail="No `xcodebuild` executable was found on PATH.",
            )
        workspace = next(root.glob("*.xcworkspace"), None)
        project = next(root.glob("*.xcodeproj"), None)
        args = [xcodebuild_path, "-list", "-json"]
        if workspace:
            args.extend(["-workspace", workspace.name])
        elif project:
            args.extend(["-project", project.name])
        else:
            # detect() saw an .xcodeproj/.xcworkspace that is gone now.
            return SchemeDetection(status="not_xcode")

        result = run_command(args, cwd=str(root), timeout=SCHEME_LIST_TIMEOUT_SECONDS)
        if result.timed_out:
            return SchemeDetection(
                status="timed_out",
                detail=(
                    f"`xcodebuild -list` did not finish within {SCHEME_LIST_TIMEOUT_SECONDS}s "
                    "(common on a cold DerivedData cache)."
                ),
            )
        if not result.available:
            return SchemeDetection(
                status="failed",
                detail=f"`xcodebuild -list` could not be executed: {result.stderr.strip()[:200]}",
            )
        if result.returncode != 0:
            first_line = result.stderr.strip().splitlines()[0] if result.stderr.strip() else ""
            return SchemeDetection(
                status="failed",
                detail=f"`xcodebuild -list` exited {result.returncode}. {first_line}".strip(),
            )

        schemes = self._parse_schemes(result.stdout)
        if schemes is None:
            return SchemeDetection(
                status="failed",
                detail="`xcodebuild -list -json` did not return readable JSON.",
            )
        if not schemes:
            return SchemeDetection(
                status="no_schemes",
                detail="`xcodebuild -list -json` reported no schemes for this project.",
            )
        names = [p.stem for p in (workspace, project) if p is not None]
        scheme, reason = self._select_scheme(schemes, names)
        return SchemeDetection(status="ok", scheme=scheme, schemes=schemes, reason=reason)

    @staticmethod
    def _parse_schemes(stdout: str) -> list[str] | None:
        """Scheme names from ``xcodebuild -list -json``.

        Returns None when the output could not be parsed at all -- that is a
        different (and worth reporting) outcome from "parsed fine, no schemes".
        """
        try:
            data = json.loads(stdout)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(data, dict):
            return None
        for key in ("project", "workspace"):
            container = data.get(key)
            if not isinstance(container, dict):
                continue
            raw = container.get("schemes")
            if isinstance(raw, list):
                names = [s for s in raw if isinstance(s, str) and s]
                if names:
                    return names
        return []

    @staticmethod
    def _normalize(name: str) -> str:
        return "".join(c for c in name.lower() if c.isalnum())

    @classmethod
    def _is_dependency_scheme(cls, scheme: str) -> bool:
        return scheme in DEPENDENCY_SCHEME_NAMES or scheme.startswith(DEPENDENCY_SCHEME_PREFIXES)

    @classmethod
    def _is_test_scheme(cls, scheme: str) -> bool:
        return scheme.endswith(TEST_SCHEME_SUFFIXES)

    @classmethod
    def _select_scheme(cls, schemes: list[str], project_names: list[str]) -> tuple[str, str]:
        """Pick the scheme most likely to be the app, with the reason for the pick.

        Taking ``schemes[0]`` is wrong on a CocoaPods workspace, where the list
        usually starts with a pod's own scheme: DevTwin would build a dependency,
        report green, and never compile the app.
        """
        wanted = {cls._normalize(n) for n in project_names if n}
        for scheme in schemes:
            if cls._normalize(scheme) in wanted:
                return scheme, "matches the project/workspace name"
        app_like = [
            s for s in schemes if not cls._is_dependency_scheme(s) and not cls._is_test_scheme(s)
        ]
        if app_like:
            return app_like[0], "first scheme that is neither a dependency nor a test scheme"
        non_dependency = [s for s in schemes if not cls._is_dependency_scheme(s)]
        if non_dependency:
            return non_dependency[0], "first scheme that is not a CocoaPods dependency scheme"
        return schemes[0], "no app-like scheme found; fell back to the first scheme"

    def _detect_platform(self, root: Path) -> str | None:
        """Return "ios"/"macos" from the project's own settings; None when unclear.

        Hardcoding the iOS simulator SDK makes every macOS Xcode project fail a
        build DevTwin itself mis-specified, so an unknown platform means "emit no
        SDK/destination flags" rather than "assume iOS".
        """
        for pbxproj in sorted(root.glob("*.xcodeproj/project.pbxproj")):
            try:
                text = pbxproj.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            sdks = {sdk.lower() for sdk in SDKROOT_RE.findall(text)}
            if any(sdk.startswith("iphone") for sdk in sdks):
                return "ios"
            if any(sdk.startswith("macosx") for sdk in sdks):
                return "macos"
        podfile = root / "Podfile"
        if podfile.exists():
            try:
                text = podfile.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                return None
            match = PODFILE_PLATFORM_RE.search(text)
            if match:
                token = match.group(1).lower()
                if token == "ios":
                    return "ios"
                if token in ("osx", "macos"):
                    return "macos"
        return None

    def _xcode_target_args(self, root: Path) -> list[str] | None:
        """``-workspace X`` / ``-project Y``, or None when neither exists.

        Deliberately defensive: the glob can come back empty between detect()
        and here, and a missing file must not raise StopIteration.
        """
        workspace = next(root.glob("*.xcworkspace"), None)
        if workspace:
            return ["-workspace", workspace.name]
        project = next(root.glob("*.xcodeproj"), None)
        if project:
            return ["-project", project.name]
        return None

    def _build_destination_args(self, root: Path) -> list[str]:
        platform = self._detect_platform(root)
        if platform == "macos":
            return ["-destination", "platform=macOS"]
        if platform == "ios":
            return ["-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator"]
        return []

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
        commands: list[str] = []
        if self._uses_spm(root):
            commands.append("swift test")
        elif self._uses_xcode(root):
            # `xcodebuild test` refuses a generic destination -- tests need a
            # concrete one. macOS is the only destination we can name without
            # probing the simulator list, so for iOS (and for an unknown
            # platform) we emit nothing: dev_check reporting "unknown" is
            # honest, a command xcodebuild always rejects is not.
            if self._detect_platform(root) != "macos":
                return commands
            scheme = self._detect_scheme(root)
            target = self._xcode_target_args(root)
            if scheme and target:
                commands.append(
                    shlex.join(
                        [
                            "xcodebuild",
                            "test",
                            "-scheme",
                            scheme,
                            "-destination",
                            "platform=macOS",
                            *target,
                        ]
                    )
                )
        return commands

    def inspect_build_commands(self, root: Path) -> list[str]:
        commands: list[str] = []
        if self._uses_spm(root):
            commands.append("swift build")
        elif self._uses_xcode(root):
            scheme = self._detect_scheme(root)
            target = self._xcode_target_args(root)
            if scheme and target:
                # shlex.join quotes every interpolated value: a scheme or project
                # named "My App" must stay one argv entry, not two.
                commands.append(
                    shlex.join(
                        [
                            "xcodebuild",
                            "build",
                            "-scheme",
                            scheme,
                            *self._build_destination_args(root),
                            *target,
                            "CODE_SIGNING_ALLOWED=NO",
                        ]
                    )
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
        issues.extend(self._xcode_scheme_issues(root))
        return issues

    def _xcode_scheme_issues(self, root: Path) -> list[HealthIssue]:
        """Report how (and whether) an Xcode scheme was chosen.

        Scheme detection decides which commands this adapter emits, so both the
        guess and the failure to make one are reported instead of showing up as
        an unexplained empty command list.
        """
        if not self._uses_xcode(root):
            return []
        detection = self._scheme_detection(root)  # cached: no extra fork
        issues: list[HealthIssue] = []

        if detection.status in ("timed_out", "failed"):
            issues.append(
                HealthIssue(
                    severity=Severity.LOW,
                    code="swift.scheme_detection_failed",
                    title="Xcode scheme could not be detected",
                    message=(
                        f"{detection.detail} No xcodebuild build or test command was emitted "
                        "for this project."
                    ),
                    evidence=[f"xcodebuild -list -json -> {detection.status}"],
                    recommendation="Run `xcodebuild -list` in this directory to see the schemes.",
                )
            )
            return issues
        if detection.status == "no_schemes":
            issues.append(
                HealthIssue(
                    severity=Severity.INFO,
                    code="swift.no_schemes",
                    title="Xcode project exposes no schemes",
                    message=f"{detection.detail} No xcodebuild command was emitted.",
                    evidence=["xcodebuild -list -json -> no schemes"],
                    recommendation="Share a scheme in Xcode (Product > Scheme > Manage Schemes).",
                )
            )
            return issues
        if detection.status != "ok" or not detection.scheme:
            return issues

        platform = self._detect_platform(root)
        issues.append(
            HealthIssue(
                severity=Severity.INFO,
                code="swift.scheme_selected",
                title=f"Xcode scheme '{detection.scheme}' selected",
                message=(
                    f"DevTwin builds the '{detection.scheme}' scheme ({detection.reason}). "
                    "Verify this is the app target if a build result looks wrong."
                ),
                evidence=[
                    f"schemes: {', '.join(detection.schemes)}",
                    f"platform: {platform or 'unknown'}",
                ],
                recommendation=None,
            )
        )
        if platform != "macos":
            issues.append(
                HealthIssue(
                    severity=Severity.INFO,
                    code="swift.xcode_tests_need_destination",
                    title="No xcodebuild test command emitted",
                    message=(
                        "`xcodebuild test` needs a concrete destination (a booted or named "
                        "simulator); DevTwin does not pick one for you, so tests for this "
                        "project are reported as unknown rather than failed."
                    ),
                    evidence=[f"platform: {platform or 'unknown'}"],
                    recommendation=(
                        "Run xcodebuild test yourself with "
                        "-destination 'platform=iOS Simulator,name=<device>'."
                    ),
                )
            )
        return issues

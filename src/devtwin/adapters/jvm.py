"""JVM ecosystem adapter: shared by Java and Kotlin (Gradle + Maven)."""

from __future__ import annotations

import platform
import re
from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import (
    DependencyInfo,
    HealthIssue,
    Presence,
    RuntimeInfo,
    Severity,
)
from devtwin.core.runner import run_command, which

GRADLE_WRAPPER_VERSION_RE = re.compile(r"gradle-(\d+(?:\.\d+){1,2})-")


class JvmAdapter(EcosystemAdapter):
    """Handles Java and Kotlin projects (Gradle and/or Maven)."""

    ecosystem = "jvm"

    def detect(self, root: Path) -> bool:
        indicators = [
            "pom.xml",
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
            "gradlew",
        ]
        if any((root / name).exists() for name in indicators):
            return True
        return bool(list(root.glob("*.java"))) or bool(list(root.glob("*.kt")))

    def _uses_gradle(self, root: Path) -> bool:
        return any(
            (root / n).exists()
            for n in ("build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts")
        )

    def _uses_maven(self, root: Path) -> bool:
        return (root / "pom.xml").exists()

    def _has_kotlin(self, root: Path) -> bool:
        if (root / "build.gradle.kts").exists() or (root / "settings.gradle.kts").exists():
            return True
        return bool(list(root.glob("**/*.kt"))[:1])

    def _gradle_wrapper_version(self, root: Path) -> str | None:
        props = root / "gradle" / "wrapper" / "gradle-wrapper.properties"
        if not props.exists():
            return None
        try:
            text = props.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return None
        match = GRADLE_WRAPPER_VERSION_RE.search(text)
        return match.group(1) if match else None

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        runtimes: list[RuntimeInfo] = []

        java_path = which("java")
        if java_path is None:
            runtimes.append(RuntimeInfo(name="java", presence=Presence.NOT_INSTALLED))
        else:
            result = run_command([java_path, "-version"], timeout=5)
            output = result.stderr or result.stdout  # java -version prints to stderr
            installed = extract_version(output) if result.available else None
            runtimes.append(
                RuntimeInfo(
                    name="java",
                    presence=Presence.INSTALLED if installed else Presence.UNKNOWN,
                    installed_version=installed,
                    path=java_path,
                )
            )

        if self._has_kotlin(root):
            kotlinc_path = which("kotlinc")
            if kotlinc_path is None:
                runtimes.append(RuntimeInfo(name="kotlin", presence=Presence.NOT_INSTALLED))
            else:
                result = run_command([kotlinc_path, "-version"], timeout=15)
                output = result.stderr or result.stdout
                installed = extract_version(output) if result.available else None
                runtimes.append(
                    RuntimeInfo(
                        name="kotlin",
                        presence=Presence.INSTALLED if installed else Presence.UNKNOWN,
                        installed_version=installed,
                        path=kotlinc_path,
                    )
                )

        return runtimes

    def _wrapper_invocation(self, root: Path, unix_name: str, win_name: str, fallback: str) -> str:
        """Pick the right wrapper command for the current OS, without assuming
        both `unix_name` and `win_name` were committed side by side."""
        if platform.system() == "Windows" and (root / win_name).exists():
            return win_name
        if (root / unix_name).exists():
            return f"./{unix_name}"
        return fallback

    def inspect_build(self, root: Path) -> list[RuntimeInfo]:
        tools: list[RuntimeInfo] = []

        if self._uses_gradle(root):
            required = self._gradle_wrapper_version(root)
            gradlew_sh, gradlew_bat = root / "gradlew", root / "gradlew.bat"
            wrapper = (
                gradlew_bat
                if (platform.system() == "Windows" and gradlew_bat.exists())
                else gradlew_sh
            )
            if gradlew_sh.exists() or gradlew_bat.exists():
                tools.append(
                    RuntimeInfo(
                        name="gradle-wrapper",
                        presence=Presence.DETECTED,
                        required_version=required,
                        path=str(wrapper),
                        source="gradle/wrapper/gradle-wrapper.properties",
                    )
                )
            else:
                gradle_path = which("gradle")
                if gradle_path is None:
                    tools.append(
                        RuntimeInfo(
                            name="gradle",
                            presence=Presence.NOT_INSTALLED,
                            required_version=required,
                        )
                    )
                else:
                    result = run_command([gradle_path, "--version"], timeout=15)
                    installed = extract_version(result.stdout) if result.available else None
                    tools.append(
                        RuntimeInfo(
                            name="gradle",
                            presence=Presence.INSTALLED,
                            installed_version=installed,
                            required_version=required,
                            path=gradle_path,
                        )
                    )

        if self._uses_maven(root):
            mvnw_sh, mvnw_cmd = root / "mvnw", root / "mvnw.cmd"
            wrapper = (
                mvnw_cmd if (platform.system() == "Windows" and mvnw_cmd.exists()) else mvnw_sh
            )
            if mvnw_sh.exists() or mvnw_cmd.exists():
                tools.append(
                    RuntimeInfo(name="maven-wrapper", presence=Presence.DETECTED, path=str(wrapper))
                )
            else:
                mvn_path = which("mvn")
                if mvn_path is None:
                    tools.append(RuntimeInfo(name="maven", presence=Presence.NOT_INSTALLED))
                else:
                    result = run_command([mvn_path, "--version"], timeout=15)
                    installed = extract_version(result.stdout) if result.available else None
                    tools.append(
                        RuntimeInfo(
                            name="maven",
                            presence=Presence.INSTALLED,
                            installed_version=installed,
                            path=mvn_path,
                        )
                    )

        return tools

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        if self._uses_gradle(root):
            return DependencyInfo(
                ecosystem="jvm",
                manager="gradle",
                lockfile=None,
                manifest_present=True,
                notes=[
                    "Gradle does not use a single lockfile by default; dependency"
                    " locking must be explicitly enabled per-project."
                ],
            )
        if self._uses_maven(root):
            return DependencyInfo(
                ecosystem="jvm",
                manager="maven",
                lockfile=None,
                manifest_present=True,
            )
        return None

    def inspect_tests(self, root: Path) -> list[str]:
        commands = []
        if self._uses_gradle(root):
            commands.append(
                f"{self._wrapper_invocation(root, 'gradlew', 'gradlew.bat', 'gradle')} test"
            )
        if self._uses_maven(root):
            commands.append(f"{self._wrapper_invocation(root, 'mvnw', 'mvnw.cmd', 'mvn')} test")
        return commands

    def inspect_build_commands(self, root: Path) -> list[str]:
        commands = []
        if self._uses_gradle(root):
            commands.append(
                f"{self._wrapper_invocation(root, 'gradlew', 'gradlew.bat', 'gradle')} build"
            )
        if self._uses_maven(root):
            commands.append(f"{self._wrapper_invocation(root, 'mvnw', 'mvnw.cmd', 'mvn')} package")
        return commands

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        issues: list[HealthIssue] = []
        for rt in runtimes:
            if rt.name == "java" and rt.presence == Presence.NOT_INSTALLED:
                issues.append(
                    HealthIssue(
                        severity=Severity.CRITICAL,
                        code="jvm.java_not_installed",
                        title="Java runtime not found",
                        message="No `java` executable was found on PATH.",
                        evidence=["which java -> not found"],
                        recommendation="Install a JDK (e.g. via sdkman, your OS package manager, or Adoptium).",
                    )
                )
        return issues

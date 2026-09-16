"""Fallback adapter: useful signal for any project, recognized or not.

Every other adapter's ``detect()`` can return False for a project DevTwin
doesn't specifically understand (Ruby, PHP, C++/CMake, ...). This adapter
never returns False -- it always looks at Makefile/Taskfile/justfile/
Dockerfile/compose files/README/scripts and surfaces whatever it finds, so
an unsupported language still gets a useful answer instead of silence.
"""

from __future__ import annotations

import re
from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter
from devtwin.core.models import DependencyInfo, HealthIssue, RuntimeInfo, Severity
from devtwin.system.docker import find_compose_files
from devtwin.system.filesystem import exists_any, list_top_level

MAKE_TARGET_RE = re.compile(r"^([a-zA-Z0-9_.-]+):(?!=)", re.MULTILINE)


class GenericAdapter(EcosystemAdapter):
    ecosystem = "generic"

    def detect(self, root: Path) -> bool:
        return True

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        found = exists_any(
            root,
            ["Makefile", "makefile", "Taskfile.yml", "justfile", "Dockerfile"],
        )
        compose = find_compose_files(root)
        if not found and not compose:
            return None
        return DependencyInfo(
            ecosystem="generic",
            manager=None,
            lockfile=None,
            manifest_present=bool(found or compose),
            notes=[*found, *compose],
        )

    def inspect_tests(self, root: Path) -> list[str]:
        commands: list[str] = []
        makefile = root / "Makefile"
        if makefile.exists():
            targets = self._make_targets(makefile)
            for candidate in ("test", "check"):
                if candidate in targets:
                    commands.append(f"make {candidate}")
        if (root / "justfile").exists():
            commands.append("just test")
        if (root / "Taskfile.yml").exists():
            commands.append("task test")
        return commands

    def inspect_build_commands(self, root: Path) -> list[str]:
        """Build commands ``dev_build``/``dev_build_all`` are allowed to execute.

        Container commands are deliberately absent: ``docker build .`` is a real
        image build (killed half-done at the build timeout, leaving a partial
        build behind) and ``docker compose up`` starts containers. Neither is a
        read-only build check, so they are surfaced as advice by
        :meth:`health_checks` -- which nothing ever executes -- instead.
        """
        commands: list[str] = []
        makefile = root / "Makefile"
        if makefile.exists():
            targets = self._make_targets(makefile)
            if "build" in targets:
                commands.append("make build")
        return commands

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        """Surface container commands as advice, never as something DevTwin runs."""
        issues: list[HealthIssue] = []
        if (root / "Dockerfile").exists():
            issues.append(
                HealthIssue(
                    severity=Severity.INFO,
                    code="generic.docker_image_build_available",
                    title="Dockerfile present -- image build is not run automatically",
                    message=(
                        "DevTwin does not run `docker build .` as a build check: building an "
                        "image is slow, writes to the local image store, and would be killed "
                        "mid-way by the build timeout."
                    ),
                    evidence=["Dockerfile"],
                    recommendation="Run `docker build .` yourself when you need the image.",
                )
            )
        compose = find_compose_files(root)
        if compose:
            issues.append(
                HealthIssue(
                    severity=Severity.INFO,
                    code="generic.compose_services_available",
                    title="Compose file present -- containers are not started automatically",
                    message=(
                        "DevTwin never starts containers. Use dev_services to see which "
                        "services this project expects and whether they are already running."
                    ),
                    evidence=list(compose),
                    recommendation=f"Run `docker compose -f {compose[0]} up -d` yourself if needed.",
                )
            )
        return issues

    def notes(self, root: Path) -> list[str]:
        return list_top_level(root)

    @staticmethod
    def _make_targets(makefile: Path) -> set[str]:
        try:
            text = makefile.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return set()
        return set(MAKE_TARGET_RE.findall(text))

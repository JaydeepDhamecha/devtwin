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
from devtwin.core.models import DependencyInfo
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
        commands: list[str] = []
        makefile = root / "Makefile"
        if makefile.exists():
            targets = self._make_targets(makefile)
            if "build" in targets:
                commands.append("make build")
        if (root / "Dockerfile").exists():
            commands.append("docker build .")
        compose = find_compose_files(root)
        if compose:
            commands.append(f"docker compose -f {compose[0]} up")
        return commands

    def notes(self, root: Path) -> list[str]:
        return list_top_level(root)

    @staticmethod
    def _make_targets(makefile: Path) -> set[str]:
        try:
            text = makefile.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return set()
        return set(MAKE_TARGET_RE.findall(text))

"""Safe, read-only Docker inspection.

DevTwin never stops, removes, or otherwise mutates containers. Every
function here maps to a read-only ``docker`` subcommand.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from devtwin.core.models import DictMixin, Presence
from devtwin.core.runner import run_command, which


@dataclass
class ContainerInfo(DictMixin):
    name: str
    image: str
    status: str
    ports: str = ""


@dataclass
class DockerInfo(DictMixin):
    presence: Presence
    version: str | None = None
    daemon_running: bool = False
    containers: list[ContainerInfo] = field(default_factory=list)
    compose_files: list[str] = field(default_factory=list)


COMPOSE_FILE_NAMES = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
]


def find_compose_files(root: Path) -> list[str]:
    return [name for name in COMPOSE_FILE_NAMES if (root / name).exists()]


def inspect_docker(root: Path | None = None) -> DockerInfo:
    if which("docker") is None:
        return DockerInfo(
            presence=Presence.NOT_INSTALLED,
            compose_files=find_compose_files(root) if root else [],
        )

    version_result = run_command(
        ["docker", "version", "--format", "{{.Server.Version}}"], timeout=5
    )
    daemon_running = version_result.available and version_result.returncode == 0
    version_str: str | None = None
    if daemon_running:
        version_str = version_result.stdout.strip() or None
    else:
        # Daemon down, but CLI installed -- try the client-only version.
        client_version = run_command(["docker", "--version"], timeout=5)
        if client_version.available:
            version_str = client_version.stdout.strip() or None

    containers: list[ContainerInfo] = []
    if daemon_running:
        ps_result = run_command(
            ["docker", "ps", "--format", "{{json .}}"],
            timeout=8,
        )
        if ps_result.available and ps_result.returncode == 0:
            for line in ps_result.stdout.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                containers.append(
                    ContainerInfo(
                        name=raw.get("Names", ""),
                        image=raw.get("Image", ""),
                        status=raw.get("Status", ""),
                        ports=raw.get("Ports", ""),
                    )
                )

    return DockerInfo(
        presence=Presence.INSTALLED,
        version=version_str,
        daemon_running=daemon_running,
        containers=containers,
        compose_files=find_compose_files(root) if root else [],
    )

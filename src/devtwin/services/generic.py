"""Generic compose-service detection for services with no dedicated detector.

Avoids a YAML dependency: compose files have a predictable structure, so a
line-based scan for the ``services:`` block and its immediate children is
enough to recover service names without a full parser.
"""

from __future__ import annotations

import re
from pathlib import Path

from devtwin.core.models import ServiceInfo
from devtwin.system.docker import find_compose_files
from devtwin.system.ports import is_port_listening

SERVICE_NAME_RE = re.compile(r"^  ([a-zA-Z0-9_.-]+):\s*$")
IMAGE_RE = re.compile(r"^\s*image:\s*[\"']?([^\s\"']+)")
PORT_MAPPING_RE = re.compile(r'^\s*-\s*["\']?(\d+):(\d+)')

KNOWN_SERVICE_NAMES = {"postgresql", "postgres", "redis"}


def _parse_compose(path: Path) -> dict[str, dict]:
    """Return {service_name: {"image": str|None, "ports": [int, ...]}}."""
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return {}

    services: dict[str, dict] = {}
    in_services = False
    current: str | None = None

    for line in lines:
        if line.rstrip() == "services:":
            in_services = True
            continue
        if not in_services:
            continue
        if line and not line.startswith(" "):
            break  # left the services block

        name_match = SERVICE_NAME_RE.match(line)
        if name_match:
            current = name_match.group(1)
            services[current] = {"image": None, "ports": []}
            continue

        if current is None:
            continue

        image_match = IMAGE_RE.match(line)
        if image_match:
            services[current]["image"] = image_match.group(1)
            continue

        port_match = PORT_MAPPING_RE.match(line)
        if port_match:
            services[current]["ports"].append(int(port_match.group(1)))

    return services


def detect_generic_services(root: Path) -> list[ServiceInfo]:
    """Detect compose-defined services beyond Postgres/Redis (which have dedicated detectors)."""
    infos: list[ServiceInfo] = []
    for filename in find_compose_files(root):
        parsed = _parse_compose(root / filename)
        for name, meta in parsed.items():
            image = (meta.get("image") or "").lower()
            if any(known in image or known in name.lower() for known in KNOWN_SERVICE_NAMES):
                continue
            ports = meta.get("ports") or []
            port = ports[0] if ports else None
            running = is_port_listening(port) if port else False
            infos.append(
                ServiceInfo(
                    name=name,
                    required=True,
                    required_confidence=0.5,
                    running=running,
                    port=port,
                    source=[f"{filename} defines service '{name}'"],
                    detail=f"image: {image}" if image else None,
                )
            )
    return infos

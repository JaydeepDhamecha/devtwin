"""Local service detection contract.

A service is "required" only when multiple independent signals point at it
-- an env var like ``DATABASE_URL``, a compose service, a dependency on a
matching client library, or a README mention are each weak evidence alone.
Confidence is the sum of matched signal weights, capped at 1.0, so callers
(and the model) can see exactly why DevTwin thinks a service matters instead
of asserting it outright.
"""

from __future__ import annotations

import re
from abc import ABC
from pathlib import Path

from devtwin.core.models import ServiceInfo
from devtwin.system.docker import inspect_docker
from devtwin.system.ports import is_port_listening

SIGNAL_WEIGHTS = {
    "env_var": 0.45,
    "compose_service": 0.5,
    "dependency": 0.35,
    "config_file": 0.3,
    "readme_hint": 0.15,
}


class ServiceDetector(ABC):
    name: str
    default_port: int
    env_var_patterns: tuple[str, ...] = ()
    dependency_names: tuple[str, ...] = ()
    compose_image_hints: tuple[str, ...] = ()
    readme_keywords: tuple[str, ...] = ()

    def _env_signal(self) -> tuple[str, float] | None:
        import os

        for name in os.environ:
            for pattern in self.env_var_patterns:
                if re.search(pattern, name, re.IGNORECASE):
                    return f"environment variable {name} is set", SIGNAL_WEIGHTS["env_var"]
        return None

    def _compose_signal(self, root: Path) -> tuple[str, float] | None:
        for filename in (
            "compose.yaml",
            "compose.yml",
            "docker-compose.yml",
            "docker-compose.yaml",
        ):
            f = root / filename
            if not f.exists():
                continue
            try:
                text = f.read_text(encoding="utf-8", errors="ignore").lower()
            except OSError:
                continue
            for hint in self.compose_image_hints:
                if hint in text:
                    return f"{filename} references image '{hint}'", SIGNAL_WEIGHTS[
                        "compose_service"
                    ]
        return None

    def _dependency_signal(self, dependency_names_present: set[str]) -> tuple[str, float] | None:
        lowered = {d.lower() for d in dependency_names_present}
        for dep in self.dependency_names:
            if dep.lower() in lowered:
                return f"dependency on '{dep}' detected", SIGNAL_WEIGHTS["dependency"]
        return None

    def _readme_signal(self, root: Path) -> tuple[str, float] | None:
        for filename in ("README.md", "README", "README.rst"):
            f = root / filename
            if not f.exists():
                continue
            try:
                text = f.read_text(encoding="utf-8", errors="ignore").lower()
            except OSError:
                continue
            for kw in self.readme_keywords:
                if kw.lower() in text:
                    return f"{filename} mentions '{kw}'", SIGNAL_WEIGHTS["readme_hint"]
        return None

    def detect(self, root: Path, dependency_names_present: set[str]) -> ServiceInfo:
        sources: list[str] = []
        confidence = 0.0

        for signal in (
            self._env_signal(),
            self._compose_signal(root),
            self._dependency_signal(dependency_names_present),
            self._readme_signal(root),
        ):
            if signal:
                text, weight = signal
                sources.append(text)
                confidence += weight

        confidence = min(1.0, confidence)
        required = confidence >= 0.3

        running = is_port_listening(self.default_port)
        detail = None
        if not running:
            docker_info = inspect_docker(root)
            for container in docker_info.containers:
                if any(hint in container.image.lower() for hint in self.compose_image_hints):
                    detail = f"container '{container.name}' is running but port {self.default_port} is not reachable locally"
                    break

        return ServiceInfo(
            name=self.name,
            required=required,
            required_confidence=round(confidence, 2),
            running=running,
            port=self.default_port,
            source=sources,
            detail=detail,
        )

"""Local service detection: which services a project needs, and their state."""

from __future__ import annotations

from pathlib import Path

from devtwin.core.models import ServiceInfo
from devtwin.services.generic import detect_generic_services
from devtwin.services.postgres import PostgresDetector
from devtwin.services.redis import RedisDetector

DETECTORS = [PostgresDetector(), RedisDetector()]


def detect_services(root: Path, dependency_names_present: set[str]) -> list[ServiceInfo]:
    results = [d.detect(root, dependency_names_present) for d in DETECTORS]
    results = [r for r in results if r.required or r.running]
    results.extend(detect_generic_services(root))
    return results


__all__ = ["DETECTORS", "detect_services"]

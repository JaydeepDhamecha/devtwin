from __future__ import annotations

import os
from pathlib import Path

from devtwin.services.generic import detect_generic_services
from devtwin.services.postgres import PostgresDetector
from devtwin.services.redis import RedisDetector


def test_postgres_required_via_env_var(tmp_path: Path, monkeypatch):
    # Isolate from ambient env vars: some CI runner images (notably Windows)
    # ship with PGPASSWORD or similar already set, which would otherwise win
    # the first-match-in-os.environ race against our injected DATABASE_URL.
    monkeypatch.setattr(os, "environ", {"DATABASE_URL": "postgres://localhost/x"})
    detector = PostgresDetector()
    info = detector.detect(tmp_path, set())
    assert info.required is True
    assert info.required_confidence > 0
    assert "DATABASE_URL" in info.source[0]


def test_redis_not_required_with_no_signals(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    detector = RedisDetector()
    info = detector.detect(tmp_path, set())
    assert info.required is False


def test_postgres_required_via_dependency():
    detector = PostgresDetector()
    text, weight = detector._dependency_signal({"psycopg2-binary"})
    assert weight > 0


def test_generic_compose_services_excludes_known(fixtures_root: Path):
    services = detect_generic_services(fixtures_root / "generic" / "docker-project")
    names = {s.name for s in services}
    assert "db" not in names  # postgres image, handled by dedicated detector
    assert "cache" not in names  # redis image
    assert "queue" in names  # rabbitmq has no dedicated detector

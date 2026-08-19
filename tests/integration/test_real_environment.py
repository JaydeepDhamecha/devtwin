"""Integration tests that exercise real, installed tools.

These are skipped automatically when the relevant tool isn't on PATH, so the
unit test suite (test_*.py under tests/unit/) never depends on the host
machine having Python/Node/Java/Go/Rust/.NET installed. Run explicitly with:

    pytest -m integration
"""

from __future__ import annotations

import shutil

import pytest

from devtwin.core.health import compute_health
from devtwin.core.runner import run_command

pytestmark = pytest.mark.integration


@pytest.mark.skipif(
    shutil.which("python3") is None and shutil.which("python") is None, reason="no python on PATH"
)
def test_real_python_version_detected():
    py = shutil.which("python3") or shutil.which("python")
    result = run_command([py, "--version"])
    assert result.available is True
    assert result.returncode == 0


@pytest.mark.skipif(shutil.which("git") is None, reason="no git on PATH")
def test_compute_health_on_this_repo():
    from pathlib import Path

    report = compute_health(str(Path(__file__).resolve().parents[2]))
    assert 0 <= report.health_score <= 100

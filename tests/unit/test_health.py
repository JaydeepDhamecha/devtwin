from __future__ import annotations

from pathlib import Path

from devtwin.core.health import _score, _status_for_score, compute_health
from devtwin.core.models import HealthIssue, Severity, Status


def test_score_deductions():
    issues = [
        HealthIssue(severity=Severity.CRITICAL, code="a", title="a", message="a"),
        HealthIssue(severity=Severity.LOW, code="b", title="b", message="b"),
    ]
    assert _score(issues) == 100 - 25 - 3


def test_score_never_below_zero():
    issues = [
        HealthIssue(severity=Severity.CRITICAL, code=f"c{i}", title="c", message="c")
        for i in range(10)
    ]
    assert _score(issues) == 0


def test_score_never_above_100():
    assert _score([]) == 100


def test_status_thresholds():
    assert _status_for_score(100) == Status.OK
    assert _status_for_score(90) == Status.OK
    assert _status_for_score(89) == Status.WARNING
    assert _status_for_score(50) == Status.WARNING
    assert _status_for_score(49) == Status.ERROR
    assert _status_for_score(0) == Status.ERROR


def test_compute_health_nonexistent_workspace(tmp_path: Path):
    report = compute_health(str(tmp_path / "nope"))
    assert report.health_score == 0
    assert report.status == Status.ERROR
    assert any(i.code == "workspace.not_found" for i in report.issues)


def test_compute_health_on_generic_empty_project(tmp_path: Path):
    (tmp_path / "README.md").write_text("hello")
    report = compute_health(str(tmp_path))
    assert report.health_score <= 100
    assert report.status in (Status.OK, Status.WARNING, Status.ERROR)


def test_compute_health_python_project_with_missing_venv(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "x"\nversion = "0.1"\ndependencies = ["requests"]\n'
    )
    report = compute_health(str(tmp_path))
    assert "python" in report.project_summary

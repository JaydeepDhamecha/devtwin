from __future__ import annotations

from pathlib import Path

from devtwin.adapters.python import PythonAdapter
from devtwin.core.models import CommandResult, Presence


def _fake_command(executable, args, returncode=0, stdout="", stderr=""):
    return CommandResult(
        executable=executable, args=args, returncode=returncode, stdout=stdout, stderr=stderr
    )


def test_detect_true_for_uv_project(fixtures_root: Path):
    adapter = PythonAdapter()
    assert adapter.detect(fixtures_root / "python" / "uv-project") is True


def test_detect_false_for_unrelated_project(fixtures_root: Path):
    adapter = PythonAdapter()
    assert adapter.detect(fixtures_root / "go" / "go-project") is False


def test_required_version_from_python_version_file(fixtures_root: Path):
    adapter = PythonAdapter()
    required, source = adapter._required_version(fixtures_root / "python" / "uv-project")
    assert required == "3.12"
    assert source == ".python-version"


def test_required_version_from_pyproject_when_no_version_file(fixtures_root: Path):
    adapter = PythonAdapter()
    required, source = adapter._required_version(fixtures_root / "python" / "poetry-project")
    # poetry-project fixture has no .python-version and requires-python isn't in [project]
    assert required is None


def test_inspect_runtime_reports_not_installed(monkeypatch, fixtures_root: Path):
    adapter = PythonAdapter()
    monkeypatch.setattr("devtwin.adapters.python.which", lambda name: None)
    runtimes = adapter.inspect_runtime(fixtures_root / "python" / "uv-project")
    assert len(runtimes) == 1
    assert runtimes[0].presence == Presence.NOT_INSTALLED
    assert runtimes[0].required_version == "3.12"


def test_inspect_runtime_parses_installed_version(monkeypatch, fixtures_root: Path):
    adapter = PythonAdapter()
    monkeypatch.setattr("devtwin.adapters.python.which", lambda name: "/usr/bin/python3")
    monkeypatch.setattr(
        "devtwin.adapters.python.run_command",
        lambda args, timeout=5: _fake_command(args[0], args[1:], stdout="Python 3.11.4\n"),
    )
    runtimes = adapter.inspect_runtime(fixtures_root / "python" / "uv-project")
    assert runtimes[0].presence == Presence.INSTALLED
    assert runtimes[0].installed_version == "3.11.4"


def test_inspect_dependencies_detects_uv_manager(fixtures_root: Path):
    adapter = PythonAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "python" / "uv-project")
    assert deps is not None
    assert deps.manager == "uv"
    assert deps.lockfile == "uv.lock"
    assert deps.dependency_count == 2


def test_inspect_dependencies_detects_poetry_manager(fixtures_root: Path):
    adapter = PythonAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "python" / "poetry-project")
    assert deps is not None
    assert deps.manager == "poetry"
    assert deps.lockfile == "poetry.lock"


def test_run_never_raises_when_python_missing(monkeypatch, fixtures_root: Path):
    adapter = PythonAdapter()
    monkeypatch.setattr("devtwin.adapters.python.which", lambda name: None)
    result = adapter.run(fixtures_root / "python" / "uv-project")
    assert result.applicable is True
    assert any(rt.presence == Presence.NOT_INSTALLED for rt in result.runtimes)
    assert any(issue.code == "python.not_installed" for issue in result.issues)

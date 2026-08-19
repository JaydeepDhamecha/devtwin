from __future__ import annotations

from pathlib import Path

from devtwin.adapters.go import GoAdapter
from devtwin.core.models import Presence


def test_detect(fixtures_root: Path):
    adapter = GoAdapter()
    assert adapter.detect(fixtures_root / "go" / "go-project") is True
    assert adapter.detect(fixtures_root / "rust" / "rust-project") is False


def test_required_version_from_go_mod(fixtures_root: Path):
    adapter = GoAdapter()
    assert adapter._required_version(fixtures_root / "go" / "go-project") == "1.22"


def test_inspect_dependencies(fixtures_root: Path):
    adapter = GoAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "go" / "go-project")
    assert deps.manager == "go modules"
    assert deps.lockfile == "go.sum"
    assert "module example.com/devtwinfixture" in deps.notes


def test_inspect_runtime_not_installed(monkeypatch, fixtures_root: Path):
    adapter = GoAdapter()
    monkeypatch.setattr("devtwin.adapters.go.which", lambda name: None)
    runtimes = adapter.inspect_runtime(fixtures_root / "go" / "go-project")
    assert runtimes[0].presence == Presence.NOT_INSTALLED
    assert runtimes[0].required_version == "1.22"


def test_inspect_tests(fixtures_root: Path):
    adapter = GoAdapter()
    assert adapter.inspect_tests(fixtures_root / "go" / "go-project") == ["go test ./..."]

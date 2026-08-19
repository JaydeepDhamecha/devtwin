from __future__ import annotations

from pathlib import Path

from devtwin.adapters.dotnet import DotnetAdapter
from devtwin.core.models import Presence


def test_detect(fixtures_root: Path):
    adapter = DotnetAdapter()
    assert adapter.detect(fixtures_root / "dotnet" / "dotnet-project") is True
    assert adapter.detect(fixtures_root / "go" / "go-project") is False


def test_required_version_from_global_json(fixtures_root: Path):
    adapter = DotnetAdapter()
    required, source = adapter._required_version(fixtures_root / "dotnet" / "dotnet-project")
    assert required == "8.0.100"
    assert source == "global.json"


def test_inspect_dependencies(fixtures_root: Path):
    adapter = DotnetAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "dotnet" / "dotnet-project")
    assert deps is not None
    assert deps.manager == "nuget"


def test_inspect_runtime_not_installed(monkeypatch, fixtures_root: Path):
    adapter = DotnetAdapter()
    monkeypatch.setattr("devtwin.adapters.dotnet.which", lambda name: None)
    runtimes = adapter.inspect_runtime(fixtures_root / "dotnet" / "dotnet-project")
    assert runtimes[0].presence == Presence.NOT_INSTALLED
    assert runtimes[0].required_version == "8.0.100"

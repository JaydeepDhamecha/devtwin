from __future__ import annotations

from pathlib import Path

from devtwin.adapters.swift import SwiftAdapter
from devtwin.core.models import Presence


def test_detect_spm(fixtures_root: Path):
    adapter = SwiftAdapter()
    assert adapter.detect(fixtures_root / "swift" / "spm-project") is True
    assert adapter.detect(fixtures_root / "go" / "go-project") is False


def test_detect_xcode_project(fixtures_root: Path):
    adapter = SwiftAdapter()
    assert adapter.detect(fixtures_root / "swift" / "ios-project") is True


def test_inspect_dependencies_spm(fixtures_root: Path):
    adapter = SwiftAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "swift" / "spm-project")
    assert deps.manager == "spm"
    assert deps.lockfile == "Package.resolved"


def test_inspect_dependencies_cocoapods(fixtures_root: Path):
    adapter = SwiftAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "swift" / "ios-project")
    assert deps.manager == "cocoapods"
    assert deps.lockfile == "Podfile.lock"


def test_inspect_runtime_not_installed(monkeypatch, fixtures_root: Path):
    adapter = SwiftAdapter()
    monkeypatch.setattr("devtwin.adapters.swift.which", lambda name: None)
    runtimes = adapter.inspect_runtime(fixtures_root / "swift" / "spm-project")
    assert runtimes[0].presence == Presence.NOT_INSTALLED


def test_required_tools_version_parsed(fixtures_root: Path):
    adapter = SwiftAdapter()
    required = adapter._required_tools_version(fixtures_root / "swift" / "spm-project")
    assert required == "5.9"


def test_inspect_tests_spm_only(fixtures_root: Path):
    adapter = SwiftAdapter()
    assert adapter.inspect_tests(fixtures_root / "swift" / "spm-project") == ["swift test"]
    # iOS projects without a detectable scheme will return empty
    assert adapter.inspect_tests(fixtures_root / "swift" / "ios-project") == []


def test_inspect_build_commands_spm(fixtures_root: Path):
    adapter = SwiftAdapter()
    assert adapter.inspect_build_commands(fixtures_root / "swift" / "spm-project") == ["swift build"]


def test_inspect_build_commands_xcode_no_scheme(fixtures_root: Path):
    adapter = SwiftAdapter()
    # iOS projects without a detectable scheme will return empty
    assert adapter.inspect_build_commands(fixtures_root / "swift" / "ios-project") == []


def test_detect_scheme_with_mock(monkeypatch, fixtures_root: Path):
    import json
    from devtwin.core.models import CommandResult

    adapter = SwiftAdapter()
    mock_scheme_list = {
        "project": {"schemes": ["MyApp", "MyAppTests"]},
    }
    mock_result = CommandResult(
        executable="xcodebuild",
        args=["-list", "-json"],
        available=True,
        returncode=0,
        stdout=json.dumps(mock_scheme_list),
        stderr="",
    )
    monkeypatch.setattr(
        "devtwin.adapters.swift.run_command",
        lambda *args, **kwargs: mock_result,
    )
    scheme = adapter._detect_scheme(fixtures_root / "swift" / "ios-project")
    assert scheme == "MyApp"

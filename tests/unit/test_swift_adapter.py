from __future__ import annotations

import json
import shlex
from pathlib import Path

from devtwin.adapters.swift import SwiftAdapter
from devtwin.core.models import CommandResult, Presence, Severity


def _command_result(executable: str, args: list[str], stdout: str = "", **kwargs) -> CommandResult:
    defaults: dict = {"returncode": 0, "stdout": stdout, "stderr": ""}
    defaults.update(kwargs)
    return CommandResult(executable=executable, args=args, **defaults)


def _fake_xcodebuild(
    monkeypatch,
    schemes: list[str] | None = None,
    *,
    timed_out: bool = False,
    returncode: int = 0,
    stdout: str | None = None,
    container: str = "project",
) -> list[list[str]]:
    """Stub out `which` + `run_command` for the swift adapter.

    Returns the list of argv lists the adapter *would* have executed, so tests
    can assert on fork counts. No real xcodebuild ever runs.
    """
    calls: list[list[str]] = []
    if stdout is None:
        stdout = json.dumps({container: {"schemes": schemes or []}})

    def fake_which(name: str) -> str | None:
        return f"/usr/bin/{name}"

    def fake_run_command(args: list[str], **kwargs) -> CommandResult:
        calls.append(list(args))
        if "-list" in args:
            if timed_out:
                return _command_result(
                    args[0], args[1:], returncode=None, timed_out=True, stdout=""
                )
            return _command_result(args[0], args[1:], stdout=stdout, returncode=returncode)
        # `swift --version` / `xcodebuild -version` probes.
        return _command_result(args[0], args[1:], stdout="version 15.0")

    monkeypatch.setattr("devtwin.adapters.swift.which", fake_which)
    monkeypatch.setattr("devtwin.adapters.swift.run_command", fake_run_command)
    return calls


def _xcode_project(root: Path, name: str = "MyApp", *, sdkroot: str = "iphoneos") -> Path:
    project = root / f"{name}.xcodeproj"
    project.mkdir(parents=True, exist_ok=True)
    (project / "project.pbxproj").write_text(
        f"// !$*UTF8*$!\n{{ buildSettings = {{ SDKROOT = {sdkroot}; }}; }}\n",
        encoding="utf-8",
    )
    return root


def _pods_workspace(root: Path, name: str = "MyApp") -> Path:
    _xcode_project(root, name)
    (root / f"{name}.xcworkspace").mkdir(parents=True, exist_ok=True)
    (root / "Podfile").write_text("platform :ios, '16.0'\n", encoding="utf-8")
    return root


def _list_calls(calls: list[list[str]]) -> list[list[str]]:
    return [c for c in calls if "-list" in c]


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


def test_inspect_tests_spm_only(monkeypatch, fixtures_root: Path):
    adapter = SwiftAdapter()
    _fake_xcodebuild(monkeypatch, ["MyApp"])
    assert adapter.inspect_tests(fixtures_root / "swift" / "spm-project") == ["swift test"]
    # An iOS project has no destination that can run tests -- see
    # test_ios_project_emits_no_test_command.
    assert adapter.inspect_tests(fixtures_root / "swift" / "ios-project") == []


def test_inspect_build_commands_spm(fixtures_root: Path):
    adapter = SwiftAdapter()
    assert adapter.inspect_build_commands(fixtures_root / "swift" / "spm-project") == [
        "swift build"
    ]


def test_inspect_build_commands_xcode_no_scheme(monkeypatch, fixtures_root: Path):
    adapter = SwiftAdapter()
    # xcodebuild missing entirely: no scheme, so no command.
    monkeypatch.setattr("devtwin.adapters.swift.which", lambda name: None)
    assert adapter.inspect_build_commands(fixtures_root / "swift" / "ios-project") == []


def test_detect_scheme_with_mock(monkeypatch, fixtures_root: Path):
    adapter = SwiftAdapter()
    _fake_xcodebuild(monkeypatch, ["MyApp", "MyAppTests"])
    assert adapter._detect_scheme(fixtures_root / "swift" / "ios-project") == "MyApp"


def test_scheme_with_space_is_quoted(monkeypatch, tmp_path: Path):
    """A scheme like `My App` must stay one argv entry, not split into two."""
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "My App")
    _fake_xcodebuild(monkeypatch, ["My App"])

    commands = adapter.inspect_build_commands(tmp_path)
    assert len(commands) == 1
    assert "-scheme 'My App'" in commands[0]

    args = shlex.split(commands[0])
    assert args[args.index("-scheme") + 1] == "My App"
    # The project name is interpolated too, and carries the same space.
    assert args[args.index("-project") + 1] == "My App.xcodeproj"


def test_scheme_selection_prefers_app_over_pods(monkeypatch, tmp_path: Path):
    """On a CocoaPods workspace the first scheme is a dependency, not the app."""
    adapter = SwiftAdapter()
    _pods_workspace(tmp_path, "MyApp")
    _fake_xcodebuild(
        monkeypatch,
        ["Alamofire", "Pods-MyApp", "MyApp", "MyAppTests"],
        container="workspace",
    )

    detection = adapter._scheme_detection(tmp_path)
    assert detection.scheme == "MyApp"
    assert detection.reason == "matches the project/workspace name"


def test_scheme_selection_skips_pods_when_no_name_match(monkeypatch, tmp_path: Path):
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "renamed-project")
    _fake_xcodebuild(monkeypatch, ["Pods-Something", "SomeApp", "SomeAppTests"])

    detection = adapter._scheme_detection(tmp_path)
    assert detection.scheme == "SomeApp"
    assert detection.schemes == ["Pods-Something", "SomeApp", "SomeAppTests"]


def test_scheme_choice_is_visible_in_issues(monkeypatch, tmp_path: Path):
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "MyApp")
    _fake_xcodebuild(monkeypatch, ["Pods-MyApp", "MyApp"])

    result = adapter.run(tmp_path)
    selected = [i for i in result.issues if i.code == "swift.scheme_selected"]
    assert len(selected) == 1
    assert "MyApp" in selected[0].title
    assert any("Pods-MyApp, MyApp" in e for e in selected[0].evidence)
    assert selected[0].severity == Severity.INFO


def test_detect_scheme_forks_at_most_once_per_run(monkeypatch, tmp_path: Path):
    """inspect_tests and inspect_build_commands must share one `xcodebuild -list`."""
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "MyApp", sdkroot="macosx")
    calls = _fake_xcodebuild(monkeypatch, ["MyApp"])

    result = adapter.run(tmp_path)
    # Both a test command and a build command were produced from one probe.
    assert result.test_commands and result.build_commands
    assert len(_list_calls(calls)) == 1

    # The cache does not survive the run, so a second run re-probes rather than
    # reporting a scheme that may no longer exist.
    adapter.run(tmp_path)
    assert len(_list_calls(calls)) == 2


def test_macos_project_builds_and_tests_against_macos(monkeypatch, tmp_path: Path):
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "MacApp", sdkroot="macosx")
    _fake_xcodebuild(monkeypatch, ["MacApp"])

    assert adapter._detect_platform(tmp_path) == "macos"
    build = adapter.inspect_build_commands(tmp_path)[0]
    assert "iphonesimulator" not in build
    assert "-destination platform=macOS" in build

    tests = adapter.inspect_tests(tmp_path)
    assert tests == [
        "xcodebuild test -scheme MacApp -destination platform=macOS -project MacApp.xcodeproj"
    ]


def test_ios_project_builds_against_simulator_sdk(monkeypatch, tmp_path: Path):
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "MyApp", sdkroot="iphoneos")
    _fake_xcodebuild(monkeypatch, ["MyApp"])

    assert adapter._detect_platform(tmp_path) == "ios"
    build = adapter.inspect_build_commands(tmp_path)[0]
    assert "-sdk iphonesimulator" in build
    assert "CODE_SIGNING_ALLOWED=NO" in build


def test_unknown_platform_emits_no_sdk_flags(monkeypatch, tmp_path: Path):
    """Without a known platform, don't force an SDK that may be wrong."""
    adapter = SwiftAdapter()
    project = tmp_path / "Mystery.xcodeproj"
    project.mkdir()
    (project / "project.pbxproj").write_text("{ }\n", encoding="utf-8")
    _fake_xcodebuild(monkeypatch, ["Mystery"])

    assert adapter._detect_platform(tmp_path) is None
    build = adapter.inspect_build_commands(tmp_path)[0]
    assert "-sdk" not in shlex.split(build)
    assert "-destination" not in shlex.split(build)


def test_ios_project_emits_no_test_command(monkeypatch, tmp_path: Path):
    """A generic destination can never run tests: report unknown, not a failure."""
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "MyApp", sdkroot="iphoneos")
    _fake_xcodebuild(monkeypatch, ["MyApp"])

    result = adapter.run(tmp_path)
    assert result.test_commands == []
    codes = {i.code for i in result.issues}
    assert "swift.xcode_tests_need_destination" in codes


def test_scheme_detection_timeout_degrades_explicitly(monkeypatch, tmp_path: Path):
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "MyApp")
    _fake_xcodebuild(monkeypatch, ["MyApp"], timed_out=True)

    result = adapter.run(tmp_path)
    assert result.build_commands == []
    failed = [i for i in result.issues if i.code == "swift.scheme_detection_failed"]
    assert len(failed) == 1
    assert "did not finish" in failed[0].message


def test_unparseable_scheme_list_degrades_explicitly(monkeypatch, tmp_path: Path):
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "MyApp")
    _fake_xcodebuild(monkeypatch, stdout="not json at all", returncode=0)

    result = adapter.run(tmp_path)
    assert result.build_commands == []
    failed = [i for i in result.issues if i.code == "swift.scheme_detection_failed"]
    assert len(failed) == 1
    assert "readable JSON" in failed[0].message


def test_empty_scheme_list_is_reported_as_no_schemes(monkeypatch, tmp_path: Path):
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "MyApp")
    _fake_xcodebuild(monkeypatch, [])

    result = adapter.run(tmp_path)
    assert result.build_commands == []
    assert "swift.no_schemes" in {i.code for i in result.issues}


def test_nonzero_exit_degrades_explicitly(monkeypatch, tmp_path: Path):
    adapter = SwiftAdapter()
    _xcode_project(tmp_path, "MyApp")
    _fake_xcodebuild(monkeypatch, ["MyApp"], returncode=65)

    result = adapter.run(tmp_path)
    assert result.build_commands == []
    assert "swift.scheme_detection_failed" in {i.code for i in result.issues}


def test_missing_xcode_files_do_not_raise(monkeypatch, tmp_path: Path):
    """detect() can see a project that is gone by the time commands are built."""
    adapter = SwiftAdapter()
    _fake_xcodebuild(monkeypatch, ["MyApp"])
    (tmp_path / "Podfile").write_text("platform :ios, '16.0'\n", encoding="utf-8")

    assert adapter.detect(tmp_path) is True
    assert adapter.inspect_build_commands(tmp_path) == []
    assert adapter.inspect_tests(tmp_path) == []

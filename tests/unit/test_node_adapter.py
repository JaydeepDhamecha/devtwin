from __future__ import annotations

from pathlib import Path

from devtwin.adapters.node import NodeAdapter
from devtwin.core.models import CommandResult, Presence


def _fake_command(executable, args, returncode=0, stdout="", stderr=""):
    return CommandResult(
        executable=executable, args=args, returncode=returncode, stdout=stdout, stderr=stderr
    )


def test_detect_true_for_pnpm_project(fixtures_root: Path):
    adapter = NodeAdapter()
    assert adapter.detect(fixtures_root / "node" / "pnpm-project") is True


def test_manager_detected_from_package_manager_field(fixtures_root: Path):
    adapter = NodeAdapter()
    manager, version = adapter._detect_manager(fixtures_root / "node" / "pnpm-project")
    assert manager == "pnpm"
    assert version == "9.1.0"


def test_manager_detected_from_lockfile_when_no_field(fixtures_root: Path):
    adapter = NodeAdapter()
    manager, version = adapter._detect_manager(fixtures_root / "node" / "npm-project")
    assert manager == "npm"
    assert version is None


def test_required_node_version_from_engines(fixtures_root: Path):
    adapter = NodeAdapter()
    required, source = adapter._required_version(fixtures_root / "node" / "pnpm-project")
    assert required == ">=20"
    assert source == "package.json engines.node"


def test_inspect_dependencies_counts(fixtures_root: Path):
    adapter = NodeAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "node" / "pnpm-project")
    assert deps is not None
    assert deps.dependency_count == 1
    assert deps.dev_dependency_count == 2
    assert deps.installed == Presence.NOT_INSTALLED  # no node_modules/ in fixture


def test_inspect_tests_uses_correct_runner(fixtures_root: Path):
    adapter = NodeAdapter()
    commands = adapter.inspect_tests(fixtures_root / "node" / "pnpm-project")
    assert "pnpm test" in commands
    assert "pnpm run lint" in commands


def test_inspect_tests_npm_project(fixtures_root: Path):
    adapter = NodeAdapter()
    commands = adapter.inspect_tests(fixtures_root / "node" / "npm-project")
    assert "npm test" in commands


def test_inspect_runtime_not_installed(monkeypatch, fixtures_root: Path):
    adapter = NodeAdapter()
    monkeypatch.setattr("devtwin.adapters.node.which", lambda name: None)
    runtimes = adapter.inspect_runtime(fixtures_root / "node" / "pnpm-project")
    assert runtimes[0].presence == Presence.NOT_INSTALLED


def test_run_never_raises(fixtures_root: Path):
    adapter = NodeAdapter()
    result = adapter.run(fixtures_root / "node" / "npm-project")
    assert result.applicable is True

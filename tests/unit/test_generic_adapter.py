from __future__ import annotations

from pathlib import Path

from devtwin.adapters.generic import GenericAdapter


def test_always_detects(tmp_path: Path):
    adapter = GenericAdapter()
    assert adapter.detect(tmp_path) is True


def test_inspect_dependencies_finds_dockerfile_and_compose(fixtures_root: Path):
    adapter = GenericAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "generic" / "docker-project")
    assert deps is not None
    assert "Dockerfile" in deps.notes
    assert "docker-compose.yml" in deps.notes


def test_inspect_tests_finds_make_target(fixtures_root: Path):
    adapter = GenericAdapter()
    commands = adapter.inspect_tests(fixtures_root / "generic" / "docker-project")
    assert "make test" in commands


def test_inspect_build_commands(fixtures_root: Path):
    adapter = GenericAdapter()
    commands = adapter.inspect_build_commands(fixtures_root / "generic" / "docker-project")
    assert "make build" in commands
    assert "docker build ." in commands


def test_run_does_not_raise_on_empty_dir(tmp_path: Path):
    adapter = GenericAdapter()
    result = adapter.run(tmp_path)
    assert result.applicable is True

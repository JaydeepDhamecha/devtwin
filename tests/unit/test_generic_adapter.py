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


def test_docker_build_is_never_an_executed_build_command(fixtures_root: Path, tmp_path: Path):
    """dev_build executes build_commands, and an image build is not a read-only check."""
    adapter = GenericAdapter()
    commands = adapter.inspect_build_commands(fixtures_root / "generic" / "docker-project")
    assert not any("docker" in c for c in commands)

    # ...including a project whose only signal is a Dockerfile.
    (tmp_path / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
    assert adapter.inspect_build_commands(tmp_path) == []
    assert adapter.run(tmp_path).build_commands == []


def test_docker_advice_is_surfaced_as_a_health_issue(tmp_path: Path):
    adapter = GenericAdapter()
    (tmp_path / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
    (tmp_path / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")

    codes = {issue.code for issue in adapter.run(tmp_path).issues}
    assert "generic.docker_image_build_available" in codes
    assert "generic.compose_services_available" in codes


def test_run_does_not_raise_on_empty_dir(tmp_path: Path):
    adapter = GenericAdapter()
    result = adapter.run(tmp_path)
    assert result.applicable is True

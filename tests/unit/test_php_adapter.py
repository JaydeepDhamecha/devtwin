from __future__ import annotations

from pathlib import Path

from devtwin.adapters.php import PhpAdapter
from devtwin.core.models import Presence


def test_detect(fixtures_root: Path):
    adapter = PhpAdapter()
    assert adapter.detect(fixtures_root / "php" / "php-project") is True
    assert adapter.detect(fixtures_root / "go" / "go-project") is False


def test_inspect_dependencies(fixtures_root: Path):
    adapter = PhpAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "php" / "php-project")
    assert deps.manager == "composer"
    assert deps.lockfile == "composer.lock"


def test_inspect_runtime_not_installed(monkeypatch, fixtures_root: Path):
    adapter = PhpAdapter()
    monkeypatch.setattr("devtwin.adapters.php.which", lambda name: None)
    runtimes = adapter.inspect_runtime(fixtures_root / "php" / "php-project")
    assert runtimes[0].presence == Presence.NOT_INSTALLED
    assert runtimes[0].required_version == ">=8.1"


def test_inspect_tests_composer_script(fixtures_root: Path):
    adapter = PhpAdapter()
    assert adapter.inspect_tests(fixtures_root / "php" / "php-project") == ["composer test"]


def test_required_version_parsed(fixtures_root: Path):
    adapter = PhpAdapter()
    assert adapter._required_version(fixtures_root / "php" / "php-project") == ">=8.1"

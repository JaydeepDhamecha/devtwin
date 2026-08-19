from __future__ import annotations

from pathlib import Path

from devtwin.adapters.ruby import RubyAdapter
from devtwin.core.models import Presence


def test_detect(fixtures_root: Path):
    adapter = RubyAdapter()
    assert adapter.detect(fixtures_root / "ruby" / "ruby-project") is True
    assert adapter.detect(fixtures_root / "go" / "go-project") is False


def test_inspect_dependencies(fixtures_root: Path):
    adapter = RubyAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "ruby" / "ruby-project")
    assert deps.manager == "bundler"
    assert deps.lockfile == "Gemfile.lock"


def test_inspect_runtime_not_installed(monkeypatch, fixtures_root: Path):
    adapter = RubyAdapter()
    monkeypatch.setattr("devtwin.adapters.ruby.which", lambda name: None)
    runtimes = adapter.inspect_runtime(fixtures_root / "ruby" / "ruby-project")
    assert runtimes[0].presence == Presence.NOT_INSTALLED
    assert runtimes[0].required_version == "3.2.2"


def test_inspect_tests(fixtures_root: Path):
    adapter = RubyAdapter()
    assert adapter.inspect_tests(fixtures_root / "ruby" / "ruby-project") == ["bundle exec rspec"]


def test_required_version_parsed(fixtures_root: Path):
    adapter = RubyAdapter()
    assert adapter._required_version(fixtures_root / "ruby" / "ruby-project") == "3.2.2"

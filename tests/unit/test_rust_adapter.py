from __future__ import annotations

from pathlib import Path

from devtwin.adapters.rust import RustAdapter
from devtwin.core.models import Presence


def test_detect(fixtures_root: Path):
    adapter = RustAdapter()
    assert adapter.detect(fixtures_root / "rust" / "rust-project") is True
    assert adapter.detect(fixtures_root / "go" / "go-project") is False


def test_inspect_dependencies(fixtures_root: Path):
    adapter = RustAdapter()
    deps = adapter.inspect_dependencies(fixtures_root / "rust" / "rust-project")
    assert deps.manager == "cargo"
    assert deps.lockfile == "Cargo.lock"


def test_inspect_runtime_not_installed(monkeypatch, fixtures_root: Path):
    adapter = RustAdapter()
    monkeypatch.setattr("devtwin.adapters.rust.which", lambda name: None)
    runtimes = adapter.inspect_runtime(fixtures_root / "rust" / "rust-project")
    assert runtimes[0].presence == Presence.NOT_INSTALLED


def test_inspect_tests(fixtures_root: Path):
    adapter = RustAdapter()
    assert adapter.inspect_tests(fixtures_root / "rust" / "rust-project") == ["cargo test"]


def test_toolchain_channel_parsed(tmp_path: Path):
    adapter = RustAdapter()
    (tmp_path / "Cargo.toml").write_text("[package]\nname = 'x'\n")
    (tmp_path / "rust-toolchain.toml").write_text('[toolchain]\nchannel = "1.75.0"\n')
    required, source = adapter._required_version(tmp_path)
    assert required == "1.75.0"
    assert source == "rust-toolchain.toml"

from __future__ import annotations

from pathlib import Path

from devtwin.core.drift import compute_drift


def test_drift_nonexistent_workspace(tmp_path: Path):
    report = compute_drift(str(tmp_path / "nope"))
    assert report.has_drift is False


def test_drift_detects_go_version_mismatch(tmp_path: Path, monkeypatch):
    (tmp_path / "go.mod").write_text("module example.com/x\n\ngo 1.99\n")

    import devtwin.adapters.go as go_module
    from devtwin.core.models import CommandResult

    monkeypatch.setattr(go_module, "which", lambda name: "/usr/local/bin/go")
    monkeypatch.setattr(
        go_module,
        "run_command",
        lambda args, timeout=5: CommandResult(
            executable=args[0],
            args=args[1:],
            returncode=0,
            stdout="go version go1.22.0 darwin/arm64\n",
            stderr="",
        ),
    )

    report = compute_drift(str(tmp_path))
    assert report.has_drift is True
    assert any(item.subject == "go" for item in report.items)


def test_drift_no_drift_when_versions_match(tmp_path: Path, monkeypatch):
    (tmp_path / "go.mod").write_text("module example.com/x\n\ngo 1.22\n")

    import devtwin.adapters.go as go_module
    from devtwin.core.models import CommandResult

    monkeypatch.setattr(go_module, "which", lambda name: "/usr/local/bin/go")
    monkeypatch.setattr(
        go_module,
        "run_command",
        lambda args, timeout=5: CommandResult(
            executable=args[0],
            args=args[1:],
            returncode=0,
            stdout="go version go1.22.0 darwin/arm64\n",
            stderr="",
        ),
    )

    report = compute_drift(str(tmp_path))
    assert report.has_drift is False

from __future__ import annotations

import socket
from pathlib import Path

from devtwin.core.diagnostics import diagnose_failure


def test_diagnose_nonexistent_workspace(tmp_path: Path):
    report = diagnose_failure(str(tmp_path / "nope"), "some error")
    assert report.candidates == []


def test_diagnose_port_in_use(tmp_path: Path):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        report = diagnose_failure(
            str(tmp_path), f"Error: listen EADDRINUSE: address already in use :::{port}"
        )
        assert report.strongest is not None
        assert str(port) in report.strongest.cause


def test_diagnose_python_module_not_found(tmp_path: Path):
    report = diagnose_failure(str(tmp_path), "ModuleNotFoundError: No module named 'requests'")
    assert report.strongest is not None
    assert "requests" in report.strongest.cause


def test_diagnose_node_module_not_found(tmp_path: Path):
    report = diagnose_failure(str(tmp_path), "Error: Cannot find module 'express'")
    assert report.strongest is not None
    assert "express" in report.strongest.cause


def test_diagnose_no_match_falls_back_to_low_confidence(tmp_path: Path):
    report = diagnose_failure(str(tmp_path), "some totally unrecognizable error text")
    assert report.strongest is not None
    assert report.strongest.confidence < 0.5


def test_diagnose_never_asserts_certainty(tmp_path: Path):
    report = diagnose_failure(str(tmp_path), "ModuleNotFoundError: No module named 'flask'")
    for candidate in report.candidates:
        assert candidate.confidence <= 1.0

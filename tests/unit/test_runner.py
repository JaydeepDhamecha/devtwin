from __future__ import annotations

from devtwin.adapters.base import extract_version, major_version, version_mismatch, version_tuple
from devtwin.core.runner import run_command, which


def test_which_finds_python():
    assert which("python3") is not None or which("python") is not None


def test_run_command_missing_executable_is_structured_not_raised():
    result = run_command(["this-executable-does-not-exist-devtwin"])
    assert result.available is False
    assert result.returncode is None


def test_run_command_runs_real_python():
    py = which("python3") or which("python")
    result = run_command([py, "--version"], timeout=5)
    assert result.available is True
    assert result.returncode == 0
    assert "Python" in (result.stdout + result.stderr)


def test_run_command_times_out():
    py = which("python3") or which("python")
    result = run_command([py, "-c", "import time; time.sleep(5)"], timeout=0.2)
    assert result.timed_out is True


def test_extract_version_from_free_text():
    assert extract_version("Python 3.12.4") == "3.12.4"
    assert extract_version("go version go1.22.1 darwin/arm64") == "1.22.1"
    assert extract_version("no version here") is None


def test_version_tuple_and_major_version():
    assert version_tuple("3.12.4") == (3, 12, 4)
    assert major_version("21.0.1") == 21
    assert major_version(None) is None


def test_version_mismatch_gte_satisfied_by_newer():
    assert version_mismatch(">=18", "22.16.0") is False
    assert version_mismatch(">=3.12", "3.14.0") is False


def test_version_mismatch_gte_violated_by_older():
    assert version_mismatch(">=20", "18.2.0") is True


def test_version_mismatch_caret_same_major_ok():
    assert version_mismatch("^9.1.0", "9.5.0") is False
    assert version_mismatch("^9.1.0", "10.0.0") is True
    assert version_mismatch("^9.1.0", "9.0.0") is True  # older than pinned


def test_version_mismatch_tilde_same_minor_ok():
    assert version_mismatch("~1.22.0", "1.22.5") is False
    assert version_mismatch("~1.22.0", "1.23.0") is True


def test_version_mismatch_bare_pin_checks_given_components_only():
    assert version_mismatch("21", "21.0.5") is False  # major-only pin
    assert version_mismatch("21", "17.0.1") is True
    assert version_mismatch("3.12", "3.12.4") is False  # major.minor pin
    assert version_mismatch("3.12", "3.11.0") is True

from __future__ import annotations

from devtwin.core.models import ActionClass
from devtwin.security.approvals import capability_table, classify_tool
from devtwin.security.permissions import is_allowed_executable, is_dangerous


def test_allowed_executables():
    assert is_allowed_executable("pytest") is True
    assert is_allowed_executable("git") is True
    assert is_allowed_executable("/usr/local/bin/pytest") is True


def test_disallowed_executable():
    assert is_allowed_executable("curl") is False
    assert is_allowed_executable("bash") is False
    assert is_allowed_executable("rm") is False


def test_dangerous_args_detected():
    assert is_dangerous(["reset", "--hard"]) is True
    assert is_dangerous(["push", "--force"]) is True
    assert is_dangerous(["compose", "down"]) is True


def test_safe_args_not_dangerous():
    assert is_dangerous(["test"]) is False
    assert is_dangerous(["--version"]) is False


def test_classify_tool_read_only():
    assert classify_tool("dev_detect") == ActionClass.READ_ONLY
    assert classify_tool("dev_health") == ActionClass.READ_ONLY


def test_classify_tool_safe_execution():
    assert classify_tool("dev_check") == ActionClass.SAFE


def test_classify_tool_unknown_requires_approval():
    assert classify_tool("some_future_tool") == ActionClass.REQUIRES_APPROVAL


def test_capability_table_covers_all_tools():
    table = capability_table()
    names = {c.name for c in table}
    assert "dev_detect" in names
    assert "dev_check" in names
    assert "dev_prepare" in names

from __future__ import annotations

import asyncio

from devtwin.core.models import ActionClass
from devtwin.security.approvals import (
    PLANNING_TOOLS,
    READ_ONLY_TOOLS,
    SAFE_EXECUTION_TOOLS,
    capability_table,
    classify_tool,
)
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


def test_classify_tool_health_all_is_read_only():
    assert classify_tool("dev_health_all") == ActionClass.READ_ONLY


def test_classify_tool_builds_are_safe_execution():
    assert classify_tool("dev_build") == ActionClass.SAFE
    assert classify_tool("dev_build_all") == ActionClass.SAFE


def _registered_tool_names() -> set[str]:
    """Names of every tool actually registered on the MCP server."""
    from devtwin.server import mcp

    return {t.name for t in asyncio.run(mcp.list_tools())}


def test_every_registered_tool_has_an_explicit_classification():
    # Guards against drift: a tool added to server.py but not to
    # approvals.py would silently fall through to REQUIRES_APPROVAL.
    classified = READ_ONLY_TOOLS | SAFE_EXECUTION_TOOLS | PLANNING_TOOLS
    unclassified = _registered_tool_names() - classified
    assert unclassified == set(), f"tools missing from approvals.py: {sorted(unclassified)}"


def test_no_registered_tool_falls_through_to_requires_approval():
    for name in _registered_tool_names():
        assert classify_tool(name) != ActionClass.REQUIRES_APPROVAL, name


def test_capability_table_lists_every_registered_tool():
    assert {c.name for c in capability_table()} == _registered_tool_names()


def test_classification_sets_are_disjoint_and_have_no_stale_entries():
    registered = _registered_tool_names()
    assert READ_ONLY_TOOLS.isdisjoint(SAFE_EXECUTION_TOOLS)
    assert READ_ONLY_TOOLS.isdisjoint(PLANNING_TOOLS)
    assert SAFE_EXECUTION_TOOLS.isdisjoint(PLANNING_TOOLS)
    stale = (READ_ONLY_TOOLS | SAFE_EXECUTION_TOOLS | PLANNING_TOOLS) - registered
    assert stale == set(), f"classified tools no longer registered: {sorted(stale)}"


def test_generic_task_runners_are_executable():
    """The generic adapter's only build/test commands use these runners. If they
    are not allowlisted, every generic-fallback project reports a permanent
    refusal and can never be built or checked."""
    for command in ("make build", "make test", "just test", "task test"):
        executable = command.split()[0]
        assert is_allowed_executable(executable), f"{executable} must be executable"
        assert not is_dangerous(command.split()), f"{command} must not be denied"


def test_destructive_targets_are_still_denied():
    for command in ("make clean", "make rm", "just clean"):
        assert is_dangerous(command.split()), f"{command} must be denied"

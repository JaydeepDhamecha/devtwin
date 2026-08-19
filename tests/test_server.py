from __future__ import annotations

from pathlib import Path

import pytest

from devtwin import server

FIXTURES_ROOT = Path(__file__).resolve().parent / "fixtures"


@pytest.mark.asyncio
async def test_all_tools_registered_via_mcp():
    tools = await server.mcp.list_tools()
    names = {t.name for t in tools}
    expected = {
        "dev_detect",
        "dev_health",
        "dev_drift",
        "dev_explain_failure",
        "dev_project_info",
        "dev_dependencies",
        "dev_services",
        "dev_check",
        "dev_prepare",
        "dev_precommit",
    }
    assert expected.issubset(names)


def test_dev_detect_shape():
    result = server.dev_detect(str(FIXTURES_ROOT / "python" / "uv-project"))
    assert result["status"] == "ok"
    assert "profile" in result["data"]
    assert result["data"]["profile"]["primary_ecosystem"] == "python"


def test_dev_detect_nonexistent_workspace():
    result = server.dev_detect(str(FIXTURES_ROOT / "does-not-exist"))
    assert result["status"] == "error"


def test_dev_health_shape():
    result = server.dev_health(str(FIXTURES_ROOT / "go" / "go-project"))
    assert result["status"] in ("ok", "warning", "error", "unknown")
    assert "health_score" in result["data"]
    assert isinstance(result["issues"], list)
    assert isinstance(result["recommendations"], list)


def test_dev_drift_shape():
    result = server.dev_drift(str(FIXTURES_ROOT / "go" / "go-project"))
    assert result["status"] in ("ok", "warning")
    assert "items" in result["data"]


def test_dev_explain_failure_shape():
    result = server.dev_explain_failure(
        str(FIXTURES_ROOT / "python" / "uv-project"),
        "ModuleNotFoundError: No module named 'fastapi'",
    )
    assert result["status"] == "ok"
    assert result["data"]["strongest"] is not None


def test_dev_project_info_shape():
    result = server.dev_project_info(str(FIXTURES_ROOT / "kotlin" / "gradle-project"))
    assert result["status"] == "ok"
    assert "adapters" in result["data"]
    assert "os" in result["data"]


def test_dev_dependencies_shape():
    result = server.dev_dependencies(str(FIXTURES_ROOT / "node" / "pnpm-project"))
    assert result["status"] == "ok"
    assert len(result["data"]["dependencies"]) >= 1


def test_dev_services_shape():
    result = server.dev_services(str(FIXTURES_ROOT / "generic" / "docker-project"))
    assert "services" in result["data"]
    assert "docker" in result["data"]


def test_dev_check_rejects_unrecognized_commands():
    result = server.dev_check(str(FIXTURES_ROOT / "python" / "uv-project"), run=["rm -rf /"])
    for r in result["data"]["results"]:
        assert r["executed"] is False


def test_dev_check_never_exposes_arbitrary_execution():
    import inspect

    sig = inspect.signature(server.dev_check)
    assert "command" not in sig.parameters  # only `run`, restricted to recognized commands


def test_dev_prepare_never_executes_and_classifies_steps():
    result = server.dev_prepare(str(FIXTURES_ROOT / "node" / "npm-project"))
    assert result["status"] in ("ok", "unknown")
    for step in result["data"]["plan"]:
        assert step["action_class"] in ("read_only", "safe", "requires_approval", "dangerous")


def test_dev_precommit_shape():
    result = server.dev_precommit(str(FIXTURES_ROOT))
    assert "git" in result["data"] or result["status"] == "unknown"

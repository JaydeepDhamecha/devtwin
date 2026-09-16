from __future__ import annotations

from pathlib import Path

import pytest

from devtwin import server
from devtwin.core.models import CommandResult

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
        "dev_build",
        "dev_prepare",
        "dev_precommit",
        "dev_health_all",
        "dev_build_all",
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


def test_dev_build_shape():
    result = server.dev_build(str(FIXTURES_ROOT / "node" / "npm-project"))
    assert result["status"] in ("ok", "error", "unknown")
    assert "recognized_commands" in result["data"]
    assert "results" in result["data"]


def test_dev_build_all_shape():
    result = server.dev_build_all(str(FIXTURES_ROOT))
    assert result["status"] in ("ok", "error", "unknown")
    assert "ecosystems" in result["data"]


# `bazel` is a real build tool DevTwin does not allowlist, so a recognized
# `bazel build` is the canonical "recognized but refused" command.
REFUSED_BUILD = "bazel build //..."
REFUSED_CHECK = "bazel test //..."


def _inject_adapter(monkeypatch, per_dir: dict[str, dict[str, list[str]]] | None = None, **kw):
    """Force the commands run_adapters reports.

    `per_dir` keys off the directory name for dev_build_all; `kw` (build=[...],
    test=[...]) applies the same commands everywhere.
    """
    from devtwin.core.models import AdapterResult

    def fake_run_adapters(path: Path) -> list[AdapterResult]:
        spec = per_dir.get(Path(path).name, {}) if per_dir else kw
        return [
            AdapterResult(
                ecosystem="node",
                applicable=True,
                build_commands=list(spec.get("build", [])),
                test_commands=list(spec.get("test", [])),
            )
        ]

    monkeypatch.setattr("devtwin.server.run_adapters", fake_run_adapters)


def _makefile_project(path: Path) -> Path:
    """A project whose only build command (`make build`) is outside the allowlist."""
    path.mkdir(parents=True, exist_ok=True)
    (path / "Makefile").write_text("build:\n\techo building\n", encoding="utf-8")
    return path


def _node_project(path: Path) -> Path:
    """A project whose build command (`npm run build`) IS allowlisted, so it
    executes under the fake runner and therefore spends the build budget."""
    path.mkdir(parents=True, exist_ok=True)
    (path / "package.json").write_text(
        '{"name": "p", "scripts": {"build": "tsc"}}', encoding="utf-8"
    )
    return path


def _fake_passing_run(monkeypatch) -> list[list[str]]:
    """Replace the runner so builds are recorded, not actually executed."""
    invocations: list[list[str]] = []

    def fake_run_command(args, cwd=None, timeout=None):
        invocations.append(args)
        return CommandResult(
            executable=args[0], args=args, returncode=0, stdout="built", stderr=""
        )

    monkeypatch.setattr("devtwin.server.run_command", fake_run_command)
    return invocations


def test_dev_build_refused_is_not_ok(tmp_path: Path, monkeypatch):
    _node_project(tmp_path)
    _inject_adapter(monkeypatch, build=[REFUSED_BUILD])

    result = server.dev_build(str(tmp_path))
    assert result["data"]["recognized_commands"] == [REFUSED_BUILD]
    assert all(r["executed"] is False for r in result["data"]["results"])
    assert result["status"] != "ok"  # nothing ran, so nothing can have passed
    assert result["data"]["executed_count"] == 0
    assert result["data"]["passed_count"] == 0
    assert result["data"]["refused_count"] == 1
    assert result["data"]["refused_commands"] == [REFUSED_BUILD]
    assert "refused" in result["summary"]


def test_dev_check_refused_is_not_ok(tmp_path: Path, monkeypatch):
    """`make test` is recognized but outside the allowlist: a check that never ran
    must not be reported as a passing check -- the same defect dev_build had."""
    _node_project(tmp_path)
    _inject_adapter(monkeypatch, test=[REFUSED_CHECK])

    result = server.dev_check(str(tmp_path))
    assert REFUSED_CHECK in result["data"]["recognized_commands"]
    assert all(r["executed"] is False for r in result["data"]["results"])
    assert result["status"] != "ok"  # nothing ran, so nothing can have passed
    assert result["data"]["executed_count"] == 0
    assert result["data"]["passed_count"] == 0
    assert result["data"]["refused_count"] == 1
    assert result["data"]["refused_commands"] == [REFUSED_CHECK]
    assert "refused" in result["summary"]
    # A refused *test* command is a check refusal, not a build refusal.
    assert any(i["code"] == "check.commands_refused" for i in result["issues"])


def test_dev_build_reports_executed_and_refused_separately(tmp_path: Path, monkeypatch):
    """A run containing both an allowlisted and a non-allowlisted command must
    report them separately -- neither collapsing refused into failed, nor
    counting it toward a pass.

    The adapter result is injected: no real project yields this mix, because
    the generic adapter (the only source of `make build`) runs solely when no
    other ecosystem applies.
    """
    from devtwin.core.models import AdapterResult

    monkeypatch.setattr(
        "devtwin.server.run_adapters",
        lambda path: [
            AdapterResult(
                ecosystem="node",
                applicable=True,
                build_commands=["npm run build", REFUSED_BUILD],
            )
        ],
    )
    _fake_passing_run(monkeypatch)

    result = server.dev_build(str(tmp_path))
    assert result["status"] == "warning"  # one build ran clean, one was refused
    assert result["data"]["executed_count"] == 1
    assert result["data"]["passed_count"] == 1
    assert result["data"]["failed_count"] == 0
    assert result["data"]["refused_count"] == 1
    assert result["data"]["refused_commands"] == [REFUSED_BUILD]
    assert result["issues"][0]["code"] == "build.commands_refused"


def test_dev_build_all_refused_ecosystem_is_not_ok(tmp_path: Path, monkeypatch):
    _node_project(tmp_path / "backend")
    _inject_adapter(monkeypatch, per_dir={"backend": {"build": [REFUSED_BUILD]}})
    result = server.dev_build_all(str(tmp_path))
    assert result["status"] != "ok"
    entries = {e["directory"]: e for e in result["data"]["ecosystems"]}
    backend = entries["backend"]
    assert backend["status"] != "ok"
    assert backend["executed_count"] == 0
    assert backend["passed_count"] == 0
    assert backend["refused_count"] == 1
    assert "refused" in result["summary"]  # not rendered as "backend (0/0)"


def test_dev_build_all_builds_workspace_root(tmp_path: Path, monkeypatch):
    (tmp_path / "package.json").write_text('{"scripts": {"build": "tsc"}}', encoding="utf-8")
    invocations = _fake_passing_run(monkeypatch)

    result = server.dev_build_all(str(tmp_path))
    entries = {e["directory"]: e for e in result["data"]["ecosystems"]}
    assert server.ROOT_DIR_LABEL in entries
    root_entry = entries[server.ROOT_DIR_LABEL]
    assert root_entry["build_commands"] == ["npm run build"]
    assert root_entry["passed_count"] == 1
    assert result["status"] == "ok"
    assert invocations == [["npm", "run", "build"]]


@pytest.mark.skipif(
    not hasattr(Path, "symlink_to") or __import__("sys").platform == "win32",
    reason="creating a directory symlink needs elevated privileges on Windows",
)
def test_dev_build_all_does_not_double_count_root(tmp_path: Path, monkeypatch):
    (tmp_path / "package.json").write_text('{"scripts": {"build": "tsc"}}', encoding="utf-8")
    _fake_passing_run(monkeypatch)

    # A subdirectory pointing back at the root must not be built a second time.
    (tmp_path / "app").symlink_to(tmp_path, target_is_directory=True)

    result = server.dev_build_all(str(tmp_path))
    directories = [e["directory"] for e in result["data"]["ecosystems"]]
    assert directories == [server.ROOT_DIR_LABEL]


def test_dev_build_all_caps_total_builds_and_reports_skipped(tmp_path: Path, monkeypatch):
    _node_project(tmp_path)
    for subdir in server.COMMON_MONOREPO_DIRS:
        _node_project(tmp_path / subdir)
    invocations = _fake_passing_run(monkeypatch)

    result = server.dev_build_all(str(tmp_path))
    skipped = result["data"]["skipped_commands"]
    total = len(server.COMMON_MONOREPO_DIRS) + 1  # subdirectories plus the root
    assert len(invocations) == server.MAX_AUTO_BUILD_COMMANDS  # builds actually run
    assert len(skipped) == total - server.MAX_AUTO_BUILD_COMMANDS
    assert result["data"]["max_build_commands"] == server.MAX_AUTO_BUILD_COMMANDS
    assert "not attempted" in result["summary"] or "skipped" in result["summary"]
    assert result["status"] != "ok"
    assert result["recommendations"]


def test_dev_build_all_budget_is_not_spent_on_refused_commands(tmp_path: Path, monkeypatch):
    """A refused command runs nothing, so it must not consume the build budget
    and push a real build further down the scan into "skipped"."""
    refused_dirs = server.COMMON_MONOREPO_DIRS[:5]
    real_dir = server.COMMON_MONOREPO_DIRS[5]
    for subdir in [*refused_dirs, real_dir]:
        _node_project(tmp_path / subdir)
    _inject_adapter(
        monkeypatch,
        per_dir={
            **{d: {"build": [REFUSED_BUILD]} for d in refused_dirs},
            real_dir: {"build": ["npm run build"]},
        },
    )
    invocations = _fake_passing_run(monkeypatch)

    result = server.dev_build_all(str(tmp_path))
    assert invocations == [["npm", "run", "build"]]  # the real build still ran
    assert result["data"]["skipped_commands"] == []

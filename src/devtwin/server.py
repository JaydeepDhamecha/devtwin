"""DevTwin MCP server: exposes development-environment intelligence tools.

Built on the official MCP Python SDK's high-level `MCPServer`. Every tool returns a
JSON-serializable dict shaped like::

    {"status": "ok|warning|error|unknown", "summary": "...",
     "data": {...}, "issues": [...], "recommendations": [...]}

No tool here executes an arbitrary, model-supplied shell string. Commands
that run at all (``dev_check``) are drawn from a recognized, allowlisted set
discovered by ecosystem adapters, run with ``shell=False`` and a timeout.
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

from mcp.server.mcpserver import MCPServer

from devtwin.core.detector import detect_project
from devtwin.core.diagnostics import diagnose_failure
from devtwin.core.drift import compute_drift
from devtwin.core.health import compute_health, run_adapters
from devtwin.core.models import ActionClass, CommandResult, Status, ToolResult
from devtwin.core.runner import run_command
from devtwin.core.workspace import inspect_git, inspect_workspace
from devtwin.security.permissions import is_allowed_executable, is_dangerous
from devtwin.services import detect_services
from devtwin.system.docker import inspect_docker
from devtwin.system.filesystem import list_top_level
from devtwin.system.os import get_os_info

mcp = MCPServer(
    "devtwin",
    instructions=(
        "DevTwin gives you a live, structured view of a developer's local environment: "
        "what kind of project this is, what runtimes/dependencies/services it needs, "
        "what's actually installed and running, and why something might be failing. "
        "Start with dev_detect or dev_health for an overview; use dev_explain_failure "
        "when you have a specific error to diagnose."
    ),
)

SECRET_FILE_PATTERNS = (
    ".env",
    ".pem",
    "id_rsa",
    "id_ed25519",
    "credentials.json",
    "secrets.yml",
    "secrets.yaml",
    ".p12",
    ".pfx",
)

MAX_AUTO_CHECK_COMMANDS = 5
CHECK_TIMEOUT_SECONDS = 120


def _result(
    status: Status,
    summary: str,
    data: dict[str, Any] | None = None,
    issues: list[dict[str, Any]] | None = None,
    recommendations: list[str] | None = None,
) -> dict[str, Any]:
    return ToolResult(
        status=status,
        summary=summary,
        data=data or {},
        issues=issues or [],
        recommendations=recommendations or [],
    ).to_dict()


def _resolve(workspace: str) -> Path:
    return Path(workspace).expanduser().resolve()


@mcp.tool()
def dev_detect(workspace: str = ".") -> dict[str, Any]:
    """Detect what kind of project lives at `workspace`: languages, ecosystems,
    and the evidence (files) behind each detection. Fast, file-based only."""
    ws = inspect_workspace(workspace)
    if not ws.exists:
        return _result(Status.ERROR, f"Workspace '{workspace}' does not exist.")
    profile = detect_project(workspace)
    status = Status.OK if profile.ecosystems else Status.UNKNOWN
    summary = (
        f"Detected {', '.join(profile.ecosystems)} (primary: {profile.primary_ecosystem})"
        if profile.ecosystems
        else "No recognized ecosystem indicators found; generic project."
    )
    return _result(
        status,
        summary,
        data={"profile": profile.to_dict(), "workspace": ws.to_dict()},
    )


@mcp.tool()
def dev_health(workspace: str = ".") -> dict[str, Any]:
    """Full environment health check: combines project detection, runtime
    versions, dependency state, required services, ports, and Git state into
    a 0-100 health_score with concrete issues and recommendations."""
    report = compute_health(workspace)
    return _result(
        report.status,
        f"health_score={report.health_score} ({report.status.value}) -- {report.project_summary}",
        data={
            "health_score": report.health_score,
            "project_summary": report.project_summary,
            "runtime_summary": report.runtime_summary,
            "service_summary": report.service_summary,
            "dependency_summary": report.dependency_summary,
        },
        issues=[i.to_dict() for i in report.issues],
        recommendations=report.recommendations,
    )


@mcp.tool()
def dev_drift(workspace: str = ".") -> dict[str, Any]:
    """Compare expected project state (required runtime/tool versions from
    project files) against what's actually installed locally. Reports each
    mismatch as a structured drift item."""
    report = compute_drift(workspace)
    status = Status.WARNING if report.has_drift else Status.OK
    return _result(
        status,
        report.summary,
        data={"has_drift": report.has_drift, "items": [i.to_dict() for i in report.items]},
        recommendations=[
            f"Align {i.subject}: expected {i.expected}, found {i.actual}." for i in report.items
        ],
    )


@mcp.tool()
def dev_explain_failure(
    workspace: str, error_message: str, command: str | None = None
) -> dict[str, Any]:
    """Diagnose a development failure. Give it the error/output text (and
    optionally the command that produced it); it cross-references project
    type, runtimes, services, ports, and dependencies to rank likely root
    causes with evidence -- never asserting certainty beyond the evidence."""
    report = diagnose_failure(workspace, error_message, command)
    return _result(
        Status.OK,
        report.summary,
        data={
            "candidates": [c.to_dict() for c in report.candidates],
            "strongest": report.strongest.to_dict() if report.strongest else None,
        },
        recommendations=[c.recommendation for c in report.candidates if c.recommendation],
    )


@mcp.tool()
def dev_project_info(workspace: str = ".") -> dict[str, Any]:
    """Detailed project inspection: detected ecosystems, runtimes (installed
    vs required), build tools, test/build commands, environment variables in
    use, OS info, and Git state. Broader and slower than dev_detect."""
    ws = inspect_workspace(workspace)
    if not ws.exists:
        return _result(Status.ERROR, f"Workspace '{workspace}' does not exist.")
    path = _resolve(workspace)
    profile = detect_project(workspace)
    adapters = run_adapters(path)
    os_info = get_os_info()
    return _result(
        Status.OK,
        f"{profile.primary_ecosystem or 'generic'} project with {len(adapters)} applicable adapter(s).",
        data={
            "profile": profile.to_dict(),
            "workspace": ws.to_dict(),
            "os": os_info.to_dict(),
            "adapters": [a.to_dict() for a in adapters],
            "top_level_entries": list_top_level(path),
        },
    )


@mcp.tool()
def dev_dependencies(workspace: str = ".") -> dict[str, Any]:
    """Dependency state per detected ecosystem: package manager, lockfile
    presence/consistency signals, dependency counts, and whether packages
    appear installed locally (e.g. node_modules/, .venv/)."""
    ws = inspect_workspace(workspace)
    if not ws.exists:
        return _result(Status.ERROR, f"Workspace '{workspace}' does not exist.")
    path = _resolve(workspace)
    adapters = run_adapters(path)
    deps = [a.dependencies.to_dict() for a in adapters if a.dependencies]
    status = Status.OK if deps else Status.UNKNOWN
    return _result(
        status,
        f"{len(deps)} dependency manifest(s) found." if deps else "No dependency manifests found.",
        data={"dependencies": deps},
    )


@mcp.tool()
def dev_services(workspace: str = ".") -> dict[str, Any]:
    """Local service detection: which services (Postgres, Redis, and
    compose-defined services) this project appears to need, whether each is
    currently running/listening, and the evidence behind that conclusion."""
    ws = inspect_workspace(workspace)
    if not ws.exists:
        return _result(Status.ERROR, f"Workspace '{workspace}' does not exist.")
    path = _resolve(workspace)
    adapters = run_adapters(path)
    dep_names: set[str] = set()
    for a in adapters:
        if a.dependencies:
            dep_names.update(a.dependencies.notes)
    services = detect_services(path, dep_names)
    docker_info = inspect_docker(path)
    down = [s for s in services if s.required and not s.running]
    status = Status.WARNING if down else Status.OK
    return _result(
        status,
        f"{len(services)} service(s) detected, {len(down)} required-but-stopped.",
        data={"services": [s.to_dict() for s in services], "docker": docker_info.to_dict()},
        recommendations=[f"Start {s.name} (expected on port {s.port})." for s in down],
    )


@mcp.tool()
def dev_check(workspace: str = ".", run: list[str] | None = None) -> dict[str, Any]:
    """Run recognized project checks (tests/lint) detected from project files,
    e.g. `pytest`, `./gradlew test`, `npm test`, `cargo test`. Only commands
    DevTwin itself recognized are ever executed (never an arbitrary string),
    each with a timeout. Pass `run` to restrict to a subset of the recognized
    commands (call dev_project_info first to see what's available)."""
    ws = inspect_workspace(workspace)
    if not ws.exists:
        return _result(Status.ERROR, f"Workspace '{workspace}' does not exist.")
    path = _resolve(workspace)
    adapters = run_adapters(path)

    recognized: list[str] = []
    for a in adapters:
        recognized.extend(a.test_commands)

    if run:
        to_run = [c for c in run if c in recognized]
        rejected = [c for c in run if c not in recognized]
    else:
        to_run = recognized[:MAX_AUTO_CHECK_COMMANDS]
        rejected = []

    results: list[dict[str, Any]] = []
    for command_str in to_run:
        args = shlex.split(command_str)
        if not args or not is_allowed_executable(args[0]) or is_dangerous(args):
            results.append(
                {
                    "command": command_str,
                    "executed": False,
                    "reason": "not in DevTwin's allowlist of recognized check commands",
                }
            )
            continue
        outcome: CommandResult = run_command(args, cwd=str(path), timeout=CHECK_TIMEOUT_SECONDS)
        results.append(
            {
                "command": command_str,
                "executed": True,
                "result": outcome.to_dict(),
                "passed": outcome.available and outcome.returncode == 0,
            }
        )

    failed = [r for r in results if r.get("executed") and not r.get("passed")]
    status = Status.ERROR if failed else (Status.OK if results else Status.UNKNOWN)
    return _result(
        status,
        f"Ran {len(results)} check(s), {len(failed)} failed."
        if results
        else "No recognized check commands were found for this project.",
        data={"recognized_commands": recognized, "results": results, "rejected": rejected},
    )


@mcp.tool()
def dev_prepare(workspace: str = ".") -> dict[str, Any]:
    """Produce a preparation plan for a (likely newly-cloned) repository:
    ordered steps to align runtimes, start required services, install
    dependencies, and run the project's build/test commands. This tool NEVER
    executes anything -- it only plans, and classifies each step's blast
    radius (read_only/safe/requires_approval/dangerous) for the caller."""
    ws = inspect_workspace(workspace)
    if not ws.exists:
        return _result(Status.ERROR, f"Workspace '{workspace}' does not exist.")
    path = _resolve(workspace)
    health = compute_health(workspace)
    drift = compute_drift(workspace)
    adapters = run_adapters(path)
    dep_names: set[str] = set()
    for a in adapters:
        if a.dependencies:
            dep_names.update(a.dependencies.notes)
    services = detect_services(path, dep_names)

    steps: list[dict[str, Any]] = []
    order = 1

    for item in drift.items:
        steps.append(
            {
                "order": order,
                "action": f"Align {item.subject} to {item.expected}",
                "action_class": ActionClass.READ_ONLY.value,
                "detail": f"Environment has {item.actual}; project expects {item.expected} (source: {item.source}).",
                "command": None,
            }
        )
        order += 1

    for svc in services:
        if svc.required and not svc.running:
            steps.append(
                {
                    "order": order,
                    "action": f"Start {svc.name}",
                    "action_class": ActionClass.REQUIRES_APPROVAL.value,
                    "detail": f"Expected on port {svc.port}. Evidence: {'; '.join(svc.source)}",
                    "command": "docker compose up -d"
                    if (path / "compose.yaml").exists() or (path / "docker-compose.yml").exists()
                    else None,
                }
            )
            order += 1

    for a in adapters:
        if a.dependencies and a.dependencies.installed.value in ("not_installed", "unknown"):
            install_cmd = {
                "python": "uv sync"
                if a.dependencies.manager == "uv"
                else "pip install -r requirements.txt",
                "node": {
                    "npm": "npm install",
                    "pnpm": "pnpm install",
                    "yarn": "yarn install",
                    "bun": "bun install",
                }.get(a.dependencies.manager or "npm", "npm install"),
            }.get(a.ecosystem)
            if install_cmd:
                steps.append(
                    {
                        "order": order,
                        "action": f"Install {a.ecosystem} dependencies",
                        "action_class": ActionClass.REQUIRES_APPROVAL.value,
                        "detail": f"manager={a.dependencies.manager}",
                        "command": install_cmd,
                    }
                )
                order += 1

    for a in adapters:
        for cmd in a.test_commands:
            steps.append(
                {
                    "order": order,
                    "action": f"Run {a.ecosystem} checks",
                    "action_class": ActionClass.SAFE.value,
                    "detail": "Recognized check command; run it yourself or via dev_check.",
                    "command": cmd,
                }
            )
            order += 1

    return _result(
        Status.OK if steps else Status.UNKNOWN,
        f"{len(steps)}-step preparation plan generated. No changes have been made.",
        data={"plan": steps, "health_score": health.health_score},
        recommendations=[
            "Review each step's action_class before executing anything requires_approval."
        ],
    )


@mcp.tool()
def dev_precommit(workspace: str = ".") -> dict[str, Any]:
    """Read-only commit-readiness summary: Git status (dirty/staged/conflicts),
    project health, and staged files that look like secrets. Never commits,
    stages, or modifies anything."""
    ws = inspect_workspace(workspace)
    if not ws.exists:
        return _result(Status.ERROR, f"Workspace '{workspace}' does not exist.")
    path = _resolve(workspace)
    git = inspect_git(path)
    health = compute_health(workspace)

    issues: list[dict[str, Any]] = []
    if not git.is_repo:
        return _result(Status.UNKNOWN, "Not a Git repository.", data={"git": git.to_dict()})

    if git.has_conflicts:
        issues.append(
            {
                "severity": "high",
                "code": "git.merge_conflicts",
                "title": "Unresolved merge conflicts present",
                "message": "Resolve conflicts before committing.",
            }
        )

    suspect_staged = [
        f for f in git.staged_files if any(pat in f.lower() for pat in SECRET_FILE_PATTERNS)
    ]
    if suspect_staged:
        issues.append(
            {
                "severity": "critical",
                "code": "git.possible_secret_staged",
                "title": "Staged file(s) look like they may contain secrets",
                "message": "These filenames match common secret-file patterns.",
                "evidence": suspect_staged,
                "recommendation": "Unstage and review before committing; add to .gitignore if appropriate.",
            }
        )

    if health.status != Status.OK:
        issues.append(
            {
                "severity": "medium",
                "code": "health.not_ok",
                "title": "Project health is not fully healthy",
                "message": f"health_score={health.health_score} ({health.status.value})",
            }
        )

    ready = git.is_repo and not git.has_conflicts and not suspect_staged
    status = Status.OK if ready else Status.WARNING
    return _result(
        status,
        "Looks ready to commit." if ready else "Some items need attention before committing.",
        data={
            "git": git.to_dict(),
            "health_score": health.health_score,
            "staged_count": len(git.staged_files),
            "unstaged_count": len(git.unstaged_files),
            "untracked_count": len(git.untracked_files),
        },
        issues=issues,
    )


def main() -> None:
    mcp.run()

"""DevTwin MCP server: exposes development-environment intelligence tools.

Built on the official MCP Python SDK's high-level `MCPServer`. Every tool returns a
JSON-serializable dict shaped like::

    {"status": "ok|warning|error|unknown", "summary": "...",
     "data": {...}, "issues": [...], "recommendations": [...]}

No tool here executes an arbitrary, model-supplied shell string. Commands
that run at all (``dev_check``, ``dev_build``, ``dev_build_all``) are drawn
from a recognized, allowlisted set discovered by ecosystem adapters, run with
``shell=False`` and a timeout.
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any, NamedTuple

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
# Total builds a single dev_build_all call may run. Each build gets
# BUILD_TIMEOUT_SECONDS, so an uncapped monorepo scan can outlive any MCP
# client timeout; commands past the cap are reported as skipped, never dropped.
MAX_AUTO_BUILD_COMMANDS = 5
CHECK_TIMEOUT_SECONDS = 120
BUILD_TIMEOUT_SECONDS = 300

COMMON_MONOREPO_DIRS = ["android", "ios", "frontend", "backend", "app", "web", "mobile"]
# Label for the workspace root itself in dev_build_all's per-directory results.
ROOT_DIR_LABEL = "."


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


def _run_recognized_commands(
    path: Path, commands: list[str], timeout: int, run: list[str] | None = None
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """Run recognized commands, respecting allowlist. Returns (results, recognized, rejected)."""
    recognized: list[str] = commands
    if run:
        to_run = [c for c in run if c in recognized]
        rejected = [c for c in run if c not in recognized]
    else:
        to_run = recognized
        rejected = []

    results: list[dict[str, Any]] = []
    for command_str in to_run:
        try:
            args = shlex.split(command_str)
        except ValueError:
            # An adapter emitted an unparseable command string (unbalanced
            # quote). That is a refusal, not a crash out of the tool.
            results.append(
                {
                    "command": command_str,
                    "executed": False,
                    "reason": UNPARSEABLE_REASON,
                }
            )
            continue
        if not args or not is_allowed_executable(args[0]) or is_dangerous(args):
            results.append(
                {
                    "command": command_str,
                    "executed": False,
                    "reason": "not in DevTwin's allowlist of recognized commands",
                }
            )
            continue
        outcome: CommandResult = run_command(args, cwd=str(path), timeout=timeout)
        results.append(
            {
                "command": command_str,
                "executed": True,
                "result": outcome.to_dict(),
                "passed": outcome.available and outcome.returncode == 0,
            }
        )

    return results, recognized, rejected


class Outcomes(NamedTuple):
    """Command results split by what actually happened to each command."""

    passed: list[dict[str, Any]]
    failed: list[dict[str, Any]]
    refused: list[dict[str, Any]]
    unavailable: list[dict[str, Any]]
    timed_out: list[dict[str, Any]]

    @property
    def executed(self) -> int:
        """Commands that actually ran, whatever the result."""
        return len(self.passed) + len(self.failed) + len(self.timed_out)


def _partition_results(results: list[dict[str, Any]]) -> Outcomes:
    """Split command results by outcome.

    Only a command that ran to completion and returned non-zero is a failure.
    Three other things are not: a command refused by the allowlist never ran; a
    command whose executable is not installed never ran either (reporting a
    missing `npm` as a failed build invents a compilation error that does not
    exist); and a command killed at the timeout did run but never reached a
    verdict, so calling it a failure is indistinguishable from a real compile
    error the user must go fix.
    """
    passed: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    unavailable: list[dict[str, Any]] = []
    timed_out: list[dict[str, Any]] = []

    for r in results:
        if not r.get("executed"):
            refused.append(r)
            continue
        outcome = r.get("result") or {}
        if not outcome.get("available", True):
            unavailable.append(r)
        elif outcome.get("timed_out"):
            timed_out.append(r)
        elif r.get("passed"):
            passed.append(r)
        else:
            failed.append(r)

    return Outcomes(passed, failed, refused, unavailable, timed_out)


def _execution_status(
    results: list[dict[str, Any]],
    rejected: list[str] | None = None,
    skipped: list[str] | None = None,
) -> Status:
    """Status for a set of command results, never reporting a run that did not
    happen as OK.

    `rejected` are names the caller asked for that DevTwin does not recognize,
    and `skipped` are recognized commands dropped for the per-call cap. Both
    mean "you asked for something that did not run", so neither can leave the
    result looking clean.
    """
    o = _partition_results(results)
    if o.failed:
        return Status.ERROR
    if o.refused or o.unavailable or o.timed_out or rejected or skipped:
        # Nothing that ran failed, but something we were asked to run never did.
        return Status.WARNING
    return Status.OK if results else Status.UNKNOWN


def _execution_summary(
    kind: str,
    results: list[dict[str, Any]],
    recognized: list[str],
    rejected: list[str],
    skipped: list[str],
) -> str:
    """One sentence covering every outcome, including the ones that did not run.

    Each clause is emitted only when it is non-zero, so a clean run reads
    "Ran 2 build(s), 0 failed." and nothing more.
    """
    o = _partition_results(results)

    if not results:
        if rejected:
            return (
                f"None of the requested command(s) are recognized {kind} commands "
                f"for this project; {len(recognized)} recognized command(s) available."
            )
        return f"No recognized {kind} commands were found for this project."

    summary = f"Ran {o.executed} {kind}(s), {len(o.failed)} failed"
    if o.timed_out:
        summary += f", {len(o.timed_out)} timed out"
    if o.refused:
        summary += f", {len(o.refused)} refused (not in DevTwin's allowlist)"
    if o.unavailable:
        summary += f", {len(o.unavailable)} skipped (tool not installed)"
    if skipped:
        summary += f", {len(skipped)} not attempted (per-call cap)"
    if rejected:
        summary += f", {len(rejected)} unrecognized"
    return summary + "."


UNPARSEABLE_REASON = "command string could not be parsed into arguments"


def _refusal_issues(
    directory: str, refused: list[dict[str, Any]], kind: str = "build"
) -> list[dict[str, Any]]:
    """Split refusals by cause.

    A command the allowlist rejected and a command DevTwin could not parse need
    different fixes -- telling someone to get an unbalanced quote allowlisted
    sends them after the wrong thing.
    """
    unparseable = [r for r in refused if r.get("reason") == UNPARSEABLE_REASON]
    not_allowed = [r for r in refused if r.get("reason") != UNPARSEABLE_REASON]

    issues: list[dict[str, Any]] = []
    if not_allowed:
        issues.append(_refused_issue(directory, not_allowed, kind=kind))
    if unparseable:
        issues.append(
            {
                "severity": "medium",
                "code": f"{kind}.commands_unparseable",
                "title": f"{kind.capitalize()} command(s) in '{directory}' could not be parsed",
                "message": (
                    "DevTwin could not split these into arguments, usually an "
                    "unbalanced quote in the command the adapter produced."
                ),
                "evidence": [str(r.get("command")) for r in unparseable],
                "recommendation": "Report this; the command DevTwin derived is malformed.",
            }
        )
    return issues


def _refused_issue(
    directory: str, refused: list[dict[str, Any]], kind: str = "build"
) -> dict[str, Any]:
    """`kind` is "build" or "check" -- dev_check reuses this for test commands."""
    return {
        "severity": "medium",
        "code": f"{kind}.commands_refused",
        "title": f"{kind.capitalize()} command(s) in '{directory}' were not executed",
        "message": f"These commands are not in DevTwin's allowlist, so the {kind} did not run.",
        "evidence": [str(r.get("command")) for r in refused],
        "recommendation": "Run them yourself; DevTwin cannot report a pass or a failure for them.",
    }


def _timed_out_issue(
    directory: str, timed_out: list[dict[str, Any]], timeout: int, kind: str = "build"
) -> dict[str, Any]:
    """A timed-out command reached no verdict. Say so, and say what to do next."""
    return {
        "severity": "medium",
        "code": f"{kind}.commands_timed_out",
        "title": f"{kind.capitalize()} command(s) in '{directory}' were stopped at the timeout",
        "message": (
            f"These commands were still running after {timeout}s and were stopped. "
            "That is not a failure -- DevTwin has no result for them either way."
        ),
        "evidence": [str(r.get("command")) for r in timed_out],
        "recommendation": (
            "Run them yourself, or raise the timeout if this project legitimately "
            "builds for longer."
        ),
    }


def _unavailable_issue(directory: str, unavailable: list[dict[str, Any]]) -> dict[str, Any]:
    """The build tool is not installed. That is not a build failure, but it does
    need saying -- otherwise the directory is a bare WARNING with nothing in it."""
    return {
        "severity": "medium",
        "code": "build.tool_not_installed",
        "title": f"Build tool(s) for '{directory}' are not installed",
        "message": "These commands could not start because their executable is not on PATH.",
        "evidence": [str(r.get("command")) for r in unavailable],
        "recommendation": "Install the toolchain, or run dev_drift to see what this project expects.",
    }


def _scan_build_targets(root: Path) -> list[tuple[str, Path, list[str]]]:
    """Directories dev_build_all should build: the workspace root itself (labelled
    ROOT_DIR_LABEL) plus any recognized COMMON_MONOREPO_DIRS subdirectory. Resolved
    paths are de-duplicated so a root-level ecosystem is never counted twice."""
    candidates = [(ROOT_DIR_LABEL, root)] + [(name, root / name) for name in COMMON_MONOREPO_DIRS]
    targets: list[tuple[str, Path, list[str]]] = []
    seen: set[Path] = set()
    for label, path in candidates:
        if not path.is_dir():
            continue
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        profile = detect_project(str(resolved))
        if profile.ecosystems:
            targets.append((label, resolved, profile.ecosystems))
    return targets


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

    # The cap is a wall-clock bound, so an explicit `run` is subject to it too:
    # otherwise a caller that wants everything simply names everything.
    selected = [c for c in run if c in recognized] if run else recognized
    to_run_full = selected[:MAX_AUTO_CHECK_COMMANDS]
    # Commands dropped by the cap were recognized but never attempted; saying so
    # is the difference between "your checks pass" and "5 of your 8 checks pass".
    skipped = [c for c in selected if c not in to_run_full]
    results, _, rejected = _run_recognized_commands(
        path, to_run_full, CHECK_TIMEOUT_SECONDS, run=run
    )

    o = _partition_results(results)
    status = _execution_status(results, rejected=rejected, skipped=skipped)
    return _result(
        status,
        _execution_summary("check", results, recognized, rejected, skipped),
        data={
            "recognized_commands": recognized,
            "results": results,
            "rejected": rejected,
            "skipped_commands": skipped,
            "max_check_commands": MAX_AUTO_CHECK_COMMANDS,
            "executed_count": o.executed,
            "passed_count": len(o.passed),
            "failed_count": len(o.failed),
            "refused_count": len(o.refused),
            "refused_commands": [str(r.get("command")) for r in o.refused],
            "unavailable_count": len(o.unavailable),
            "timed_out_count": len(o.timed_out),
        },
        issues=(
            _refusal_issues(str(path), o.refused, kind="check")
            + (
                [_timed_out_issue(str(path), o.timed_out, CHECK_TIMEOUT_SECONDS, kind="check")]
                if o.timed_out
                else []
            )
        ),
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


@mcp.tool()
def dev_build(workspace: str = ".", run: list[str] | None = None) -> dict[str, Any]:
    """Run recognized project build/compile commands detected from project files,
    e.g. `npm run build`, `./gradlew build`, `xcodebuild build`, `dotnet build`.
    Only commands DevTwin itself recognized are ever executed (never an arbitrary string),
    each with a timeout. Pass `run` to restrict to a subset of the recognized
    commands (call dev_project_info first to see what's available)."""
    ws = inspect_workspace(workspace)
    if not ws.exists:
        return _result(Status.ERROR, f"Workspace '{workspace}' does not exist.")
    path = _resolve(workspace)
    adapters = run_adapters(path)

    recognized: list[str] = []
    for a in adapters:
        recognized.extend(a.build_commands)

    # Same per-call ceiling dev_check and dev_build_all enforce: at 300s each,
    # an uncapped list can hold a single tool call open for twenty minutes.
    selected = [c for c in run if c in recognized] if run else recognized
    to_run_full = selected[:MAX_AUTO_BUILD_COMMANDS]
    skipped = [c for c in selected if c not in to_run_full]
    results, _, rejected = _run_recognized_commands(
        path, to_run_full, BUILD_TIMEOUT_SECONDS, run=run
    )

    o = _partition_results(results)
    status = _execution_status(results, rejected=rejected, skipped=skipped)
    return _result(
        status,
        _execution_summary("build", results, recognized, rejected, skipped),
        data={
            "recognized_commands": recognized,
            "results": results,
            "rejected": rejected,
            "skipped_commands": skipped,
            "max_build_commands": MAX_AUTO_BUILD_COMMANDS,
            "executed_count": o.executed,
            "passed_count": len(o.passed),
            "failed_count": len(o.failed),
            "refused_count": len(o.refused),
            "refused_commands": [str(r.get("command")) for r in o.refused],
            "unavailable_count": len(o.unavailable),
            "timed_out_count": len(o.timed_out),
        },
        issues=(
            _refusal_issues(str(path), o.refused)
            + (
                [_timed_out_issue(str(path), o.timed_out, BUILD_TIMEOUT_SECONDS)]
                if o.timed_out
                else []
            )
        ),
    )


@mcp.tool()
def dev_build_all(workspace: str = ".") -> dict[str, Any]:
    """Scan subdirectories for ecosystems and run comprehensive build checks on all of them.
    Returns detailed per-ecosystem build results including: pass/fail status, build output,
    and any compilation errors. Perfect for monorepos to verify backend changes don't break
    Android, iOS, and frontend builds."""
    root = _resolve(workspace)
    if not root.exists():
        return _result(Status.ERROR, f"Workspace '{workspace}' does not exist.")

    ecosystems_to_check = _scan_build_targets(root)

    if not ecosystems_to_check:
        return _result(
            Status.UNKNOWN,
            "No recognized ecosystems found in the workspace root or its subdirectories.",
            data={"ecosystems": []},
        )

    results: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    summary_parts: list[str] = []
    skipped_commands: list[str] = []
    budget = MAX_AUTO_BUILD_COMMANDS

    for dir_name, dir_path, ecosystems in ecosystems_to_check:
        adapters = run_adapters(dir_path)
        build_commands: list[str] = []
        for a in adapters:
            build_commands.extend(a.build_commands)
        # Spend the shared command budget in scan order; anything past it is
        # reported as skipped rather than silently dropped.
        to_run = build_commands[:budget]
        skipped = build_commands[len(to_run) :]
        skipped_commands.extend(skipped)

        build_results, _, _ = _run_recognized_commands(dir_path, to_run, BUILD_TIMEOUT_SECONDS)
        ob = _partition_results(build_results)
        # The budget exists to bound wall-clock time, so only builds that
        # actually ran spend it. Charging for a command the allowlist refused
        # would exhaust the budget on zero work and report the real builds
        # further down the scan as "skipped".
        budget -= ob.executed

        # Finding: the per-directory status omitted `skipped`, so a directory
        # whose first build ran clean while later ones were dropped by the
        # shared budget reported "ok" despite its own skipped list.
        build_status = _execution_status(build_results, skipped=skipped)
        if ob.refused:
            issues.append(_refused_issue(dir_name, ob.refused))
        if ob.timed_out:
            issues.append(_timed_out_issue(dir_name, ob.timed_out, BUILD_TIMEOUT_SECONDS))
        if ob.unavailable:
            issues.append(_unavailable_issue(dir_name, ob.unavailable))
        results.append(
            {
                "directory": dir_name,
                "ecosystems": ecosystems,
                "status": build_status.value,
                "build_commands": build_commands,
                "build_results": build_results,
                "executed_count": ob.executed,
                "passed_count": len(ob.passed),
                "failed_count": len(ob.failed),
                "refused_count": len(ob.refused),
                "timed_out_count": len(ob.timed_out),
                "unavailable_count": len(ob.unavailable),
                "skipped_commands": skipped,
            }
        )

        part = f"{dir_name} ({len(ob.passed)}/{ob.executed} passed"
        if ob.failed:
            part += f", {len(ob.failed)} failed"
        if ob.timed_out:
            part += f", {len(ob.timed_out)} timed out"
        if ob.unavailable:
            part += f", {len(ob.unavailable)} tool missing"
        if ob.refused:
            part += f", {len(ob.refused)} refused"
        if skipped:
            part += f", {len(skipped)} skipped"
        summary_parts.append(part + ")")

    # Aggregate status: ERROR if any directory failed, WARNING if any command was
    # refused or skipped, OK only if something actually built, else UNKNOWN.
    statuses = {r["status"] for r in results}
    if Status.ERROR.value in statuses:
        status = Status.ERROR
    elif Status.WARNING.value in statuses or skipped_commands:
        status = Status.WARNING
    elif Status.OK.value in statuses:
        status = Status.OK
    else:
        status = Status.UNKNOWN

    summary = f"Built {len(results)} ecosystem(s): " + ", ".join(summary_parts)
    if skipped_commands:
        summary += (
            f". {len(skipped_commands)} command(s) skipped: "
            f"at most {MAX_AUTO_BUILD_COMMANDS} builds run per call."
        )

    return _result(
        status,
        summary,
        data={
            "ecosystems": results,
            "max_build_commands": MAX_AUTO_BUILD_COMMANDS,
            "skipped_commands": skipped_commands,
        },
        issues=issues,
        recommendations=[
            f"{len(skipped_commands)} build command(s) were not run because of the "
            f"{MAX_AUTO_BUILD_COMMANDS}-build cap; build those directories individually "
            "with dev_build."
        ]
        if skipped_commands
        else [],
    )


@mcp.tool()
def dev_health_all(workspace: str = ".") -> dict[str, Any]:
    """Scan subdirectories for ecosystems and run comprehensive health checks on all of them.
    Returns detailed per-ecosystem reports including: health score, runtime versions, dependency state,
    required services, issues, and recommendations. Perfect for monorepos with multiple tech stacks."""
    root = _resolve(workspace)
    if not root.exists():
        return _result(Status.ERROR, f"Workspace '{workspace}' does not exist.")

    ecosystems_to_check = []

    for subdir in COMMON_MONOREPO_DIRS:
        path = root / subdir
        if path.is_dir():
            profile = detect_project(str(path))
            if profile.ecosystems:
                ecosystems_to_check.append((subdir, path, profile.ecosystems))

    if not ecosystems_to_check:
        return _result(Status.UNKNOWN, "No recognized ecosystems found in subdirectories.", data={"ecosystems": []})

    results = []
    for dir_name, dir_path, ecosystems in ecosystems_to_check:
        report = compute_health(str(dir_path))
        results.append({
            "directory": dir_name,
            "ecosystems": ecosystems,
            "health_score": report.health_score,
            "status": report.status.value,
            "project_summary": report.project_summary,
            "runtime_summary": report.runtime_summary,
            "dependency_summary": report.dependency_summary,
            "service_summary": report.service_summary,
            "issues": [i.to_dict() for i in report.issues],
            "issue_count": len(report.issues),
            "recommendations": report.recommendations,
            "recommendation_count": len(report.recommendations),
        })

    # Aggregate status: ERROR if any subdirectory has ERROR, WARNING if any has WARNING, else OK
    if any(r["status"] == "error" for r in results):
        status = Status.ERROR
    elif any(r["status"] == "warning" for r in results):
        status = Status.WARNING
    else:
        status = Status.OK
    summary = f"Checked {len(results)} ecosystem(s): " + ", ".join(
        f"{r['directory']} ({r['health_score']}/100)" for r in results
    )

    all_issues: list[dict[str, Any]] = []
    all_recommendations: list[str] = []
    for r in results:
        issues = r.get("issues")
        if isinstance(issues, list):
            all_issues.extend(issues)
        recommendations = r.get("recommendations")
        if isinstance(recommendations, list):
            all_recommendations.extend(recommendations)

    return _result(
        status,
        summary,
        data={"ecosystems": results},
        issues=all_issues,
        recommendations=all_recommendations,
    )


def main() -> None:
    mcp.run()

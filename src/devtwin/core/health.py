"""Health scoring engine: combines detection, runtime, dependency, service,
and Git signals into one transparent score with concrete issues.

Scoring is intentionally simple and documented so it's testable and so no
single optional/missing tool can tank the whole score by itself: each issue
subtracts a fixed amount based on severity, floored at 0.
"""

from __future__ import annotations

from pathlib import Path

from devtwin.adapters import ADAPTERS, GENERIC_ADAPTER
from devtwin.adapters.base import version_mismatch
from devtwin.core.detector import detect_project
from devtwin.core.models import (
    AdapterResult,
    HealthIssue,
    HealthReport,
    Severity,
    Status,
)
from devtwin.core.workspace import inspect_workspace
from devtwin.services import detect_services

SEVERITY_PENALTY = {
    Severity.INFO: 0,
    Severity.LOW: 3,
    Severity.MEDIUM: 8,
    Severity.HIGH: 15,
    Severity.CRITICAL: 25,
}


def _dependency_names(adapter_results: list[AdapterResult]) -> set[str]:
    names: set[str] = set()
    for result in adapter_results:
        for note in result.dependencies.notes if result.dependencies else []:
            names.add(note)
    return names


def run_adapters(root: Path) -> list[AdapterResult]:
    results = [a.run(root) for a in ADAPTERS]
    applicable = [r for r in results if r.applicable]
    if not applicable:
        generic_result = GENERIC_ADAPTER.run(root)
        return [generic_result]
    return applicable


def _score(issues: list[HealthIssue]) -> int:
    score = 100
    for issue in issues:
        score -= SEVERITY_PENALTY.get(issue.severity, 0)
    return max(0, min(100, score))


def _status_for_score(score: int) -> Status:
    if score >= 90:
        return Status.OK
    if score >= 50:
        return Status.WARNING
    return Status.ERROR


def compute_health(root: str) -> HealthReport:
    profile = detect_project(root)
    workspace = inspect_workspace(root)
    path = Path(workspace.root)

    issues: list[HealthIssue] = []
    recommendations: list[str] = []

    if not workspace.exists:
        issues.append(
            HealthIssue(
                severity=Severity.CRITICAL,
                code="workspace.not_found",
                title="Workspace path does not exist",
                message=f"'{root}' could not be found on disk.",
                evidence=[f"path checked: {workspace.root}"],
                recommendation="Verify the workspace path passed to DevTwin.",
            )
        )
        return HealthReport(
            health_score=0,
            status=Status.ERROR,
            project_summary="Workspace not found",
            runtime_summary="unknown",
            service_summary="unknown",
            dependency_summary="unknown",
            issues=issues,
            recommendations=["Point DevTwin at a valid, existing directory."],
        )

    adapter_results = run_adapters(path)

    runtime_lines = []
    for result in adapter_results:
        issues.extend(result.issues)
        for rt in result.runtimes:
            runtime_lines.append(f"{rt.name}={rt.installed_version or rt.presence.value}")
            if (
                rt.required_version
                and rt.installed_version
                and version_mismatch(rt.required_version, rt.installed_version)
            ):
                issues.append(
                    HealthIssue(
                        severity=Severity.MEDIUM,
                        code=f"{result.ecosystem}.runtime_drift",
                        title=f"{rt.name} version differs from project requirement",
                        message=(
                            f"Project requires {rt.name} {rt.required_version} "
                            f"(from {rt.source}), but {rt.installed_version} is installed."
                        ),
                        evidence=[
                            f"required={rt.required_version}",
                            f"installed={rt.installed_version}",
                        ],
                        recommendation=f"Install/switch to {rt.name} {rt.required_version}.",
                    )
                )
        for dep_note in [] if not result.dependencies else result.dependencies.notes:
            if "not found" in dep_note or "may not be installed" in dep_note:
                issues.append(
                    HealthIssue(
                        severity=Severity.LOW,
                        code=f"{result.ecosystem}.dependencies_not_installed",
                        title="Dependencies may not be installed",
                        message=dep_note,
                        evidence=[dep_note],
                        recommendation="Run the ecosystem's install command before building or testing.",
                    )
                )

    dep_names = _dependency_names(adapter_results)
    services = detect_services(path, dep_names)
    for svc in services:
        if svc.required and not svc.running:
            issues.append(
                HealthIssue(
                    severity=Severity.HIGH,
                    code="service.not_running",
                    title=f"{svc.name} appears required but is not running",
                    message=(
                        f"Detected signals suggesting '{svc.name}' is required "
                        f"(confidence={svc.required_confidence}), but port {svc.port} is not listening."
                    ),
                    evidence=svc.source,
                    recommendation=f"Start {svc.name} (e.g. via docker compose or a local install).",
                    confidence=svc.required_confidence,
                )
            )

    if workspace.git and workspace.git.is_repo and workspace.git.has_conflicts:
        issues.append(
            HealthIssue(
                severity=Severity.HIGH,
                code="git.merge_conflicts",
                title="Unresolved merge conflicts",
                message="Git status shows unmerged paths.",
                evidence=[*workspace.git.staged_files, *workspace.git.unstaged_files][:10],
                recommendation="Resolve conflicts before continuing.",
            )
        )

    score = _score(issues)
    status = _status_for_score(score)

    recommendations.extend(sorted({i.recommendation for i in issues if i.recommendation}))

    ecosystems = ", ".join(profile.ecosystems) if profile.ecosystems else "unrecognized"
    project_summary = f"{profile.primary_ecosystem or 'generic'} project (detected: {ecosystems})"
    runtime_summary = ", ".join(runtime_lines) if runtime_lines else "no runtimes inspected"
    service_summary = (
        ", ".join(f"{s.name}={'running' if s.running else 'stopped'}" for s in services)
        if services
        else "no required services detected"
    )
    dep_summary_parts = []
    for result in adapter_results:
        if result.dependencies:
            dep_summary_parts.append(
                f"{result.ecosystem}:{result.dependencies.manager or 'unknown manager'}"
            )
    dependency_summary = (
        ", ".join(dep_summary_parts) if dep_summary_parts else "no dependency manifests found"
    )

    return HealthReport(
        health_score=score,
        status=status,
        project_summary=project_summary,
        runtime_summary=runtime_summary,
        service_summary=service_summary,
        dependency_summary=dependency_summary,
        issues=issues,
        recommendations=recommendations,
    )

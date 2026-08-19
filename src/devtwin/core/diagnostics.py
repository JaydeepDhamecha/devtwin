"""Failure diagnosis: turn an error message + local evidence into ranked,
honestly-hedged root cause candidates.

Every candidate must be backed by concrete evidence (a detected file, a
parsed config value, actual command output, an actual port/process state).
Confidence is never asserted as certainty -- language stays in "likely"/
"possible cause" territory unless evidence is direct and singular.
"""

from __future__ import annotations

import re

from devtwin.core.drift import compute_drift
from devtwin.core.health import compute_health
from devtwin.core.models import DiagnosticReport, RootCauseCandidate
from devtwin.core.workspace import inspect_workspace
from devtwin.system.ports import check_port

PORT_IN_USE_RE = re.compile(r"(?:EADDRINUSE|address already in use).*?:?(\d{2,5})", re.IGNORECASE)
GENERIC_PORT_RE = re.compile(r":(\d{2,5})\b")
CONNECTION_REFUSED_RE = re.compile(
    r"(connection refused|could not connect|ECONNREFUSED)", re.IGNORECASE
)
MODULE_NOT_FOUND_PY_RE = re.compile(r"No module named ['\"]?([\w.]+)")
MODULE_NOT_FOUND_NODE_RE = re.compile(r"Cannot find module ['\"]([^'\"]+)['\"]")
COMMAND_NOT_FOUND_RE = re.compile(
    r"(command not found|is not recognized as an internal|ENOENT)", re.IGNORECASE
)
PERMISSION_DENIED_RE = re.compile(r"permission denied", re.IGNORECASE)


def diagnose_failure(root: str, error_message: str, command: str | None = None) -> DiagnosticReport:
    workspace = inspect_workspace(root)
    candidates: list[RootCauseCandidate] = []

    if not workspace.exists:
        return DiagnosticReport(
            query=error_message,
            candidates=[],
            summary=f"Workspace '{root}' does not exist -- cannot gather evidence.",
        )

    health = compute_health(root)
    drift = compute_drift(root)

    combined_text = f"{command or ''}\n{error_message}"

    port_match = PORT_IN_USE_RE.search(combined_text)
    if port_match:
        port = int(port_match.group(1))
        info = check_port(port)
        if info.listening:
            evidence = [f"port {port} is currently listening"]
            if info.process_name:
                evidence.append(f"owned by process '{info.process_name}' (pid {info.pid})")
            candidates.append(
                RootCauseCandidate(
                    cause=f"Port {port} is already in use by another process.",
                    confidence=0.85,
                    evidence=evidence,
                    recommendation=f"Stop the process on port {port}, or configure the app to use a different port.",
                )
            )

    if CONNECTION_REFUSED_RE.search(combined_text):
        conn_port_match = GENERIC_PORT_RE.search(combined_text)
        target_port = int(conn_port_match.group(1)) if conn_port_match else None
        matched_service = None
        for issue in health.issues:
            if issue.code == "service.not_running" and (
                target_port is None or str(target_port) in issue.message
            ):
                matched_service = issue
                break
        if matched_service:
            candidates.append(
                RootCauseCandidate(
                    cause=matched_service.title,
                    confidence=0.75,
                    evidence=matched_service.evidence,
                    recommendation=matched_service.recommendation,
                )
            )
        else:
            candidates.append(
                RootCauseCandidate(
                    cause="A required network service is unreachable.",
                    confidence=0.4,
                    evidence=["error message indicates a refused/failed connection"],
                    recommendation="Verify the target service is running and listening on the expected port.",
                )
            )

    py_module_match = MODULE_NOT_FOUND_PY_RE.search(error_message)
    if py_module_match:
        candidates.append(
            RootCauseCandidate(
                cause=f"Python dependency '{py_module_match.group(1)}' is not installed in the active environment.",
                confidence=0.7,
                evidence=[f"error message: No module named '{py_module_match.group(1)}'"],
                recommendation="Install project dependencies (e.g. `uv sync`, `pip install -r requirements.txt`) "
                "and confirm the correct virtual environment is active.",
            )
        )

    node_module_match = MODULE_NOT_FOUND_NODE_RE.search(error_message)
    if node_module_match:
        candidates.append(
            RootCauseCandidate(
                cause=f"Node dependency '{node_module_match.group(1)}' is not installed.",
                confidence=0.7,
                evidence=[f"error message: Cannot find module '{node_module_match.group(1)}'"],
                recommendation="Run the project's install command (e.g. `npm install`, `pnpm install`).",
            )
        )

    if COMMAND_NOT_FOUND_RE.search(combined_text) and command:
        exe = command.split()[0] if command.split() else command
        candidates.append(
            RootCauseCandidate(
                cause=f"'{exe}' is not installed or not on PATH.",
                confidence=0.6,
                evidence=[f"command attempted: {command}"],
                recommendation=f"Install '{exe}' or ensure it is on PATH.",
            )
        )

    if PERMISSION_DENIED_RE.search(combined_text):
        candidates.append(
            RootCauseCandidate(
                cause="A permission error is blocking the command (file permissions, or a wrapper script not marked executable).",
                confidence=0.4,
                evidence=["error message contains 'permission denied'"],
                recommendation="Check file/directory permissions; for wrapper scripts (gradlew/mvnw) ensure the executable bit is set.",
            )
        )

    if drift.has_drift:
        for item in drift.items[:3]:
            candidates.append(
                RootCauseCandidate(
                    cause=f"{item.subject} version drift: project expects {item.expected}, environment has {item.actual}.",
                    confidence=0.5,
                    evidence=[f"source: {item.source}"],
                    recommendation=f"Align local {item.subject} with the project's required version ({item.expected}).",
                )
            )

    if not candidates:
        candidates.append(
            RootCauseCandidate(
                cause="No specific root cause could be matched from the error message and available evidence.",
                confidence=0.15,
                evidence=[
                    f"project health score: {health.health_score}",
                    f"runtime summary: {health.runtime_summary}",
                ],
                recommendation="Run `dev_health` and `dev_check` for a broader look, or share the full error output.",
            )
        )

    candidates.sort(key=lambda c: c.confidence, reverse=True)
    strongest = candidates[0]

    summary = (
        f"Likely cause: {strongest.cause}"
        if strongest.confidence >= 0.5
        else (f"Possible cause (low confidence): {strongest.cause}")
    )

    return DiagnosticReport(
        query=error_message,
        candidates=candidates,
        strongest=strongest,
        summary=summary,
    )

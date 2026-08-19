"""Drift engine: expected project state vs. actual local state."""

from __future__ import annotations

from pathlib import Path

from devtwin.adapters.base import version_mismatch
from devtwin.core.health import run_adapters
from devtwin.core.models import DriftItem, DriftReport, Presence, Severity
from devtwin.core.workspace import inspect_workspace


def compute_drift(root: str) -> DriftReport:
    workspace = inspect_workspace(root)
    if not workspace.exists:
        return DriftReport(has_drift=False, summary=f"Workspace '{root}' does not exist.")

    path = Path(workspace.root)
    adapter_results = run_adapters(path)

    items: list[DriftItem] = []

    for result in adapter_results:
        for rt in result.runtimes:
            if not rt.required_version:
                continue
            if rt.presence == Presence.NOT_INSTALLED:
                items.append(
                    DriftItem(
                        subject=rt.name,
                        expected=rt.required_version,
                        actual="not installed",
                        source=rt.source or "detected requirement",
                        severity=Severity.CRITICAL,
                    )
                )
                continue
            if not rt.installed_version:
                continue
            if version_mismatch(rt.required_version, rt.installed_version):
                items.append(
                    DriftItem(
                        subject=rt.name,
                        expected=rt.required_version,
                        actual=rt.installed_version,
                        source=rt.source or "detected requirement",
                        severity=Severity.MEDIUM,
                    )
                )

        for tool in result.build_tools:
            if (
                tool.required_version
                and tool.installed_version
                and version_mismatch(tool.required_version, tool.installed_version)
            ):
                items.append(
                    DriftItem(
                        subject=tool.name,
                        expected=tool.required_version,
                        actual=tool.installed_version,
                        source=tool.source or "detected requirement",
                        severity=Severity.MEDIUM,
                    )
                )

    has_drift = bool(items)
    if has_drift:
        summary = f"{len(items)} drift item(s) found between project requirements and the local environment."
    else:
        summary = "No drift detected between project requirements and the local environment."

    return DriftReport(has_drift=has_drift, items=items, summary=summary)

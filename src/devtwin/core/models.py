"""Typed data model shared across DevTwin's core and adapters.

Every model here is a plain ``dataclass`` and exposes ``.to_dict()`` so tool
results can be handed straight to the MCP SDK as JSON-serializable data.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


def _to_dict(obj: Any) -> Any:
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: _to_dict(v) for k, v in dataclasses.asdict(obj).items()}
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, (list, tuple)):
        return [_to_dict(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _to_dict(v) for k, v in obj.items()}
    return obj


class DictMixin:
    """Adds a JSON-safe ``to_dict()`` to any dataclass."""

    def to_dict(self) -> dict[str, Any]:
        return _to_dict(self)


class Status(str, Enum):
    OK = "ok"
    WARNING = "warning"
    ERROR = "error"
    UNKNOWN = "unknown"


class Severity(str, Enum):
    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ActionClass(str, Enum):
    READ_ONLY = "read_only"
    SAFE = "safe"
    REQUIRES_APPROVAL = "requires_approval"
    DANGEROUS = "dangerous"


class Presence(str, Enum):
    """Existence/availability state for a tool, runtime, or variable.

    Never conflate "not installed" with "unknown" -- see NO_FAKE_SUPPORT.
    """

    DETECTED = "detected"
    NOT_DETECTED = "not_detected"
    INSTALLED = "installed"
    NOT_INSTALLED = "not_installed"
    UNAVAILABLE = "unavailable"
    UNKNOWN = "unknown"


@dataclass
class ToolResult(DictMixin):
    """Uniform envelope returned by every MCP tool."""

    status: Status
    summary: str
    data: dict[str, Any] = field(default_factory=dict)
    issues: list[dict[str, Any]] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)


@dataclass
class CommandResult(DictMixin):
    """Result of a safely-executed subprocess."""

    executable: str
    args: list[str]
    returncode: int | None
    stdout: str
    stderr: str
    timed_out: bool = False
    available: bool = True
    duration_ms: int = 0


@dataclass
class RuntimeInfo(DictMixin):
    name: str
    presence: Presence
    installed_version: str | None = None
    required_version: str | None = None
    path: str | None = None
    source: str | None = None  # where the required version was read from


@dataclass
class DependencyInfo(DictMixin):
    ecosystem: str
    manager: str | None
    lockfile: str | None
    lockfile_present: bool = False
    manifest_present: bool = False
    installed: Presence = Presence.UNKNOWN
    dependency_count: int | None = None
    dev_dependency_count: int | None = None
    notes: list[str] = field(default_factory=list)


@dataclass
class PortInfo(DictMixin):
    port: int
    listening: bool
    protocol: str = "tcp"
    process_name: str | None = None
    pid: int | None = None


@dataclass
class ProcessInfo(DictMixin):
    pid: int
    name: str
    port: int | None = None


@dataclass
class ServiceInfo(DictMixin):
    name: str
    required: bool
    required_confidence: float  # 0..1
    running: bool
    port: int | None = None
    source: list[str] = field(default_factory=list)  # signals that led to this conclusion
    detail: str | None = None


@dataclass
class EnvironmentVariableStatus(DictMixin):
    name: str
    present: bool
    is_secret: bool = False
    value_preview: str | None = None  # only ever set for non-secret vars


@dataclass
class Capability(DictMixin):
    name: str
    action_class: ActionClass
    description: str = ""


@dataclass
class HealthIssue(DictMixin):
    severity: Severity
    code: str
    title: str
    message: str
    evidence: list[str] = field(default_factory=list)
    recommendation: str | None = None
    confidence: float | None = None


@dataclass
class GitState(DictMixin):
    is_repo: bool
    branch: str | None = None
    dirty: bool = False
    staged_files: list[str] = field(default_factory=list)
    unstaged_files: list[str] = field(default_factory=list)
    untracked_files: list[str] = field(default_factory=list)
    has_conflicts: bool = False
    root: str | None = None


@dataclass
class ProjectProfile(DictMixin):
    root: str
    ecosystems: list[str]
    primary_ecosystem: str | None
    indicators: dict[str, list[str]] = field(default_factory=dict)
    confidence: dict[str, float] = field(default_factory=dict)


@dataclass
class WorkspaceState(DictMixin):
    root: str
    exists: bool
    is_directory: bool
    git: GitState | None = None


@dataclass
class AdapterResult(DictMixin):
    ecosystem: str
    applicable: bool
    runtimes: list[RuntimeInfo] = field(default_factory=list)
    dependencies: DependencyInfo | None = None
    build_tools: list[RuntimeInfo] = field(default_factory=list)
    test_commands: list[str] = field(default_factory=list)
    build_commands: list[str] = field(default_factory=list)
    environment: list[EnvironmentVariableStatus] = field(default_factory=list)
    issues: list[HealthIssue] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class HealthReport(DictMixin):
    health_score: int
    status: Status
    project_summary: str
    runtime_summary: str
    service_summary: str
    dependency_summary: str
    issues: list[HealthIssue] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)


@dataclass
class DriftItem(DictMixin):
    subject: str
    expected: str
    actual: str
    source: str
    severity: Severity = Severity.MEDIUM


@dataclass
class DriftReport(DictMixin):
    has_drift: bool
    items: list[DriftItem] = field(default_factory=list)
    summary: str = ""


@dataclass
class RootCauseCandidate(DictMixin):
    cause: str
    confidence: float  # 0..1
    evidence: list[str] = field(default_factory=list)
    recommendation: str | None = None


@dataclass
class DiagnosticReport(DictMixin):
    query: str
    candidates: list[RootCauseCandidate] = field(default_factory=list)
    strongest: RootCauseCandidate | None = None
    summary: str = ""

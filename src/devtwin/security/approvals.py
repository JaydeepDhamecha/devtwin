"""Action classification for anything that isn't a pure read.

Every step DevTwin proposes (in ``dev_prepare`` plans, mainly) carries an
:class:`ActionClass` so a calling agent -- or the human behind it -- can
decide what's safe to auto-run versus what needs a human to say "yes".
DevTwin itself never escalates a plan step into an execution; it only
classifies and describes.
"""

from __future__ import annotations

from devtwin.core.models import ActionClass, Capability

READ_ONLY_TOOLS = {
    "dev_detect",
    "dev_health",
    "dev_drift",
    "dev_explain_failure",
    "dev_project_info",
    "dev_dependencies",
    "dev_services",
    "dev_precommit",
}

# dev_check and dev_prepare execute recognized, allowlisted commands
# (tests/build/lint) -- "safe" in the sense of non-destructive, but not
# purely read-only since they may leave build artifacts behind.
SAFE_EXECUTION_TOOLS = {"dev_check"}

# dev_prepare only plans by default; it never executes without a separate,
# explicit human approval step outside of this MCP server's scope.
PLANNING_TOOLS = {"dev_prepare"}


def classify_tool(tool_name: str) -> ActionClass:
    if tool_name in READ_ONLY_TOOLS:
        return ActionClass.READ_ONLY
    if tool_name in SAFE_EXECUTION_TOOLS:
        return ActionClass.SAFE
    if tool_name in PLANNING_TOOLS:
        return ActionClass.READ_ONLY  # planning itself never mutates
    return ActionClass.REQUIRES_APPROVAL


def capability_table() -> list[Capability]:
    caps = []
    for name in sorted(READ_ONLY_TOOLS):
        caps.append(Capability(name=name, action_class=ActionClass.READ_ONLY))
    for name in sorted(SAFE_EXECUTION_TOOLS):
        caps.append(
            Capability(
                name=name,
                action_class=ActionClass.SAFE,
                description="Runs recognized, allowlisted project commands (tests/build/lint) with a timeout.",
            )
        )
    for name in sorted(PLANNING_TOOLS):
        caps.append(
            Capability(
                name=name,
                action_class=ActionClass.READ_ONLY,
                description="Produces a plan only; never executes or mutates the machine.",
            )
        )
    return caps

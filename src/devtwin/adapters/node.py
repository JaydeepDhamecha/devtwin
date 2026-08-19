"""Node.js ecosystem adapter: node, npm, pnpm, yarn, bun."""

from __future__ import annotations

import json
from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import (
    DependencyInfo,
    EnvironmentVariableStatus,
    HealthIssue,
    Presence,
    RuntimeInfo,
    Severity,
)
from devtwin.core.runner import run_command, which
from devtwin.system.environment import check_env_var

LOCKFILE_MANAGERS = {
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
    "bun.lock": "bun",
    "bun.lockb": "bun",
    "package-lock.json": "npm",
}


def _read_package_json(root: Path) -> dict:
    pkg = root / "package.json"
    if not pkg.exists():
        return {}
    try:
        return json.loads(pkg.read_text(encoding="utf-8", errors="ignore"))
    except (OSError, json.JSONDecodeError):
        return {}


class NodeAdapter(EcosystemAdapter):
    ecosystem = "node"

    def detect(self, root: Path) -> bool:
        indicators = ["package.json", *LOCKFILE_MANAGERS.keys(), ".nvmrc", ".node-version"]
        return any((root / name).exists() for name in indicators)

    def _required_version(self, root: Path) -> tuple[str | None, str | None]:
        for filename in (".nvmrc", ".node-version"):
            f = root / filename
            if f.exists():
                try:
                    content = f.read_text(encoding="utf-8").strip().lstrip("v")
                    if content:
                        return content, filename
                except OSError:
                    pass
        pkg = _read_package_json(root)
        engines = pkg.get("engines", {})
        if isinstance(engines, dict) and engines.get("node"):
            return str(engines["node"]), "package.json engines.node"
        return None, None

    def _detect_manager(self, root: Path) -> tuple[str | None, str | None]:
        pkg = _read_package_json(root)
        package_manager_field = pkg.get("packageManager")
        if isinstance(package_manager_field, str) and "@" in package_manager_field:
            name, version = package_manager_field.split("@", 1)
            return name, version
        for lockfile, manager in LOCKFILE_MANAGERS.items():
            if (root / lockfile).exists():
                return manager, None
        return None, None

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        required, source = self._required_version(root)
        node_path = which("node")
        if node_path is None:
            return [
                RuntimeInfo(
                    name="node",
                    presence=Presence.NOT_INSTALLED,
                    required_version=required,
                    source=source,
                )
            ]
        result = run_command([node_path, "--version"], timeout=5)
        installed = extract_version(result.stdout) if result.available else None
        return [
            RuntimeInfo(
                name="node",
                presence=Presence.INSTALLED if installed else Presence.UNKNOWN,
                installed_version=installed,
                required_version=required,
                path=node_path,
                source=source,
            )
        ]

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        pkg_json_present = (root / "package.json").exists()
        if not pkg_json_present:
            return None

        manager, required_manager_version = self._detect_manager(root)
        lockfile = None
        for name in LOCKFILE_MANAGERS:
            if (root / name).exists():
                lockfile = name
                break

        pkg = _read_package_json(root)
        deps = pkg.get("dependencies", {})
        dev_deps = pkg.get("devDependencies", {})

        notes: list[str] = []
        node_modules_present = (root / "node_modules").exists()
        installed = Presence.INSTALLED if node_modules_present else Presence.NOT_INSTALLED
        if not node_modules_present:
            notes.append("node_modules/ not found -- run install before building/testing")
        if required_manager_version:
            notes.append(f"packageManager pins {manager}@{required_manager_version}")

        return DependencyInfo(
            ecosystem="node",
            manager=manager,
            lockfile=lockfile,
            lockfile_present=lockfile is not None,
            manifest_present=True,
            installed=installed,
            dependency_count=len(deps) if isinstance(deps, dict) else None,
            dev_dependency_count=len(dev_deps) if isinstance(dev_deps, dict) else None,
            notes=notes,
        )

    def inspect_build(self, root: Path) -> list[RuntimeInfo]:
        tools: list[RuntimeInfo] = []
        manager, required_version = self._detect_manager(root)
        candidate_tools: set[str] = {m for m in (manager, "npm") if m is not None}
        for tool in candidate_tools:
            path = which(tool)
            if path is None:
                tools.append(RuntimeInfo(name=tool, presence=Presence.NOT_INSTALLED))
                continue
            result = run_command([tool, "--version"], timeout=5)
            version = extract_version(result.stdout) if result.available else None
            tools.append(
                RuntimeInfo(
                    name=tool,
                    presence=Presence.INSTALLED,
                    installed_version=version,
                    required_version=required_version if tool == manager else None,
                    path=path,
                )
            )
        return tools

    def inspect_tests(self, root: Path) -> list[str]:
        pkg = _read_package_json(root)
        scripts = pkg.get("scripts", {})
        manager, _ = self._detect_manager(root)
        runner = manager or "npm"
        run_prefix = "npm run" if runner == "npm" else f"{runner} run"
        commands = []
        if isinstance(scripts, dict):
            if "test" in scripts:
                commands.append(f"{runner} test" if runner != "npm" else "npm test")
            if "lint" in scripts:
                commands.append(f"{run_prefix} lint")
        return commands

    def inspect_build_commands(self, root: Path) -> list[str]:
        pkg = _read_package_json(root)
        scripts = pkg.get("scripts", {})
        manager, _ = self._detect_manager(root)
        runner = manager or "npm"
        run_prefix = "npm run" if runner == "npm" else f"{runner} run"
        if isinstance(scripts, dict) and "build" in scripts:
            return [f"{run_prefix} build"]
        return []

    def inspect_environment(self, root: Path) -> list[EnvironmentVariableStatus]:
        candidates = ["NODE_ENV", "NODE_OPTIONS"]
        return [check_env_var(name) for name in candidates if check_env_var(name).present]

    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]:
        issues: list[HealthIssue] = []
        for rt in runtimes:
            if rt.name == "node" and rt.presence == Presence.NOT_INSTALLED:
                issues.append(
                    HealthIssue(
                        severity=Severity.CRITICAL,
                        code="node.not_installed",
                        title="Node.js runtime not found",
                        message="No `node` executable was found on PATH.",
                        evidence=["which node -> not found"],
                        recommendation="Install Node.js (e.g. via nvm, fnm, or your OS package manager).",
                    )
                )
        return issues

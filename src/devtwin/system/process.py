"""Process inspection.

Best-effort, stdlib + platform-native tools only (no psutil dependency).
Never exposes full command lines by default -- only pid/name -- to avoid
leaking secrets that are sometimes passed as CLI arguments (e.g.
``--password=...``).
"""

from __future__ import annotations

import platform

from devtwin.core.models import ProcessInfo
from devtwin.core.runner import run_command


def list_processes_matching(name_substring: str) -> list[ProcessInfo]:
    """Find running processes whose name contains ``name_substring``."""
    system = platform.system()
    processes: list[ProcessInfo] = []
    needle = name_substring.lower()

    if system == "Windows":
        result = run_command(
            ["tasklist", "/FO", "CSV", "/NH"],
            timeout=5,
        )
        if not result.available or result.returncode != 0:
            return processes
        for line in result.stdout.splitlines():
            fields = [f.strip('"') for f in line.split('","')]
            if len(fields) < 2:
                continue
            proc_name = fields[0].strip('"')
            if needle not in proc_name.lower():
                continue
            try:
                pid = int(fields[1])
            except ValueError:
                continue
            processes.append(ProcessInfo(pid=pid, name=proc_name))
        return processes

    result = run_command(["ps", "-eo", "pid,comm"], timeout=5)
    if not result.available or result.returncode != 0:
        return processes
    for line in result.stdout.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        pid_str, comm = parts
        if needle not in comm.lower():
            continue
        try:
            pid = int(pid_str)
        except ValueError:
            continue
        processes.append(ProcessInfo(pid=pid, name=comm))
    return processes

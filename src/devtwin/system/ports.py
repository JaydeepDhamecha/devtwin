"""Port inspection.

Listening-state checks use the standard library socket module only (works
identically on macOS/Linux/Windows). Identifying the *owning process* is
best-effort: it shells out to platform-native tools (``lsof``, ``ss``, or
PowerShell's ``Get-NetTCPConnection``) and gracefully returns ``None`` when
those aren't available -- this is metadata, not something the health score
should ever depend on.
"""

from __future__ import annotations

import platform
import socket

from devtwin.core.models import PortInfo
from devtwin.core.runner import run_command, which


def is_port_listening(port: int, host: str = "127.0.0.1", timeout: float = 0.5) -> bool:
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as sock:
                sock.settimeout(timeout)
                result = sock.connect_ex((host, port))
                if result == 0:
                    return True
        except OSError:
            continue
    return False


def _find_owner_macos_linux(port: int) -> tuple[str | None, int | None]:
    if which("lsof"):
        result = run_command(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"], timeout=5)
        if result.available and result.returncode == 0:
            lines = [line for line in result.stdout.splitlines() if line]
            if len(lines) >= 2:
                parts = lines[1].split()
                if len(parts) >= 2:
                    name = parts[0]
                    try:
                        pid = int(parts[1])
                    except ValueError:
                        pid = None
                    return name, pid
    return None, None


def _find_owner_windows(port: int) -> tuple[str | None, int | None]:
    result = run_command(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            f"(Get-NetTCPConnection -LocalPort {port} -State Listen "
            "-ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)",
        ],
        timeout=5,
    )
    if result.available and result.returncode == 0 and result.stdout.strip():
        try:
            pid = int(result.stdout.strip())
        except ValueError:
            return None, None
        name_result = run_command(
            ["powershell", "-NoProfile", "-Command", f"(Get-Process -Id {pid}).ProcessName"],
            timeout=5,
        )
        name = name_result.stdout.strip() if name_result.available else None
        return (name or None), pid
    return None, None


def check_port(port: int, host: str = "127.0.0.1") -> PortInfo:
    listening = is_port_listening(port, host)
    process_name: str | None = None
    pid: int | None = None
    if listening:
        if platform.system() == "Windows":
            process_name, pid = _find_owner_windows(port)
        else:
            process_name, pid = _find_owner_macos_linux(port)
    return PortInfo(port=port, listening=listening, process_name=process_name, pid=pid)


def check_ports(ports: list[int], host: str = "127.0.0.1") -> list[PortInfo]:
    return [check_port(p, host) for p in ports]

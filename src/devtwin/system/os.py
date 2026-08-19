"""Operating system / platform inspection."""

from __future__ import annotations

import platform
from dataclasses import dataclass

from devtwin.core.models import DictMixin


@dataclass
class OSInfo(DictMixin):
    system: str  # "Darwin", "Linux", "Windows"
    release: str
    version: str
    machine: str
    python_version: str
    is_macos: bool
    is_linux: bool
    is_windows: bool


def get_os_info() -> OSInfo:
    system = platform.system()
    return OSInfo(
        system=system,
        release=platform.release(),
        version=platform.version(),
        machine=platform.machine(),
        python_version=platform.python_version(),
        is_macos=system == "Darwin",
        is_linux=system == "Linux",
        is_windows=system == "Windows",
    )

"""Safe subprocess execution.

Every command DevTwin runs goes through :func:`run_command`. It never uses a
shell, always has a timeout, always captures output, and truncates output to
a sane maximum size. Callers pass an explicit argument list -- there is no
path from user-supplied text to a shell string anywhere in this module.
"""

from __future__ import annotations

import shutil
import subprocess
import time

from devtwin.core.models import CommandResult

MAX_OUTPUT_CHARS = 20_000
DEFAULT_TIMEOUT_SECONDS = 10


def which(executable: str) -> str | None:
    """Resolve an executable on PATH without invoking a shell."""
    return shutil.which(executable)


def run_command(
    args: list[str],
    *,
    cwd: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    env: dict[str, str] | None = None,
) -> CommandResult:
    """Run ``args`` (argv-style, never a shell string) and capture the result.

    Returns a structured :class:`CommandResult` in all cases -- including
    "executable not found", "timed out", and "permission denied" -- instead
    of raising, so callers never need to wrap every call in try/except.
    """
    if not args:
        raise ValueError("args must be a non-empty argument list")

    executable = args[0]
    resolved = which(executable)
    if resolved is None:
        return CommandResult(
            executable=executable,
            args=args[1:],
            returncode=None,
            stdout="",
            stderr="",
            available=False,
        )

    start = time.monotonic()
    try:
        proc = subprocess.run(
            args,
            shell=False,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        duration_ms = int((time.monotonic() - start) * 1000)
        return CommandResult(
            executable=executable,
            args=args[1:],
            returncode=proc.returncode,
            stdout=proc.stdout[:MAX_OUTPUT_CHARS],
            stderr=proc.stderr[:MAX_OUTPUT_CHARS],
            duration_ms=duration_ms,
        )
    except subprocess.TimeoutExpired as exc:
        duration_ms = int((time.monotonic() - start) * 1000)
        return CommandResult(
            executable=executable,
            args=args[1:],
            returncode=None,
            stdout=(exc.stdout or b"").decode(errors="replace")[:MAX_OUTPUT_CHARS]
            if isinstance(exc.stdout, bytes)
            else (exc.stdout or "")[:MAX_OUTPUT_CHARS],
            stderr="",
            timed_out=True,
            duration_ms=duration_ms,
        )
    except (OSError, PermissionError) as exc:
        return CommandResult(
            executable=executable,
            args=args[1:],
            returncode=None,
            stdout="",
            stderr=str(exc),
            available=False,
        )

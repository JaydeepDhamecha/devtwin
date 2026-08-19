"""Environment variable presence checks -- never values, for secrets.

DevTwin only ever tells a model *whether* a variable is set and, for
non-secret variables, a capped preview. Secret-named variables never have
their value surfaced, per the privacy-first design principle.
"""

from __future__ import annotations

import os

from devtwin.core.models import EnvironmentVariableStatus
from devtwin.security.secrets import is_secret_name, safe_preview


def check_env_var(name: str) -> EnvironmentVariableStatus:
    value = os.environ.get(name)
    secret = is_secret_name(name)
    return EnvironmentVariableStatus(
        name=name,
        present=value is not None,
        is_secret=secret,
        value_preview=None if secret else safe_preview(name, value),
    )


def check_env_vars(names: list[str]) -> list[EnvironmentVariableStatus]:
    return [check_env_var(n) for n in names]


def load_dotenv_var_names(path: str) -> list[str]:
    """Return variable *names* declared in a .env-style file. Never values."""
    names: list[str] = []
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key = line.split("=", 1)[0].strip()
                if key.startswith("export "):
                    key = key[len("export ") :].strip()
                if key:
                    names.append(key)
    except OSError:
        return []
    return names

"""Secret detection and redaction.

DevTwin must never hand a model secret values. This module classifies
environment variable *names* as likely-secret and produces redacted previews
for the rest. Detection is name-based (context, not just substring) so we
don't flag every variable that happens to contain "KEY" as an obvious false
positive machine -- but we always err toward treating a variable as secret
when unsure, because leaking one secret is worse than over-redacting one.
"""

from __future__ import annotations

import re

_SECRET_NAME_PATTERNS = [
    r"PASSWORD",
    r"PASSWD",
    r"SECRET",
    r"TOKEN",
    r"API[_-]?KEY",
    r"PRIVATE[_-]?KEY",
    r"ACCESS[_-]?KEY",
    r"AUTH",
    r"CREDENTIAL",
    r"CERT(IFICATE)?",
    r"SIGNING[_-]?KEY",
    r"CLIENT[_-]?SECRET",
    r"SESSION[_-]?KEY",
    r"ENCRYPTION[_-]?KEY",
]

_SECRET_NAME_RE = re.compile("|".join(f"(?:{p})" for p in _SECRET_NAME_PATTERNS), re.IGNORECASE)

# Names that merely contain a sensitive-looking substring but conventionally
# hold non-secret data (e.g. flags/paths), so we don't over-flag them.
_ALLOWLIST = {
    "AUTHOR",
    "AUTHORS",
    "PATH",
    "GOPATH",
    "GEM_PATH",
    "NODE_AUTH_TOKEN_URL",
}


def is_secret_name(var_name: str) -> bool:
    """Heuristically decide whether an env var *name* likely holds a secret."""
    upper = var_name.upper()
    if upper in _ALLOWLIST:
        return False
    return bool(_SECRET_NAME_RE.search(upper))


def redact(value: str, *, keep: int = 0) -> str:
    """Return a redaction placeholder, never the real value."""
    if not value:
        return "<empty>"
    if keep <= 0:
        return "<redacted>"
    return value[:keep] + "…<redacted>"


def safe_preview(var_name: str, value: str | None) -> str | None:
    """Return a value preview safe to show a model, or None if absent.

    Secret-named variables never get their value echoed -- only presence.
    """
    if value is None:
        return None
    if is_secret_name(var_name):
        return "<redacted>"
    # Even non-secret values are capped to avoid dumping large blobs.
    return value if len(value) <= 200 else value[:200] + "…"

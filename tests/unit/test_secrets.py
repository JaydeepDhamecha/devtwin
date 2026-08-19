from __future__ import annotations

from devtwin.security.secrets import is_secret_name, redact, safe_preview


def test_secret_names_detected():
    for name in [
        "DATABASE_PASSWORD",
        "API_KEY",
        "STRIPE_SECRET_KEY",
        "AUTH_TOKEN",
        "PRIVATE_KEY",
        "AWS_ACCESS_KEY_ID",
        "GITHUB_CREDENTIAL",
    ]:
        assert is_secret_name(name), name


def test_non_secret_names_not_flagged():
    for name in ["NODE_ENV", "PORT", "DEBUG", "PATH", "AUTHOR"]:
        assert not is_secret_name(name), name


def test_redact_never_returns_value():
    assert redact("super-secret-value") == "<redacted>"
    assert redact("") == "<empty>"
    assert "super-secret-value" not in redact("super-secret-value", keep=4)


def test_safe_preview_hides_secret_values():
    assert safe_preview("API_KEY", "sk-abc123") == "<redacted>"


def test_safe_preview_shows_non_secret_values():
    assert safe_preview("NODE_ENV", "production") == "production"


def test_safe_preview_none_for_absent():
    assert safe_preview("NODE_ENV", None) is None


def test_safe_preview_truncates_long_values():
    long_value = "x" * 500
    preview = safe_preview("SOME_CONFIG", long_value)
    assert preview is not None
    assert len(preview) <= 205

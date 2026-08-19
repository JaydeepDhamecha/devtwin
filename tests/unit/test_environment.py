from __future__ import annotations

from pathlib import Path

from devtwin.system.environment import check_env_var, load_dotenv_var_names


def test_check_env_var_present(monkeypatch):
    monkeypatch.setenv("DEVTWIN_TEST_VAR", "hello")
    status = check_env_var("DEVTWIN_TEST_VAR")
    assert status.present is True
    assert status.value_preview == "hello"


def test_check_env_var_secret_never_previewed(monkeypatch):
    monkeypatch.setenv("DEVTWIN_TEST_PASSWORD", "hunter2")
    status = check_env_var("DEVTWIN_TEST_PASSWORD")
    assert status.present is True
    assert status.is_secret is True
    assert status.value_preview is None


def test_check_env_var_absent():
    status = check_env_var("DEVTWIN_DEFINITELY_NOT_SET_XYZ")
    assert status.present is False


def test_load_dotenv_var_names(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text("FOO=bar\nexport BAR=baz\n# comment\nSECRET_KEY=abc123\n")
    names = load_dotenv_var_names(str(env_file))
    assert names == ["FOO", "BAR", "SECRET_KEY"]


def test_load_dotenv_var_names_never_returns_values(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text("API_KEY=super-secret-value-123\n")
    names = load_dotenv_var_names(str(env_file))
    assert names == ["API_KEY"]
    assert "super-secret-value-123" not in names

from __future__ import annotations

from pathlib import Path

from devtwin.adapters.jvm import JvmAdapter
from devtwin.core.models import Presence


def test_detect_kotlin_gradle(fixtures_root: Path):
    adapter = JvmAdapter()
    assert adapter.detect(fixtures_root / "kotlin" / "gradle-project") is True


def test_detect_java_maven(fixtures_root: Path):
    adapter = JvmAdapter()
    assert adapter.detect(fixtures_root / "java" / "maven-project") is True


def test_has_kotlin_true_for_kotlin_project(fixtures_root: Path):
    adapter = JvmAdapter()
    assert adapter._has_kotlin(fixtures_root / "kotlin" / "gradle-project") is True


def test_has_kotlin_false_for_java_project(fixtures_root: Path):
    adapter = JvmAdapter()
    assert adapter._has_kotlin(fixtures_root / "java" / "maven-project") is False


def test_gradle_wrapper_version_parsed(fixtures_root: Path):
    adapter = JvmAdapter()
    version = adapter._gradle_wrapper_version(fixtures_root / "kotlin" / "gradle-project")
    assert version == "8.7"


def test_inspect_build_uses_wrapper_when_present(fixtures_root: Path):
    adapter = JvmAdapter()
    tools = adapter.inspect_build(fixtures_root / "kotlin" / "gradle-project")
    wrapper_tools = [t for t in tools if t.name == "gradle-wrapper"]
    assert len(wrapper_tools) == 1
    assert wrapper_tools[0].required_version == "8.7"
    assert wrapper_tools[0].presence == Presence.DETECTED


def test_inspect_build_uses_maven_wrapper_absent_falls_back(fixtures_root: Path):
    adapter = JvmAdapter()
    tools = adapter.inspect_build(fixtures_root / "java" / "maven-project")
    names = {t.name for t in tools}
    assert "maven" in names or "maven-wrapper" in names


def test_inspect_tests_gradle(fixtures_root: Path):
    adapter = JvmAdapter()
    commands = adapter.inspect_tests(fixtures_root / "kotlin" / "gradle-project")
    assert "./gradlew test" in commands


def test_inspect_tests_maven(fixtures_root: Path):
    adapter = JvmAdapter()
    commands = adapter.inspect_tests(fixtures_root / "java" / "maven-project")
    assert commands == ["mvn test"]  # no mvnw wrapper in fixture


def test_health_checks_flag_missing_java(monkeypatch, fixtures_root: Path):
    adapter = JvmAdapter()
    monkeypatch.setattr("devtwin.adapters.jvm.which", lambda name: None)
    result = adapter.run(fixtures_root / "java" / "maven-project")
    assert any(issue.code == "jvm.java_not_installed" for issue in result.issues)


def test_is_android_true_for_android_project(fixtures_root: Path):
    adapter = JvmAdapter()
    assert adapter._is_android(fixtures_root / "android" / "android-project") is True


def test_is_android_false_for_plain_kotlin_project(fixtures_root: Path):
    adapter = JvmAdapter()
    assert adapter._is_android(fixtures_root / "kotlin" / "gradle-project") is False


def test_android_sdk_location_unknown_when_nothing_set(monkeypatch, fixtures_root: Path):
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    adapter = JvmAdapter()
    issues = adapter.health_checks(fixtures_root / "android" / "android-project", [])
    assert any(i.code == "android.sdk_location_unknown" for i in issues)


def test_android_sdk_location_known_via_env_var(monkeypatch, fixtures_root: Path):
    monkeypatch.setenv("ANDROID_HOME", "/opt/android-sdk")
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    adapter = JvmAdapter()
    issues = adapter.health_checks(fixtures_root / "android" / "android-project", [])
    assert not any(i.code == "android.sdk_location_unknown" for i in issues)


def test_android_sdk_dir_valid_path_no_issue(monkeypatch, tmp_path: Path):
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    sdk_path = tmp_path / "sdk"
    sdk_path.mkdir()
    (tmp_path / "build.gradle.kts").write_text('id("com.android.application")\n')
    (tmp_path / "local.properties").write_text(f"sdk.dir={sdk_path}\n")
    adapter = JvmAdapter()
    issues = adapter.health_checks(tmp_path, [])
    assert not any(i.code.startswith("android.sdk") for i in issues)


def test_android_sdk_dir_missing_path_flagged(monkeypatch, tmp_path: Path):
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    (tmp_path / "build.gradle.kts").write_text('id("com.android.application")\n')
    (tmp_path / "local.properties").write_text("sdk.dir=/nonexistent/sdk/path\n")
    adapter = JvmAdapter()
    issues = adapter.health_checks(tmp_path, [])
    assert any(i.code == "android.sdk_dir_missing" for i in issues)


def test_inspect_environment_reports_present_android_vars(monkeypatch, fixtures_root: Path):
    monkeypatch.setenv("ANDROID_HOME", "/opt/android-sdk")
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    adapter = JvmAdapter()
    env = adapter.inspect_environment(fixtures_root / "android" / "android-project")
    assert any(v.name == "ANDROID_HOME" and v.present for v in env)
    assert not any(v.name == "ANDROID_SDK_ROOT" for v in env)


def test_inspect_environment_empty_for_non_android(fixtures_root: Path):
    adapter = JvmAdapter()
    assert adapter.inspect_environment(fixtures_root / "kotlin" / "gradle-project") == []

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

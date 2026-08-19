from __future__ import annotations

from pathlib import Path

from devtwin.core.detector import detect_project


def test_detects_python_uv_project(fixtures_root: Path):
    profile = detect_project(fixtures_root / "python" / "uv-project")
    assert "python" in profile.ecosystems
    assert profile.primary_ecosystem == "python"
    assert "pyproject.toml" in profile.indicators["python"]
    assert "uv.lock" in profile.indicators["python"]
    assert profile.confidence["python"] > 0.5


def test_detects_python_poetry_project(fixtures_root: Path):
    profile = detect_project(fixtures_root / "python" / "poetry-project")
    assert "python" in profile.ecosystems
    assert "poetry.lock" in profile.indicators["python"]


def test_detects_node_pnpm_project(fixtures_root: Path):
    profile = detect_project(fixtures_root / "node" / "pnpm-project")
    assert "node" in profile.ecosystems
    assert "package.json" in profile.indicators["node"]
    assert "pnpm-lock.yaml" in profile.indicators["node"]


def test_detects_node_npm_project(fixtures_root: Path):
    profile = detect_project(fixtures_root / "node" / "npm-project")
    assert "node" in profile.ecosystems
    assert "package-lock.json" in profile.indicators["node"]


def test_detects_kotlin_gradle_project(fixtures_root: Path):
    profile = detect_project(fixtures_root / "kotlin" / "gradle-project")
    assert "jvm" in profile.ecosystems
    assert "build.gradle.kts" in profile.indicators["jvm"]
    assert "*.kt" in profile.indicators["jvm"]


def test_detects_java_maven_project(fixtures_root: Path):
    profile = detect_project(fixtures_root / "java" / "maven-project")
    assert "jvm" in profile.ecosystems
    assert "pom.xml" in profile.indicators["jvm"]
    assert "*.java" in profile.indicators["jvm"]


def test_detects_java_gradle_project(fixtures_root: Path):
    profile = detect_project(fixtures_root / "java" / "gradle-project")
    assert "jvm" in profile.ecosystems
    assert "build.gradle" in profile.indicators["jvm"]


def test_detects_go_project(fixtures_root: Path):
    profile = detect_project(fixtures_root / "go" / "go-project")
    assert "go" in profile.ecosystems
    assert profile.primary_ecosystem == "go"


def test_detects_rust_project(fixtures_root: Path):
    profile = detect_project(fixtures_root / "rust" / "rust-project")
    assert "rust" in profile.ecosystems


def test_detects_dotnet_project(fixtures_root: Path):
    profile = detect_project(fixtures_root / "dotnet" / "dotnet-project")
    assert "dotnet" in profile.ecosystems


def test_generic_docker_project_has_no_language_ecosystem(fixtures_root: Path):
    profile = detect_project(fixtures_root / "generic" / "docker-project")
    assert profile.ecosystems == ["generic"]
    assert profile.primary_ecosystem == "generic"


def test_nonexistent_path_has_no_ecosystems(tmp_path: Path):
    profile = detect_project(tmp_path / "does-not-exist")
    assert profile.ecosystems == []
    assert profile.primary_ecosystem is None

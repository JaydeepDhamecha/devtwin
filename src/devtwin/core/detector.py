"""Project/ecosystem detection based on repository files.

Detection is evidence-based: every ecosystem's confidence score is derived
directly from which indicator files are present, and the indicator list is
returned alongside the score so callers (and the model) can see exactly why
a project was classified the way it was. No ecosystem is ever reported as
present without a matching file.
"""

from __future__ import annotations

from pathlib import Path

from devtwin.core.models import ProjectProfile
from devtwin.system.filesystem import exists_any, glob_any

# Each indicator has a weight; confidence is capped at 1.0.
PYTHON_INDICATORS: dict[str, float] = {
    "pyproject.toml": 0.5,
    "requirements.txt": 0.35,
    "uv.lock": 0.4,
    "poetry.lock": 0.4,
    "Pipfile": 0.35,
    "Pipfile.lock": 0.3,
    ".python-version": 0.25,
}

NODE_INDICATORS: dict[str, float] = {
    "package.json": 0.6,
    "package-lock.json": 0.3,
    "pnpm-lock.yaml": 0.3,
    "yarn.lock": 0.3,
    "bun.lock": 0.3,
    "bun.lockb": 0.3,
    ".nvmrc": 0.2,
    ".node-version": 0.2,
}

JVM_INDICATORS: dict[str, float] = {
    "pom.xml": 0.55,
    "build.gradle": 0.55,
    "build.gradle.kts": 0.55,
    "settings.gradle": 0.3,
    "settings.gradle.kts": 0.3,
    "gradlew": 0.25,
    "gradle/wrapper/gradle-wrapper.properties": 0.25,
    "gradle.properties": 0.15,
}

GO_INDICATORS: dict[str, float] = {
    "go.mod": 0.6,
    "go.sum": 0.3,
    "go.work": 0.3,
}

RUST_INDICATORS: dict[str, float] = {
    "Cargo.toml": 0.6,
    "Cargo.lock": 0.3,
    "rust-toolchain.toml": 0.25,
    "rust-toolchain": 0.25,
}

DOTNET_GLOB_INDICATORS: dict[str, float] = {
    "*.csproj": 0.55,
    "*.fsproj": 0.55,
    "*.vbproj": 0.55,
    "*.sln": 0.35,
}
DOTNET_FILE_INDICATORS: dict[str, float] = {
    "global.json": 0.2,
}

GENERIC_INDICATORS: dict[str, float] = {
    "Makefile": 0.3,
    "Taskfile.yml": 0.3,
    "justfile": 0.3,
    "Dockerfile": 0.3,
    "compose.yaml": 0.3,
    "compose.yml": 0.3,
    "docker-compose.yml": 0.3,
    "docker-compose.yaml": 0.3,
    "README.md": 0.1,
    "README": 0.1,
    "scripts": 0.1,
}


def _score(root: Path, indicators: dict[str, float]) -> tuple[float, list[str]]:
    names = list(indicators.keys())
    found = exists_any(root, names)
    score = min(1.0, sum(indicators[name] for name in found))
    return score, found


def _has_kotlin_sources(root: Path) -> bool:
    return bool(glob_any(root, ["**/*.kt"], max_matches=1)) or bool(
        glob_any(root, ["*.kt"], max_matches=1)
    )


def _has_java_sources(root: Path) -> bool:
    return bool(glob_any(root, ["**/*.java"], max_matches=1)) or bool(
        glob_any(root, ["*.java"], max_matches=1)
    )


def detect_project(root: str | Path) -> ProjectProfile:
    path = Path(root).expanduser().resolve()

    indicators: dict[str, list[str]] = {}
    confidence: dict[str, float] = {}

    python_score, python_found = _score(path, PYTHON_INDICATORS)
    node_score, node_found = _score(path, NODE_INDICATORS)
    jvm_score, jvm_found = _score(path, JVM_INDICATORS)
    go_score, go_found = _score(path, GO_INDICATORS)
    rust_score, rust_found = _score(path, RUST_INDICATORS)

    dotnet_glob_found = glob_any(path, list(DOTNET_GLOB_INDICATORS.keys()))
    dotnet_file_found = exists_any(path, list(DOTNET_FILE_INDICATORS.keys()))
    dotnet_score = min(
        1.0,
        (0.55 if dotnet_glob_found else 0.0)
        + sum(DOTNET_FILE_INDICATORS[n] for n in dotnet_file_found),
    )
    dotnet_found = dotnet_glob_found + dotnet_file_found

    generic_score, generic_found = _score(path, GENERIC_INDICATORS)

    if jvm_found and _has_kotlin_sources(path):
        jvm_score = min(1.0, jvm_score + 0.15)
        jvm_found = jvm_found + ["*.kt"]
    if jvm_found and _has_java_sources(path):
        jvm_found = jvm_found + ["*.java"]

    candidates = {
        "python": (python_score, python_found),
        "node": (node_score, node_found),
        "jvm": (jvm_score, jvm_found),
        "go": (go_score, go_found),
        "rust": (rust_score, rust_found),
        "dotnet": (dotnet_score, dotnet_found),
    }

    ecosystems: list[str] = []
    for name, (score, found) in candidates.items():
        if score > 0:
            ecosystems.append(name)
            indicators[name] = found
            confidence[name] = round(score, 2)

    if generic_score > 0:
        indicators["generic"] = generic_found
        confidence["generic"] = round(generic_score, 2)
        if not ecosystems:
            ecosystems.append("generic")

    primary_ecosystem = None
    ranked = sorted(
        ((name, confidence.get(name, 0.0)) for name in ecosystems),
        key=lambda kv: kv[1],
        reverse=True,
    )
    if ranked:
        primary_ecosystem = ranked[0][0]

    return ProjectProfile(
        root=str(path),
        ecosystems=ecosystems,
        primary_ecosystem=primary_ecosystem,
        indicators=indicators,
        confidence=confidence,
    )

# Ecosystem Adapters

An adapter answers, for one language ecosystem: is this project that kind
of project, and if so, what's its runtime/dependency/build/test state?

## The contract

`src/devtwin/adapters/base.py` defines `EcosystemAdapter`:

```python
class EcosystemAdapter(ABC):
    ecosystem: str

    @abstractmethod
    def detect(self, root: Path) -> bool: ...

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]: ...
    def inspect_dependencies(self, root: Path) -> DependencyInfo | None: ...
    def inspect_build(self, root: Path) -> list[RuntimeInfo]: ...
    def inspect_tests(self, root: Path) -> list[str]: ...
    def inspect_build_commands(self, root: Path) -> list[str]: ...
    def inspect_environment(self, root: Path) -> list[EnvironmentVariableStatus]: ...
    def health_checks(self, root: Path, runtimes: list[RuntimeInfo]) -> list[HealthIssue]: ...

    def run(self, root: Path) -> AdapterResult: ...  # implemented in base
```

Only `detect()` is required. Everything else defaults to an empty
result -- implement what makes sense for your ecosystem.

`run()` (already implemented, don't override it) calls each step and
catches exceptions individually, logging a warning and substituting an
empty default. **This is why a missing/broken tool degrades one field
instead of crashing the server**: if `inspect_build` raises because some
CLI printed unexpected output, `inspect_tests` still runs fine.

## Adding a new adapter: template

1. Create `src/devtwin/adapters/ruby.py`:

```python
from __future__ import annotations

from pathlib import Path

from devtwin.adapters.base import EcosystemAdapter, extract_version
from devtwin.core.models import DependencyInfo, Presence, RuntimeInfo
from devtwin.core.runner import run_command, which


class RubyAdapter(EcosystemAdapter):
    ecosystem = "ruby"

    def detect(self, root: Path) -> bool:
        return (root / "Gemfile").exists()

    def inspect_runtime(self, root: Path) -> list[RuntimeInfo]:
        ruby_path = which("ruby")
        if ruby_path is None:
            return [RuntimeInfo(name="ruby", presence=Presence.NOT_INSTALLED)]
        result = run_command([ruby_path, "--version"], timeout=5)
        version = extract_version(result.stdout) if result.available else None
        return [
            RuntimeInfo(
                name="ruby", presence=Presence.INSTALLED, installed_version=version, path=ruby_path
            )
        ]

    def inspect_dependencies(self, root: Path) -> DependencyInfo | None:
        if not (root / "Gemfile").exists():
            return None
        lockfile = root / "Gemfile.lock"
        return DependencyInfo(
            ecosystem="ruby",
            manager="bundler",
            lockfile="Gemfile.lock" if lockfile.exists() else None,
            lockfile_present=lockfile.exists(),
            manifest_present=True,
        )

    def inspect_tests(self, root: Path) -> list[str]:
        return ["bundle exec rspec"] if (root / "spec").exists() else []
```

2. Register it in `src/devtwin/adapters/__init__.py`:

```python
from devtwin.adapters.ruby import RubyAdapter

ADAPTERS.append(RubyAdapter())
```

3. If the ecosystem can run recognized check commands, also add its
   executable(s) to `ALLOWED_EXECUTABLES` in `security/permissions.py` --
   otherwise `dev_check` will refuse to run them.

4. Add fixtures under `tests/fixtures/ruby/` and tests under
   `tests/unit/test_ruby_adapter.py` mirroring the existing adapter tests
   (mock `which`/`run_command` at the module level, e.g.
   `monkeypatch.setattr("devtwin.adapters.ruby.which", ...)`).

## Ecosystems planned but not yet implemented

PHP, Elixir, Swift, Dart, Scala, C/C++ (CMake/Bazel/Buck), Nix. Until a
dedicated adapter exists, `GenericAdapter` (`adapters/generic.py`) still
provides useful signal for these via Makefile/Taskfile/justfile/Dockerfile/
compose detection -- see "Graceful degradation" in the main README.

## Why Java and Kotlin share one adapter

They share a toolchain (JVM, Gradle/Maven, `.class` output) more than they
differ, and most real repositories mix Kotlin and Java source under one
build. `adapters/jvm.py`'s `JvmAdapter` detects Kotlin sources
(`**/*.kt`, `build.gradle.kts`) as an overlay on the shared Java/Gradle/
Maven inspection rather than duplicating the wrapper/version logic in a
separate adapter.

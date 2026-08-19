"""Command allowlisting for anything DevTwin might execute.

DevTwin never exposes a generic "run shell command" tool. Every command it
can run is a known, read-only or explicitly-approved inspection/check
command drawn from this allowlist. This keeps the blast radius of a
compromised or confused model bounded to "read version numbers and run
recognized test/build commands", not "run arbitrary code".
"""

from __future__ import annotations

# Executables DevTwin is allowed to invoke at all. Anything not in this set
# is refused before a subprocess is ever started.
ALLOWED_EXECUTABLES = {
    # version control
    "git",
    # python
    "python",
    "python3",
    "uv",
    "pip",
    "pip3",
    "poetry",
    "pytest",
    "ruff",
    "mypy",
    # node
    "node",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    # jvm
    "java",
    "javac",
    "gradle",
    "mvn",
    "kotlinc",
    "./gradlew",
    "gradlew",
    "gradlew.bat",
    "./mvnw",
    "mvnw",
    "mvnw.cmd",
    # go
    "go",
    # rust
    "cargo",
    "rustc",
    # dotnet
    "dotnet",
    # swift
    "swift",
    "xcodebuild",
    "pod",
    # ruby
    "ruby",
    "bundle",
    "rake",
    # php
    "php",
    "composer",
    "phpunit",
    "vendor/bin/phpunit",
    # docker
    "docker",
    "docker-compose",
}

# Explicit denylist of dangerous subcommands, even for allowlisted
# executables. dev_check / dev_prepare must never be able to trigger these.
DANGEROUS_ARG_PATTERNS = (
    "reset",
    "clean",
    "push",
    "--force",
    "-f",
    "down",
    "rm",
    "kill",
    "delete",
    "prune",
    "uninstall",
    "remove",
)


def is_allowed_executable(executable: str) -> bool:
    base = executable.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return executable in ALLOWED_EXECUTABLES or base in ALLOWED_EXECUTABLES


def is_dangerous(args: list[str]) -> bool:
    """Best-effort check that a command isn't a destructive one in disguise."""
    lowered = [a.lower() for a in args]
    return any(pat in lowered for pat in DANGEROUS_ARG_PATTERNS)

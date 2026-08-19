# Architecture

DevTwin is one MCP server with a layered core and pluggable ecosystem
adapters -- not a family of per-language MCP servers.

```
MCP server (src/devtwin/server.py)
      |
      v
core (src/devtwin/core/)
      |  workspace, detector, health, drift, diagnostics, runner, models
      v
adapters (src/devtwin/adapters/)
      |  base contract + python, node, jvm, go, rust, dotnet, generic
      v
system inspection (src/devtwin/system/)
      |  os, process, ports, environment, filesystem, docker
      v
service detection (src/devtwin/services/)
      |  postgres, redis, generic (compose-derived)
      v
health / drift / diagnostics engines (src/devtwin/core/)
      combine everything above into transparent, evidence-based reports
```

## Layers

**`server.py`** exposes ten MCP tools via the official Python SDK's
`FastMCP`. Every tool returns a uniform, JSON-serializable envelope:
`{status, summary, data, issues, recommendations}`. No tool executes an
arbitrary, model-supplied command -- see `security.md`.

**`core/`** is language-agnostic. `detector.py` scores which ecosystems a
directory looks like based on the files present. `workspace.py` inspects
Git state read-only. `health.py`, `drift.py`, and `diagnostics.py` are the
three reasoning engines: they call into `adapters/` and `services/` and
turn the results into scores, comparisons, and ranked root causes.
`runner.py` is the single choke point for subprocess execution -- every
command DevTwin ever runs goes through `run_command()`, which never uses a
shell, always has a timeout, and always returns a structured result instead
of raising.

**`adapters/`** implement one contract (`EcosystemAdapter` in `base.py`) per
language ecosystem: Python, Node.js, JVM (Java + Kotlin), Go, Rust, .NET,
plus a `GenericAdapter` fallback that never returns "not applicable". Each
adapter's `run()` method calls its own inspection steps and catches
exceptions *per step*, so one broken/missing tool degrades that one field
instead of crashing the adapter or the server. See `adapters.md` for the
full contract and a template for adding a new language.

**`system/`** provides cross-platform primitives: OS/platform info, process
lookup, port-listening checks, environment variable presence (never
values, for secret-named vars), filesystem helpers, and read-only Docker
inspection. These are stdlib-first; platform-native tools (`lsof`,
PowerShell) are used as best-effort fallbacks and degrade to `None`/`[]`
rather than raising.

**`services/`** detects whether local services like PostgreSQL or Redis are
required by a project, using multiple weighted signals (env vars, compose
files, dependency names, README mentions) rather than any single one, and
whether they're actually reachable.

**`security/`** holds secret redaction (`secrets.py`), a command
allowlist (`permissions.py`), and action classification for anything that
might mutate the machine (`approvals.py`). See `security.md`.

## Data flow for `dev_health`

1. `detector.detect_project()` scores ecosystems from files on disk.
2. `health.run_adapters()` runs every `EcosystemAdapter` whose `detect()`
   returns true (or falls back to `GenericAdapter` if none apply).
3. Each adapter's `AdapterResult` carries runtimes (installed vs. required
   version), dependency state, build tools, and any `HealthIssue`s it found.
4. `services.detect_services()` layers in required-service state.
5. `workspace.inspect_git()` layers in Git state (conflicts, dirty tree).
6. All `HealthIssue`s are collected and scored: 100 minus a fixed penalty
   per issue severity, floored at 0. See `health.py` for the exact table --
   it's deliberately simple and unit-tested so no single missing optional
   tool can tank the score.

## Extensibility

Adding a language adapter, a service detector, or a new MCP tool should
never require touching the reasoning engines. `adapters/__init__.py` and
`services/__init__.py` are the two registries; see `adapters.md` for the
adapter template.

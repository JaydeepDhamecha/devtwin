# DevTwin MCP

**Give AI coding agents a live, structured understanding of your local
development environment.**

DevTwin is a Model Context Protocol (MCP) server that answers one central
question for an AI coding agent: *why is this developer's environment
different, broken, or unhealthy?*

It detects project technology, checks installed runtime versions against
what a project actually requires, inspects dependency and lockfile state,
finds required local services (Postgres, Redis, ...) and whether they're
running, checks ports and Git state, and turns all of that into structured,
evidence-based diagnostics -- without ever sending your environment to a
cloud backend, and without ever exposing secret values to the model.

## Why DevTwin exists

AI coding agents are good at reading code but blind to the environment that
code actually runs in. "Why does `npm test` fail on my machine?" usually
has nothing to do with the code and everything to do with a Node version
mismatch, a service that isn't running, or dependencies that were never
installed. DevTwin gives an agent the same signal a senior engineer would
gather by hand -- `node --version`, `git status`, `lsof -i :5432`,
`docker ps` -- as structured tool calls instead of guesswork.

## Example questions this unlocks

- "Check my development environment."
- "Why is my Kotlin project failing to build?"
- "Is my Node version correct for this repo?"
- "Why can't my app connect to Postgres?"
- "Does my environment drift from what this repository expects?"
- "What should I run before I commit?"
- "I just cloned this repo -- what do I need to do to get it running?"

## Architecture

One MCP server, many ecosystem adapters -- not a separate server per
language.

```
MCP server -> core (workspace/detector/health/drift/diagnostics) ->
adapters (python/node/jvm/go/rust/dotnet/generic) ->
system inspection (os/process/ports/env/fs/docker) ->
service detection (postgres/redis/generic)
```

Full details in [`docs/architecture.md`](docs/architecture.md). How to add
a new language adapter: [`docs/adapters.md`](docs/adapters.md).

## Supported ecosystems

| Ecosystem | Detected from | Runtime checked | Package managers |
|---|---|---|---|
| Python | `pyproject.toml`, `requirements.txt`, `uv.lock`, `poetry.lock`, `Pipfile`, `.python-version` | `python`/`python3` | uv, pip, poetry, pipenv |
| Node.js | `package.json`, lockfiles, `.nvmrc`, `.node-version` | `node` | npm, pnpm, yarn, bun |
| JVM (Java + Kotlin) | `pom.xml`, `build.gradle[.kts]`, `.java`/`.kt` sources | `java`, `kotlinc` | Gradle (wrapper-aware), Maven (wrapper-aware) |
| Go | `go.mod`, `go.sum`, `go.work` | `go` | go modules |
| Rust | `Cargo.toml`, `rust-toolchain[.toml]` | `rustc` | cargo |
| .NET | `*.csproj`/`*.fsproj`/`*.vbproj`, `*.sln`, `global.json` | `dotnet` | NuGet |
| Generic (fallback) | `Makefile`, `Taskfile.yml`, `justfile`, `Dockerfile`, compose files | -- | make/task/just/docker |

Any project not matching a specific adapter still gets useful output from
the generic adapter -- DevTwin never returns nothing for an unrecognized
project.

## Installation

```bash
uv pip install devtwin-mcp
# or
pip install devtwin-mcp
```

For local development against a clone of this repo, see
[`docs/development.md`](docs/development.md).

## MCP client configuration

Exact configuration syntax differs by client -- consult your client's docs.
Generically, DevTwin is a stdio MCP server invoked as:

```json
{
  "mcpServers": {
    "devtwin": {
      "command": "devtwin"
    }
  }
}
```

For local development from a clone (without installing the package):

```json
{
  "mcpServers": {
    "devtwin": {
      "command": "uv",
      "args": ["run", "--directory", "/absolute/path/to/devtwin-mcp", "devtwin"]
    }
  }
}
```

Verify tool discovery with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector uv run devtwin
```

## Tool reference

All tools return `{status, summary, data, issues, recommendations}`.
`status` is one of `ok`, `warning`, `error`, `unknown`.

| Tool | Class | Description |
|---|---|---|
| `dev_detect` | read-only | Fast, file-based project/ecosystem detection with evidence. |
| `dev_health` | read-only | Full 0-100 health score combining runtime, dependency, service, and Git state. |
| `dev_drift` | read-only | Compares required vs. actually-installed runtime/tool versions. |
| `dev_explain_failure` | read-only | Diagnoses a given error message into ranked, evidence-backed root causes. |
| `dev_project_info` | read-only | Detailed project inspection: runtimes, build tools, commands, OS, Git. |
| `dev_dependencies` | read-only | Per-ecosystem dependency/lockfile state. |
| `dev_services` | read-only | Required local services (Postgres, Redis, compose services) and their running state. |
| `dev_check` | safe execution | Runs recognized test/lint commands (e.g. `pytest`, `./gradlew test`) with a timeout. |
| `dev_prepare` | plans only | Produces a preparation plan for a freshly-cloned repo; never executes it. |
| `dev_precommit` | read-only | Commit-readiness summary: Git state, health, staged-secret-looking files. |

## Security model

- **No arbitrary command execution.** There is no `execute_shell` tool.
  `dev_check` only runs commands DevTwin itself recognized from project
  files, checked against an allowlist, run with `shell=False` and a
  timeout.
- **No destructive actions, ever.** DevTwin never runs `git reset --hard`,
  `rm -rf`, `kill -9`, `docker compose down`, lockfile deletion, or
  `.env` mutation.
- **`dev_prepare` only plans.** It classifies every proposed step
  (`read_only`/`safe`/`requires_approval`/`dangerous`) and never executes
  anything itself.

Full details: [`docs/security.md`](docs/security.md).

## Privacy model

- Environment variables are checked for **presence only** when their name
  looks secret (`PASSWORD`, `TOKEN`, `SECRET`, `API_KEY`, `PRIVATE_KEY`,
  `ACCESS_KEY`, `AUTH`, `CREDENTIAL`, ...) -- values are never returned.
- `.env` files are scanned for variable *names* only.
- `dev_precommit` flags secret-*looking* staged filenames without reading
  or reporting their contents.

## Local-first architecture

DevTwin has no server component, no account, and no network calls of its
own beyond the local commands it inspects (`git`, `docker`, language
toolchains). Everything it reports comes from files and processes already
on the machine it runs on.

## Development

```bash
uv sync --all-extras
uv run pytest
uv run ruff check .
uv run mypy src
uv run devtwin
```

See [`docs/development.md`](docs/development.md) for the full workflow.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Adding a new language ecosystem
is the most common contribution -- see [`docs/adapters.md`](docs/adapters.md)
for a template.

## Roadmap

- Additional ecosystem adapters: Ruby, PHP, Elixir, Swift, Dart, Scala,
  C/C++ (CMake/Bazel/Buck), Nix (see `docs/adapters.md` for how to add one)
- Additional service detectors (MySQL/MariaDB, MongoDB, Kafka, RabbitMQ)
- Richer drift comparison against CI configuration (e.g. GitHub Actions
  runtime matrices)
- Optional local caching of expensive checks across tool calls within a
  session

## License

Apache-2.0 -- see [`LICENSE`](LICENSE).

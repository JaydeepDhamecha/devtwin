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

## Benefits

- **Fewer wrong diagnoses.** Without DevTwin, an AI agent debugging a
  failure can only read code and guess -- it will often propose a code fix
  for what's actually a Node version mismatch or a stopped database.
  DevTwin gives it ground truth instead of a guess.
- **One call instead of many.** A single `dev_health` call bundles ~10
  underlying checks (runtime versions, dependency state, services, ports,
  Git) into one structured, scored result -- instead of an agent making a
  dozen separate shell round-trips and parsing raw CLI output each time.
- **Same check every time.** The exact checks per ecosystem (Gradle
  wrapper vs. system Gradle, `.nvmrc` vs. `package.json` engines, ...) are
  encoded once, so the diagnosis is consistent across sessions instead of
  depending on what an agent happens to think to run.
- **Safer than handing an agent a shell.** No arbitrary command execution,
  no destructive operations, ever -- see [Security model](#security-model).
- **Secrets never touched.** Environment variables that look secret are
  checked for presence only; values are never read or returned -- see
  [Privacy model](#privacy-model).
- **Works even where the agent has no shell.** MCP clients without a Bash
  tool (some IDE assistants, restricted agents) get this capability at all,
  not zero capability.

## Honest tradeoffs

DevTwin is not a daily-use tool for a stable environment -- nobody needs to
re-check "is Postgres running" on every function they write. It's a
**break-glass tool**: high value at specific moments (fresh clone, a build
that mysteriously fails, right before a commit), and idle the rest of the
time. That's the intended usage pattern, not a shortcoming.

Two real costs worth knowing before you add it:

- **Token overhead, always paid.** Every tool an MCP server exposes adds
  its schema (name, description, parameters) to every request in a
  session, whether or not it's ever called. DevTwin's 10 tools cost
  roughly 800-1200 tokens of fixed overhead per turn. On a session that
  never touches an environment issue, that's pure cost with no benefit.
- **It only pays for itself when actually invoked.** One real diagnostic
  session (a `dev_health` call replacing five or six raw shell round-trips)
  easily nets positive. A session that never hits an environment question
  doesn't recoup the fixed cost.

**Practical implication:** prefer registering DevTwin per-project
(`.mcp.json` in the repo, or `claude mcp add devtwin ... --scope project`)
over a blanket user-wide install across every session -- see
[MCP client configuration](#mcp-client-configuration).

If Claude Code (or another client with shell access) is already reading a
repo you fully control and rarely has environment drift, you may not need
DevTwin there at all -- raw Bash covers the same ground, just less safely
and less consistently. DevTwin earns its keep on: shared/onboarding repos,
less-trusted or shell-less agent setups, and multi-ecosystem monorepos
where "what do I even check" is itself the hard part.

## With vs. without DevTwin: a worked example

Say you ask an agent "why does `npm test` fail?" and the real cause is a
Node version mismatch plus Postgres not running.

**Without DevTwin** (agent using raw Bash), the agent has to guess the
right sequence, one command at a time:

```
cat package.json                      # spot "engines": {"node": ">=20"}
node --version                        # v16.20.0 -- mismatch found
grep -i "pg\|postgres" package.json   # spot the Postgres dependency
cat .env                              # risk: may print a real secret into context
lsof -i :5432                         # nothing listening
docker ps                             # check if it's in a container instead
```

Six round-trips, an investigation path the agent had to invent, and a real
chance of a secret value leaking into the conversation at step 4.

**With DevTwin**, one call:

```
dev_health()
```

```json
{
  "status": "error",
  "summary": "2 issues found: runtime drift, service down",
  "issues": [
    "Node 16.20.0 installed, project requires >=20 (from package.json engines)",
    "Postgres required (found in docker-compose.yml) but not running on 5432"
  ],
  "recommendations": [
    "nvm install 20 && nvm use 20",
    "docker compose up -d postgres"
  ]
}
```

Same conclusion. One call instead of six, no possibility of leaking a
secret, and the exact same curated check every time instead of a freehand
investigation that varies session to session.

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
| Swift (iOS/macOS) | `Package.swift`, `*.xcodeproj`, `*.xcworkspace`, `Podfile` | `swift`, `xcodebuild` | SPM, CocoaPods |
| Ruby | `Gemfile`, `*.gemspec`, `.ruby-version` | `ruby` | Bundler |
| PHP | `composer.json` | `php` | Composer |
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

## Using it on another project (for other developers)

DevTwin is one binary; point any number of projects at the same install --
no per-project reinstall needed. Two scopes, pick based on how often you
want it active:

**Project scope (recommended default)** -- only loads in this repo. Drop
a `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "devtwin": {
      "command": "/absolute/path/to/devtwin-mcp/.venv/bin/devtwin"
    }
  }
}
```

or, with the Claude Code CLI:

```bash
claude mcp add devtwin /absolute/path/to/devtwin-mcp/.venv/bin/devtwin --scope project
```

**User scope** -- loads in every project you open, on every session:

```bash
claude mcp add devtwin /absolute/path/to/devtwin-mcp/.venv/bin/devtwin --scope user
```

Given the fixed per-turn token cost of any loaded MCP server (see
[Honest tradeoffs](#honest-tradeoffs)), user scope makes sense once you're
reaching for DevTwin across most of your repos; project scope is the
better default otherwise.

Restart the client (or reconnect the MCP server) after adding it, then
just ask normal questions -- see
[Example questions this unlocks](#example-questions-this-unlocks). In a
monorepo mixing platforms (e.g. an Android + iOS + backend repo), point
questions at the specific subfolder rather than the repo root, e.g. "check
the health of the `android/` app" -- `dev_detect` at the root of a mixed
repo will report every ecosystem it finds, which is useful once but noisy
for a targeted check.

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

- Additional ecosystem adapters: Elixir, Dart, Scala,
  C/C++ (CMake/Bazel/Buck), Nix (see `docs/adapters.md` for how to add one)
- Additional service detectors (MySQL/MariaDB, MongoDB, Kafka, RabbitMQ)
- Richer drift comparison against CI configuration (e.g. GitHub Actions
  runtime matrices)
- Optional local caching of expensive checks across tool calls within a
  session

## License

Apache-2.0 -- see [`LICENSE`](LICENSE).

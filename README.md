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

### Why use DevTwin instead of just asking Claude to run bash commands?

- **Safe:** No arbitrary command execution, only allowlisted environment checks
- **Consistent:** Same ecosystem detection and health checks across all projects
- **Efficient:** One structured MCP call (~800 tokens) replaces 5–6 scattered bash commands (~1500–2000 tokens)
- **Secret-proof:** Never exposes API keys, passwords, or secrets in output
- **Works everywhere:** Any MCP client (Claude Code, Claude Desktop, Cursor, etc.), not just clients with a shell tool

**See the side-by-side comparison:** [MCP vs raw Claude](https://claude.ai/code/artifact/4a85ce00-e3c0-45c7-8fe3-4dcf61b75ff8)

## Contents

- [Why DevTwin exists](#why-devtwin-exists)
- [FAQ: Claude CLI already has a shell, so why an MCP at all?](#faq-claude-cli-already-has-a-shell-so-why-an-mcp-at-all)
- [Benefits](#benefits)
- [Token cost](#token-cost)
- [Honest tradeoffs](#honest-tradeoffs)
- [With vs. without DevTwin: a worked example](#with-vs-without-devtwin-a-worked-example)
- [Example questions this unlocks](#example-questions-this-unlocks)
- [Per-language examples](#per-language-examples)
- [Architecture](#architecture)
- [Supported ecosystems](#supported-ecosystems)
- [Installation](#installation)
- [MCP client configuration](#mcp-client-configuration)
- [Using it on another project](#using-it-on-another-project-for-other-developers)
- [Tool reference](#tool-reference)
- [Security model](#security-model)
- [Privacy model](#privacy-model)
- [Local-first architecture](#local-first-architecture)
- [Development](#development)
- [Contributing](#contributing)
- [Roadmap](#roadmap)
- [License](#license)

## Why DevTwin exists

- AI coding agents read code well, but are blind to the environment that
  code actually runs in.
- "Why does `npm test` fail on my machine?" usually has nothing to do with
  the code -- it's a Node version mismatch, a service that isn't running,
  or dependencies that were never installed.
- DevTwin gives an agent the same signal a senior engineer would gather by
  hand -- `node --version`, `git status`, `lsof -i :5432`, `docker ps` --
  as structured tool calls instead of guesswork.

## FAQ: Claude CLI already has a shell, so why an MCP at all?

This is usually the first question a developer asks, and it's a fair one.
In a client like Claude Code that already has a Bash tool, you can just
ask it to run `node --version`, `docker ps`, `lsof -i :5432`, etc.
directly -- no MCP server required. **The gap DevTwin closes isn't "can
this be done at all" -- it's these:**

| Without DevTwin (raw Bash) | With DevTwin |
|---|---|
| The agent *can* run anything, including destructive commands, even unintentionally. | Zero arbitrary execution -- a fixed allowlist of read-only/safe checks only. See [Security model](#security-model). |
| Picks a different investigation each session; can miss ecosystem edge cases (Gradle wrapper vs. system Gradle, `.nvmrc` vs. `package.json` engines). | The same curated, tested check every time, for every ecosystem. |
| A command like `cat .env` can pull a real secret value straight into the conversation. | Structurally never returns secret values -- presence/absence only. See [Privacy model](#privacy-model). |
| Only works in clients that have a shell tool at all (not Claude Desktop, some IDE plugins). | Works in any MCP client, shell or no shell. |
| ~6 separate round-trips to diagnose one failure; ~1500–2000 tokens per check (5–6 bash commands, scattered output). | 1 call; ~800–1200 tokens per check. See the [worked example](#with-vs-without-devtwin-a-worked-example). |

**Honest answer for Claude CLI specifically:** since it already has Bash,
DevTwin's win there is smaller than "capability you didn't have" -- it's
safety guarantees and consistent, structured output, not brand-new
access. That's also why it isn't free -- see [Token cost](#token-cost)
for what connecting it actually costs, and when it's worth it.

**A few more questions worth asking before adopting this:**

**"Isn't this just a `doctor` script (`make doctor`, `bin/setup`) with extra
steps?"** Conceptually, yes -- plenty of mature repos already hand-write
one. DevTwin's difference is that most repos *don't* have one, writing a
good one per-ecosystem is real work, its output is structured JSON an
agent can reason over rather than plain text a human reads, and the same
10 tools work identically across every repo instead of a bespoke script
per project with its own conventions and blind spots.

**"Does this only work with Claude / Claude Code?"** No. DevTwin speaks
the standard Model Context Protocol -- any MCP-compatible client (Claude
Desktop, Cursor, Windsurf, etc.) can connect to it the same way. Nothing
about it is Claude-specific.

**"Is this safe to depend on -- is it actively maintained?"** It's
[Alpha status](pyproject.toml) and a young project -- read the code (it's
short) before trusting it in a workflow you depend on, same as you would
any new dev-tooling dependency.

**"Could it suggest something wrong, or run a bad recommendation
automatically?"** No tool here executes a `recommendations` string --
those are just text for the agent (or you) to read and decide on.
`dev_check` is the only tool that executes anything, and only commands it
recognized itself against a fixed allowlist -- see
[Security model](#security-model).

**"Does it phone home or send telemetry anywhere?"** No. Zero network
calls of its own -- see [Local-first architecture](#local-first-architecture).

**"I don't want an MCP server running *any* commands on my machine."**
9 of the 10 tools are pure read-only (file reads, version checks). Only
`dev_check` executes anything, and only commands DevTwin itself
recognized from project files, checked against an allowlist, with
`shell=False` and a timeout -- see [Security model](#security-model) for
exactly what that does and doesn't allow.

## Benefits

- **Fewer wrong diagnoses.** Without DevTwin, an agent debugging a failure
  can only read code and guess -- it will often propose a code fix for
  what's actually a Node version mismatch or a stopped database. DevTwin
  gives it ground truth instead of a guess.
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
  tool (some IDE assistants, restricted agents) get this capability at
  all, not zero capability.

## Token cost

Real numbers, not an estimate -- measured directly from this server's own
MCP tool schemas (`mcp.list_tools()`) and a real `dev_health()` response,
using the standard ~4-characters-per-token approximation.

**Two different moments spend tokens, and they cost very differently:**

| When | What happens | Cost |
|---|---|---|
| **The moment the client connects** to DevTwin | All 10 tool schemas (name, description, parameters) are added to *every request* in that session -- whether or not any tool is ever called. This is true of any MCP server, not specific to DevTwin. | **≈1,400 tokens, every single turn** |
| **Only when a tool is actually called** | That one tool's JSON response is added to context, once. | **~120-200 tokens per call** (varies with how many issues are found) |

Per-tool schema breakdown (measured):

| Tool | Schema size | ≈ tokens |
|---|---|---|
| `dev_detect` | 440 chars | ~110 |
| `dev_health` | 500 chars | ~125 |
| `dev_drift` | 470 chars | ~117 |
| `dev_explain_failure` | 793 chars | ~198 |
| `dev_project_info` | 523 chars | ~130 |
| `dev_dependencies` | 507 chars | ~126 |
| `dev_services` | 507 chars | ~126 |
| `dev_check` | 771 chars | ~192 |
| `dev_prepare` | 645 chars | ~161 |
| `dev_precommit` | 481 chars | ~120 |
| **Total (all 10 tools)** | **5,637 chars** | **≈1,400** |

**The honest bottom line:** for a *single* one-off diagnosis in a session
that otherwise never touches an environment question, raw Bash can come
out cheaper in total tokens -- the ~1,400-token fixed schema tax often
outweighs the savings from replacing several shell commands with one call.
See the worked comparison below for real numbers on both sides.

DevTwin's case gets stronger the more environment questions come up in one
session (the fixed tax is paid once; every question after that is ~150
tokens on DevTwin vs. hundreds more on raw Bash each time) -- and its real
advantage isn't raw token count at all, it's consistency, safety, and
working in MCP clients that have no Bash tool. See
[Benefits](#benefits) and [Honest tradeoffs](#honest-tradeoffs).

**Practical implication:** register DevTwin per-project, not user-wide, so
the fixed tax is only paid in sessions where it's actually useful -- see
[Using it on another project](#using-it-on-another-project-for-other-developers).

## Honest tradeoffs

DevTwin is not a daily-use tool for a stable environment -- nobody needs
to re-check "is Postgres running" on every function they write. It's a
**break-glass tool**: high value at specific moments (fresh clone, a build
that mysteriously fails, right before a commit), and idle the rest of the
time. That's the intended usage pattern, not a shortcoming.

- Token overhead is paid on every turn the moment it's connected, whether
  used or not -- see [Token cost](#token-cost) for real measured numbers.
- It doesn't reliably win on tokens for a single one-off question; it wins
  on consistency, safety, and reach into clients with no shell -- see
  [Benefits](#benefits).
- If an agent already has full shell access to a repo you fully control
  and rarely has environment drift, you may not need DevTwin there at all.
- DevTwin earns its keep most on: shared/onboarding repos, less-trusted or
  shell-less agent setups, and multi-ecosystem monorepos where "what do I
  even check" is itself the hard part.

## With vs. without DevTwin: a worked example

Say you ask an agent "why does `npm test` fail?" and the real cause is a
Node version mismatch plus Postgres not running.

**Without DevTwin** (agent using raw Bash) -- it has to guess the right
sequence, one command at a time:

```
cat package.json                      # spot "engines": {"node": ">=20"}
node --version                        # v16.20.0 -- mismatch found
grep -i "pg\|postgres" package.json   # spot the Postgres dependency
cat .env                              # risk: may print a real secret into context
lsof -i :5432                         # nothing listening
docker ps                             # check if it's in a container instead
```

Six round-trips, an investigation path the agent had to invent, a real
chance of a secret leaking into the conversation at step 4, and roughly
**400-800 tokens** of command + output text (varies with file sizes and
how many Docker containers are running).

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

Same conclusion, ~150 tokens for the response -- plus the ~1,400-token
fixed schema tax already paid that turn regardless (see
[Token cost](#token-cost)). One call instead of six, no possibility of
leaking a secret, and the exact same curated check every time instead of
a freehand investigation that varies session to session.

## Example questions this unlocks

- "Check my development environment."
- "Why is my Kotlin project failing to build?"
- "Is my Node version correct for this repo?"
- "Why can't my app connect to Postgres?"
- "Does my environment drift from what this repository expects?"
- "What should I run before I commit?"
- "I just cloned this repo -- what do I need to do to get it running?"

## Per-language examples

One row per supported ecosystem: a question you'd actually ask, what
DevTwin checks to answer it, and the test/build command it recognizes for
`dev_check`.

| Ecosystem | Example question | What gets checked | Recognized command(s) |
|---|---|---|---|
| Python | "Is my Python version right for this repo?" | `python`/`python3` vs. `.python-version` or `pyproject.toml [project.requires-python]`; uv/pip/poetry/pipenv + lockfile | `pytest`, `ruff check .`, `mypy .` |
| Node.js | "Why does `npm test` fail?" | `node` vs. `.nvmrc`/`.node-version`/`package.json engines`; npm/pnpm/yarn/bun + lockfile | `npm test` (or `pnpm test`/`yarn test`/`bun test`), `<mgr> run lint` |
| JVM (Java + Kotlin + Android) | "Why won't my Android app build after a fresh clone?" | `java`/`kotlinc` version; Gradle wrapper version vs. installed; Maven wrapper; **on Android projects specifically:** `ANDROID_HOME`/`ANDROID_SDK_ROOT`, or `local.properties`' `sdk.dir` and whether that path actually exists | `./gradlew test`, `./mvnw test` |
| Go | "Is my Go version correct for this repo?" | `go` vs. the version required in `go.mod` | `go test ./...`, `go build ./...` |
| Rust | "Why does `cargo build` fail?" | `rustc` vs. `rust-toolchain[.toml]` channel | `cargo test` |
| .NET | "Why does `dotnet build` fail?" | `dotnet` SDK presence and version | `dotnet test` |
| Swift (iOS/macOS) | "Why does my iOS build fail?" | `swift`/`xcodebuild` vs. `Package.swift` tools-version; CocoaPods/SPM lockfile state | `swift test` (SPM projects only) |
| Ruby | "Why does `bundle exec rspec` fail?" | `ruby` vs. `.ruby-version`; Bundler + `Gemfile.lock` | `bundle exec rspec`, `bundle exec rake test` |
| PHP | "Why does my PHP app fail to boot?" | `php` vs. `composer.json`'s `require.php`; Composer + `composer.lock` | `composer test`, `vendor/bin/phpunit` |
| Generic (fallback) | "This repo isn't in any language above -- what can you tell me?" | `Makefile`/`Taskfile.yml`/`justfile`/`Dockerfile`/compose services | `make test`, `task test`, `just test` |

## Architecture

One MCP server, many ecosystem adapters -- not a separate server per
language.

```
MCP server -> core (workspace/detector/health/drift/diagnostics) ->
adapters (python/node/jvm/go/rust/dotnet/swift/ruby/php/generic) ->
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

DevTwin is one binary -- point any number of projects at the same install,
no per-project reinstall needed. Two scopes:

| Scope | Loads | When to use |
|---|---|---|
| **Project** (recommended default) | Only in this repo | Default choice -- see [Token cost](#token-cost) for why |
| **User** | Every project, every session | Once you're reaching for DevTwin across most of your repos |

**Project scope** -- drop a `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "devtwin": {
      "command": "/absolute/path/to/devtwin-mcp/.venv/bin/devtwin"
    }
  }
}
```

or with the Claude Code CLI:

```bash
claude mcp add devtwin /absolute/path/to/devtwin-mcp/.venv/bin/devtwin --scope project
```

**User scope**:

```bash
claude mcp add devtwin /absolute/path/to/devtwin-mcp/.venv/bin/devtwin --scope user
```

After adding it, restart the client (or reconnect the MCP server), then
just ask normal questions -- see
[Example questions this unlocks](#example-questions-this-unlocks).

**Monorepo tip:** in a repo mixing platforms (e.g. Android + iOS +
backend), point questions at the specific subfolder rather than the repo
root -- e.g. "check the health of the `android/` app". `dev_detect` at the
root of a mixed repo reports every ecosystem it finds, which is useful
once but noisy for a targeted check.

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

- No server component, no account, no network calls of its own beyond the
  local commands it inspects (`git`, `docker`, language toolchains).
- Everything it reports comes from files and processes already on the
  machine it runs on.

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
for a template, or [`src/devtwin/adapters/swift.py`](src/devtwin/adapters/swift.py),
[`ruby.py`](src/devtwin/adapters/ruby.py), and
[`php.py`](src/devtwin/adapters/php.py) for real, merged examples to
model yours after.

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

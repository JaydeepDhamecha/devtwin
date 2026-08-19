# Development

## Setup

```bash
git clone <your fork>
cd devtwin-mcp
uv sync --all-extras
```

## Running checks

```bash
uv run pytest                    # unit tests (no external tools required)
uv run pytest -m integration     # integration tests (skip if tools missing)
uv run ruff check .
uv run ruff format --check .
uv run mypy src
```

## Running the server locally

```bash
uv run devtwin
```

This starts the MCP server over stdio. To exercise it with the MCP
Inspector:

```bash
npx @modelcontextprotocol/inspector uv run devtwin
```

Or point any MCP-compatible client at:

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

## Project layout

See `docs/architecture.md` for the layer-by-layer breakdown and
`docs/adapters.md` for how to add a new language ecosystem.

## Style

- No comments explaining *what* code does -- only *why*, when non-obvious.
- Prefer stdlib over new dependencies (see the `uv.lock`/`pyproject.toml`
  dependency list -- it is intentionally short).
- Every subprocess call goes through `devtwin.core.runner.run_command`.
- Every adapter method that can fail is wrapped by `EcosystemAdapter.run()`
  -- don't add your own try/except around adapter internals unless you
  need a fallback value more specific than "empty".

## Releasing

`.github/workflows/release.yml` builds the package and is wired for
PyPI publishing via a trusted-publisher / API token secret, but does not
publish automatically -- see the workflow file for what's required.

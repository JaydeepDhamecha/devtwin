# Contributing to DevTwin

Thanks for considering a contribution.

## Getting started

See `docs/development.md` for setup, running tests, and running the server
locally.

## Before opening a PR

- `uv run pytest`
- `uv run ruff check .`
- `uv run ruff format --check .`
- `uv run mypy src`

All four must pass. CI runs the same checks.

## Adding a language adapter

See `docs/adapters.md` -- it has a full template and checklist (adapter
file, registry entry, allowlist entry, fixtures, tests).

For a real, merged example to model yours after (not just the template),
see the three most recently added adapters:
[`src/devtwin/adapters/swift.py`](src/devtwin/adapters/swift.py) (dual
detection -- SPM *and* Xcode, tools-version parsing),
[`src/devtwin/adapters/ruby.py`](src/devtwin/adapters/ruby.py) (version
file convention, `.ruby-version`), and
[`src/devtwin/adapters/php.py`](src/devtwin/adapters/php.py) (JSON
manifest parsing, `composer.json`). Each has matching fixtures under
`tests/fixtures/` and tests under `tests/unit/test_<name>_adapter.py`.

## Guidelines

- No new dependency without a clear reason stdlib/an existing dependency
  can't cover.
- No tool that executes arbitrary, model-supplied commands. See
  `docs/security.md`.
- Every subprocess call goes through `devtwin.core.runner.run_command`
  (`shell=False`, explicit argv, timeout).
- Structured results only -- no large unstructured text blobs returned
  from a tool.
- Never return secret values; see `devtwin.security.secrets`.

## Reporting bugs / requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`.

## Security issues

Do not open a public issue -- see `SECURITY.md`.

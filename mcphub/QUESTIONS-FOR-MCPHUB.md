# DevTwin plugin submission — questions before we publish

We have built DevTwin as an MCPHub plugin (`@mcphub/plugin-devtwin`, 18 tools,
all 18 Basic compliance checks passing). Before we submit it for review, three
things in the dev kit do not resolve cleanly for a plugin of this kind, and the
answers change what we submit.

## 1. Is there a local-execution plugin type? (blocking)

This is the one that decides the shape of the submission.

DevTwin reports on a **developer's own machine**: which runtimes are installed,
which ports are listening, whether Postgres or Redis is actually running, Docker
state, Git state. That is its entire value.

The dev kit describes plugins as executing server-side over Streamable HTTP. If
DevTwin's tools run on MCPHub's server, they will return confident, correct-looking
answers **about MCPHub's server** rather than about the developer's machine.
Six of our eighteen tools are affected: `devtwin_services`, `devtwin_drift`,
`devtwin_health`, `devtwin_check`, `devtwin_build`, `devtwin_build_all`.

**Question:** does MCPHub support a plugin that executes in the caller's local
environment — a local runtime, a bridge/agent, or any comparable mechanism?

- **If yes:** we submit all 18 tools; the port is already complete and verified.
- **If no:** we submit only the tools that analyse repository *content* and are
  correct regardless of where they execute — `devtwin_detect`,
  `devtwin_project_info`, `devtwin_dependencies`, `devtwin_precommit` — plus the
  5 settings tools, and we keep the full server on PyPI for local use.

We would rather ship the smaller honest version than the larger misleading one.

## 2. Subprocess spawning — will this pass review?

The dev kit lists subprocess spawning as HIGH severity ("Warn, flag for review",
−15 on the security score). DevTwin's `devtwin_check` and `devtwin_build` exist
specifically to run a project's own test and build commands, so we cannot remove
this and still have a product.

What we do to bound it:

- No tool accepts an arbitrary command. The `run` parameter selects from commands
  DevTwin's own ecosystem adapters discovered in the project; anything else is
  returned in a `rejected` list and never executed.
- Executables are allowlisted (~45 known toolchain binaries). Destructive
  subcommands (`reset`, `clean`, `push`, `rm`, `prune`, `--force`, …) are denied
  even for allowlisted executables.
- Every command runs via `execFile` with `shell: false` and an explicit timeout.
  There is no path from model-supplied text to a shell string.
- `enableCommandExecution: false` disables all three executing tools while the
  read-only analysis tools keep working.

**Question:** is that sufficient to pass review, or is there a sanctioned pattern
for plugins that legitimately need to run project commands? If a reviewer would
reject this regardless, we would rather know now and submit the read-only subset.

## 3. Two limits we have engineered around — please confirm

**The 30-second tool execution timeout.** Real Gradle and Xcode builds take
minutes. We cap every command at `platformTimeoutBudgetSeconds` (default 25) and
report over-budget builds as timed out with `timeout_clamped: true`, rather than
letting them run past the platform limit. Is 25s the right ceiling, and is the
budget configurable per plugin or per plan?

**The 1MB response limit.** Build logs exceed this easily. We truncate per-command
output and enforce a serialized ceiling before returning. Confirming the limit is
per tool result, not per session.

## 4. Two smaller compliance questions

**`getSensitiveConfigFields()` returns an empty array.** DevTwin authenticates to
nothing and stores no credentials — there is deliberately no API key, token, or
password in its config schema. Compliance check #4 is therefore vacuously
satisfied. Will an empty array pass `/mcphub-dev verify`, or does the checker
expect a non-empty list? We would rather not add a field that does not exist.

**`dbSchema` is unset.** DevTwin creates no tables; `devtwin_remove` has nothing
to delete. We read check #16 as non-critical and not applicable. Please confirm.

## What we have ready

- 18 tools, all prefixed `devtwin_`, each categorised (5 settings / 8 core / 5 service)
- Pricing tiers with full coverage, zod config schema (every field defaulted),
  config meta, 2 action plans, health check, SKILL.md, brand icon
- A local verifier for the Basic 18 (`npm run verify`) and a smoke test that
  exercises every tool against a real repository (`npm run smoke`)
- Output verified identical to our existing Python MCP server on the same repo

Happy to walk anyone through the code or hand over the repository.

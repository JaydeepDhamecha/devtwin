# @mcphub/plugin-devtwin

MCPHub plugin packaging of [DevTwin](../../README.md) — development-environment
intelligence for AI coding agents.

This directory is a self-contained MCPHub plugin. The Python MCP server at the
repository root remains the local-first distribution; this is the hosted one.

## Layout

```
devtwin/
├── package.json            @mcphub/plugin-devtwin
├── SKILL.md                AI-readable usage guide (indexed for routing)
├── assets/icon.svg         Brand icon
├── src/
│   ├── index.ts            Plugin class: pricing, config meta, action plans, health
│   ├── tools.ts            18 MCP tool definitions
│   ├── handlers.ts         Tool call routing
│   ├── config.schema.ts    Zod config schema (every field defaulted)
│   ├── devtwin.manager.ts  Service class — all business logic, also the standalone service
│   ├── core/               models, runner, detector, health, drift, diagnostics, workspace
│   ├── adapters/           10 ecosystem adapters
│   ├── system/             OS, ports, processes, environment, docker, filesystem
│   ├── services/           Postgres, Redis, compose service detection
│   └── security/           command allowlist, secret redaction, tool classification
├── types/                  Local ambient declarations for @mcphub/core
└── scripts/                Compliance verifier and smoke test
```

## Development

```bash
npm install
npm test            # typecheck + verify + regress + smoke
npm run typecheck   # tsc --noEmit
npm run verify      # the MCPHub Basic 18 compliance checks
npm run regress     # regression tests for previously-fixed defects
npm run smoke       # run every tool against a real repository
```

`npm run smoke [path]` defaults to the repository root.

## Tools

18 tools, all prefixed `devtwin_`: 5 settings, 8 core (read-only analysis),
5 service (diagnosis, planning, execution). See [SKILL.md](./SKILL.md).

## Design constraints carried over from the Python server

- **No arbitrary execution.** The `run` parameter selects from commands DevTwin's
  own adapters discovered; anything else is returned in `rejected`. Executables
  are allowlisted and destructive subcommands are denied.
- **No secret values.** Secret-named environment variables are reported as
  present or absent, never with a preview.
- **Evidence, not assertion.** Every detection carries the files or probes
  behind it, and every root-cause candidate carries a confidence.

## Hosted-execution differences

Two behaviours differ from the local Python server, because a hosted plugin runs
on MCPHub's server rather than the developer's machine:

| Setting | Default | Why |
| --- | --- | --- |
| `allowHostEnvironment` | `false` | Hosted, `process.env` is the *platform's* environment, not the project's. Variable names are read from the workspace `.env` files instead. Set `true` only where DevTwin runs on the developer's own machine. |
| `platformTimeoutBudgetSeconds` | `25` | Caps every command timeout to stay inside the platform's per-call budget. Builds longer than this are reported as timed out with `timeout_clamped: true`. |

Platform-internal variable names (`JWT_SECRET`, `SESSION_SECRET`, …) are never
reported, even with `allowHostEnvironment` enabled.

**The larger caveat:** the tools that inspect live machine state — `devtwin_services`,
`devtwin_drift`, `devtwin_health`, `devtwin_check`, `devtwin_build`, `devtwin_build_all` —
describe the machine the plugin runs on. Hosted, that is MCPHub's server. The
file-based analysis tools (`devtwin_detect`, `devtwin_project_info`,
`devtwin_dependencies`, `devtwin_precommit`) read the workspace and are correct
either way.

## Parity with the Python server

Verified against the same repository, identical output: health score, project and
runtime summaries, issue codes, recommendations, ecosystem confidences, drift
result, and failure-diagnosis ranking. See `scripts/smoke-test.mjs`.

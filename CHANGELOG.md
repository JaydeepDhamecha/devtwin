# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/)
once it reaches 1.0.

## [0.1.0] - Unreleased

### Added

- Initial DevTwin MCP server with thirteen tools: `dev_detect`, `dev_health`,
  `dev_health_all`, `dev_drift`, `dev_explain_failure`, `dev_project_info`,
  `dev_dependencies`, `dev_services`, `dev_check`, `dev_build`, `dev_build_all`,
  `dev_prepare`, `dev_precommit`.
- Ecosystem adapters: Python, Node.js, JVM (Java + Kotlin), Go, Rust,
  .NET, and a generic fallback adapter.
- Cross-platform system inspection: OS/platform, processes, ports,
  environment variables, filesystem, Docker (read-only).
- Service detection for PostgreSQL and Redis, plus generic compose-derived
  service detection.
- Health scoring engine, drift detection engine, and evidence-based
  failure diagnosis engine.
- Secret redaction, command allowlisting, and action classification
  (read_only/safe/requires_approval/dangerous).
- Full test suite (unit + integration) with fixtures for 11 project
  types across 6+ ecosystems.
- Automated build-impact checking for monorepos: `dev_build` and `dev_build_all`
  tools verify backend changes don't break Android, iOS, and frontend builds.
- iOS/Xcode build support: `SwiftAdapter` now detects and generates buildable
  `xcodebuild` commands for Xcode projects (not just SPM).
- Claude Code subagent `backend-impact-build-check` for on-demand build verification
  after backend changes.

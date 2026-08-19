# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/)
once it reaches 1.0.

## [0.1.0] - Unreleased

### Added

- Initial DevTwin MCP server with ten tools: `dev_detect`, `dev_health`,
  `dev_drift`, `dev_explain_failure`, `dev_project_info`,
  `dev_dependencies`, `dev_services`, `dev_check`, `dev_prepare`,
  `dev_precommit`.
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

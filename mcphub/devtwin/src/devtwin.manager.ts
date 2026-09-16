/**
 * DevTwin service class -- all business logic behind the plugin's tools.
 *
 * Kept free of any MCP import so it doubles as the standalone service
 * (see `getStandaloneService()` in index.ts). Tool handlers are thin: they
 * validate/route, this class does the work.
 */

import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { ADAPTERS } from './adapters/index.js';
import { detectProject } from './core/detector.js';
import { diagnoseFailure } from './core/diagnostics.js';
import { computeDrift } from './core/drift.js';
import { computeHealth, runAdapters } from './core/health.js';
import {
  ActionClass,
  Status,
  type AdapterResult,
  type CommandResult,
  type ServiceInfo,
  type ToolResult,
} from './core/models.js';
import { runCommand } from './core/runner.js';
import { inspectGit, inspectWorkspace } from './core/workspace.js';
import { isAllowedExecutable, isDangerous, splitCommand } from './security/permissions.js';
import { detectServices } from './services/index.js';
import { inspectDocker } from './system/docker.js';
import { listTopLevel, pathExists, isDirectory } from './system/filesystem.js';
import { configureEnvSource } from './system/environment.js';
import { getOsInfo } from './system/os.js';
import { applyConfig, parseConfig, type DevTwinConfig } from './config.schema.js';

/** Label the monorepo scans use for the workspace root itself. */
const ROOT_DIR_LABEL = '.';

/** Filename fragments that suggest a staged file carries credentials. */
const SECRET_FILE_PATTERNS = [
  '.env',
  '.pem',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'secrets.yml',
  'secrets.yaml',
  '.p12',
  '.pfx',
];

export interface LogEntry {
  timestamp: string;
  tool: string;
  status: string;
  summary: string;
  duration_ms: number;
}

interface CommandOutcome {
  command: string;
  executed: boolean;
  reason?: string;
  result?: CommandResult;
  passed?: boolean;
  timeout_clamped?: boolean;
}

/**
 * Command outcomes split by what actually happened to them.
 *
 * Only `failed` is a failure of the project. A command the allowlist refused
 * never ran; a command whose executable is not installed never ran either --
 * reporting a missing `npm` as a failed build would invent a compilation
 * error that does not exist; and a command DevTwin stopped at its own timeout
 * says nothing about whether the build works, only that it outlived the
 * timeout budget.
 */
interface OutcomePartition {
  passed: CommandOutcome[];
  failed: CommandOutcome[];
  refused: CommandOutcome[];
  unavailable: CommandOutcome[];
  timedOut: CommandOutcome[];
}

function partitionResults(results: CommandOutcome[]): OutcomePartition {
  const partition: OutcomePartition = {
    passed: [],
    failed: [],
    refused: [],
    unavailable: [],
    timedOut: [],
  };
  for (const outcome of results) {
    if (!outcome.executed) {
      partition.refused.push(outcome);
    } else if (outcome.result && !outcome.result.available) {
      partition.unavailable.push(outcome);
    } else if (outcome.result?.timed_out) {
      partition.timedOut.push(outcome);
    } else if (outcome.passed) {
      partition.passed.push(outcome);
    } else {
      partition.failed.push(outcome);
    }
  }
  return partition;
}

/** Commands that really started: the only ones whose outcome describes the project. */
function executedCount(partition: OutcomePartition): number {
  return partition.passed.length + partition.failed.length + partition.timedOut.length;
}

/**
 * Status for a set of command results, never reporting a run that did not
 * happen as OK.
 *
 * `rejected` are names the caller asked for that DevTwin does not recognize,
 * and `skipped` are recognized commands dropped for the per-call cap. Both
 * mean "you asked for something that did not run", so neither can leave the
 * result looking clean.
 */
function executionStatus(
  results: CommandOutcome[],
  rejected: string[] = [],
  skipped: string[] = [],
): Status {
  const { failed, refused, unavailable, timedOut } = partitionResults(results);
  if (failed.length > 0) return Status.ERROR;
  if (
    refused.length > 0 ||
    unavailable.length > 0 ||
    timedOut.length > 0 ||
    rejected.length > 0 ||
    skipped.length > 0
  ) {
    // Nothing that ran failed, but something we were asked to run never did.
    return Status.WARNING;
  }
  return results.length > 0 ? Status.OK : Status.UNKNOWN;
}

/**
 * One sentence covering every outcome, including the ones that did not run.
 * Shared by devtwin_check and devtwin_build so their wording cannot drift;
 * each clause is emitted only when it is non-zero, so a clean run reads
 * "Ran 2 build(s), 0 failed." and nothing more.
 */
function executionSummary(
  kind: string,
  results: CommandOutcome[],
  recognized: string[],
  rejected: string[],
  skipped: string[],
): string {
  const partition = partitionResults(results);

  if (results.length === 0) {
    if (rejected.length > 0) {
      return (
        `None of the requested command(s) are recognized ${kind} commands ` +
        `for this project; ${recognized.length} recognized command(s) available.`
      );
    }
    return `No recognized ${kind} commands were found for this project.`;
  }

  let summary = `Ran ${executedCount(partition)} ${kind}(s), ${partition.failed.length} failed`;
  if (partition.timedOut.length > 0) {
    summary += `, ${partition.timedOut.length} timed out (no pass or fail can be reported)`;
  }
  if (partition.refused.length > 0) {
    summary += `, ${partition.refused.length} refused (not in DevTwin's allowlist)`;
  }
  if (partition.unavailable.length > 0) {
    summary += `, ${partition.unavailable.length} skipped (tool not installed)`;
  }
  if (skipped.length > 0) {
    summary += `, ${skipped.length} not attempted (per-call cap)`;
  }
  if (rejected.length > 0) {
    summary += `, ${rejected.length} unrecognized`;
  }
  return `${summary}.`;
}

/** `kind` is "build" or "check" -- devtwin_check reuses this for test commands. */
function refusedIssue(
  directory: string,
  refused: CommandOutcome[],
  kind = 'build',
): Record<string, unknown> {
  return {
    severity: 'medium',
    code: `${kind}.commands_refused`,
    title: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} command(s) in '${directory}' were not executed`,
    message: `These commands are not in DevTwin's allowlist, so the ${kind} did not run.`,
    evidence: refused.map((r) => r.command),
    recommendation: 'Run them yourself; DevTwin cannot report a pass or a failure for them.',
  };
}

/**
 * A command stopped at the timeout is neither a pass nor a failure. When the
 * timeout was clamped by platformTimeoutBudgetSeconds the cause is DevTwin's
 * own budget, not the project, and the issue says so.
 */
function timedOutIssue(
  directory: string,
  timedOut: CommandOutcome[],
  kind: string,
  effectiveTimeoutSeconds: number,
  clamped: boolean,
): Record<string, unknown> {
  return {
    severity: 'medium',
    code: `${kind}.commands_timed_out`,
    title: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} command(s) in '${directory}' did not finish in time`,
    message: clamped
      ? `Stopped after ${effectiveTimeoutSeconds}s: the configured ${kind} timeout was clamped to ` +
        'platformTimeoutBudgetSeconds. This is not a failure -- the command was still running.'
      : `Stopped after ${effectiveTimeoutSeconds}s. This is not a failure -- the command was ` +
        'still running when DevTwin stopped it.',
    evidence: timedOut.map((r) => r.command),
    recommendation: clamped
      ? 'Raise platformTimeoutBudgetSeconds, or run the command yourself for a real result.'
      : `Raise ${kind}TimeoutSeconds, or run the command yourself for a real result.`,
  };
}

/** Minimal shape of the per-call context the platform hands to a tool. */
export interface CallContext {
  customerId?: string;
  userId?: string;
  [key: string]: unknown;
}

export class DevTwinManager extends EventEmitter {
  private config: DevTwinConfig;
  private logs: LogEntry[] = [];
  private configuredAt: string | null = null;

  constructor(rawConfig: unknown = {}) {
    super();
    this.config = parseConfig(rawConfig);
  }

  // ---------------------------------------------------------------- settings

  /** devtwin_configure -- validate and store configuration. */
  configure(args: Record<string, unknown>, _context?: CallContext): ToolResult {
    const incoming = (args?.['config'] as Record<string, unknown>) ?? args ?? {};
    const update = applyConfig(this.config, incoming);

    if (!update.accepted) {
      // Leave the existing configuration in place. Falling back to defaults
      // here would quietly clear allowedWorkspaceRoots, turning a typo in an
      // unrelated field into the removal of a security control.
      return this.record('devtwin_configure', {
        status: Status.ERROR,
        summary: `Configuration rejected: ${update.invalidFields.join(', ')}. Nothing was changed.`,
        data: {
          configured: this.configuredAt !== null,
          invalid_fields: update.invalidFields,
          config: this.publicConfig(),
        },
        issues: [],
        recommendations: ['Correct the listed fields and call devtwin_configure again.'],
      });
    }

    this.config = update.config;
    this.configuredAt = new Date().toISOString();
    this.emit('configured', { at: this.configuredAt });

    return this.record('devtwin_configure', {
      status: Status.OK,
      summary: 'Configuration accepted. DevTwin stores no credentials.',
      data: { configured: true, config: this.publicConfig() },
      issues: [],
      recommendations: [],
    });
  }

  /** devtwin_status -- configuration and readiness, no subprocess work. */
  status(_context?: CallContext): ToolResult {
    const restricted = this.workspaceAllowlist();
    return this.record('devtwin_status', {
      status: Status.OK,
      summary: `DevTwin is ready. Command execution is ${
        this.config.enableCommandExecution ? 'enabled' : 'disabled'
      }.`,
      data: {
        healthy: true,
        configured: this.configuredAt !== null,
        configured_at: this.configuredAt,
        command_execution_enabled: this.config.enableCommandExecution,
        workspace_roots_restricted: restricted.length > 0,
        adapters: ADAPTERS.map((a) => a.ecosystem),
        config: this.publicConfig(),
      },
      issues: [],
      recommendations: [],
    });
  }

  /** devtwin_remove -- drop all in-memory state. DevTwin owns no tables and no files. */
  remove(_context?: CallContext): ToolResult {
    const droppedLogs = this.logs.length;
    this.logs = [];
    this.configuredAt = null;
    this.config = parseConfig({});
    this.emit('removed', { droppedLogs });

    return {
      status: Status.OK,
      summary: 'DevTwin state cleared. No database tables or files were created, so none remain.',
      data: { removed: true, dropped_log_entries: droppedLogs },
      issues: [],
      recommendations: [],
    };
  }

  /** devtwin_health_check -- deep check: can we actually shell out and read a workspace? */
  async deepHealthCheck(_context?: CallContext): Promise<ToolResult> {
    // Probe the same path a tool call with no `workspace` argument would get,
    // rather than re-resolving defaultWorkspace by hand here.
    let workspaceReadable = false;
    try {
      workspaceReadable = pathExists(this.resolveWorkspace(''));
    } catch {
      workspaceReadable = false;
    }

    const probe = await runCommand(['git', '--version'], { timeout: 5 });
    const subprocessWorking = probe.available;

    const healthy = workspaceReadable && (subprocessWorking || !this.config.enableCommandExecution);
    return this.record('devtwin_health_check', {
      status: healthy ? Status.OK : Status.WARNING,
      summary: healthy
        ? 'DevTwin can read the workspace and execute recognized commands.'
        : 'DevTwin is degraded -- see data for which probe failed.',
      data: {
        healthy,
        workspace_readable: workspaceReadable,
        subprocess_available: subprocessWorking,
        git_version: probe.available ? probe.stdout.trim() : null,
        adapters_registered: ADAPTERS.length,
      },
      issues: [],
      recommendations: healthy
        ? []
        : ['Check that the workspace path exists and that DevTwin may spawn processes.'],
    });
  }

  /** devtwin_get_logs -- recent tool activity, newest first. */
  getLogs(args: Record<string, unknown>, _context?: CallContext): ToolResult {
    const limitRaw = Number(args?.['limit'] ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 500) : 50;
    const cutoff = Date.now() - this.config.logRetentionDays * 24 * 60 * 60 * 1000;
    const entries = this.logs
      .filter((entry) => Date.parse(entry.timestamp) >= cutoff)
      .slice(-limit)
      .reverse();

    return {
      status: Status.OK,
      summary: `${entries.length} log entr${entries.length === 1 ? 'y' : 'ies'}.`,
      data: { logs: entries, retained: this.logs.length },
      issues: [],
      recommendations: [],
    };
  }

  // ------------------------------------------------------------------- core

  /** devtwin_detect */
  async detect(workspace: string): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    const ws = await inspectWorkspace(path);
    if (!ws.exists) return this.missingWorkspace(path);

    const profile = detectProject(path);
    const status = profile.ecosystems.length > 0 ? Status.OK : Status.UNKNOWN;
    const summary =
      profile.ecosystems.length > 0
        ? `Detected ${profile.ecosystems.join(', ')} (primary: ${profile.primary_ecosystem})`
        : 'No recognized ecosystem indicators found; generic project.';

    return this.record('devtwin_detect', {
      status,
      summary,
      data: { profile, workspace: ws },
      issues: [],
      recommendations: [],
    });
  }

  /** devtwin_health */
  async health(workspace: string): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    this.applyEnvScope(path);
    const report = await computeHealth(path);
    return this.record('devtwin_health', {
      status: report.status,
      summary: `health_score=${report.health_score} (${report.status}) -- ${report.project_summary}`,
      data: {
        health_score: report.health_score,
        project_summary: report.project_summary,
        runtime_summary: report.runtime_summary,
        service_summary: report.service_summary,
        dependency_summary: report.dependency_summary,
      },
      issues: report.issues as unknown as Array<Record<string, unknown>>,
      recommendations: report.recommendations,
    });
  }

  /** devtwin_drift */
  async drift(workspace: string): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    this.applyEnvScope(path);
    const report = await computeDrift(path);
    return this.record('devtwin_drift', {
      status: report.has_drift ? Status.WARNING : Status.OK,
      summary: report.summary,
      data: { has_drift: report.has_drift, items: report.items },
      issues: [],
      recommendations: report.items.map(
        (i) => `Align ${i.subject}: expected ${i.expected}, found ${i.actual}.`,
      ),
    });
  }

  /** devtwin_explain_failure */
  async explainFailure(
    workspace: string,
    errorMessage: string,
    command?: string | null,
  ): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    this.applyEnvScope(path);
    const report = await diagnoseFailure(path, errorMessage, command ?? null);
    return this.record('devtwin_explain_failure', {
      status: Status.OK,
      summary: report.summary,
      data: { candidates: report.candidates, strongest: report.strongest },
      issues: [],
      recommendations: report.candidates
        .map((c) => c.recommendation)
        .filter((r): r is string => Boolean(r)),
    });
  }

  /** devtwin_project_info */
  async projectInfo(workspace: string): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    const ws = await inspectWorkspace(path);
    if (!ws.exists) return this.missingWorkspace(path);

    this.applyEnvScope(path);
    const profile = detectProject(path);
    const adapters = await runAdapters(path);
    const osInfo = getOsInfo();

    return this.record('devtwin_project_info', {
      status: Status.OK,
      summary: `${profile.primary_ecosystem ?? 'generic'} project with ${adapters.length} applicable adapter(s).`,
      data: {
        profile,
        workspace: ws,
        os: osInfo,
        adapters,
        top_level_entries: listTopLevel(path),
      },
      issues: [],
      recommendations: [],
    });
  }

  /** devtwin_dependencies */
  async dependencies(workspace: string): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    const ws = await inspectWorkspace(path);
    if (!ws.exists) return this.missingWorkspace(path);

    this.applyEnvScope(path);
    const adapters = await runAdapters(path);
    const deps = adapters.map((a) => a.dependencies).filter((d) => d !== null);

    return this.record('devtwin_dependencies', {
      status: deps.length > 0 ? Status.OK : Status.UNKNOWN,
      summary:
        deps.length > 0
          ? `${deps.length} dependency manifest(s) found.`
          : 'No dependency manifests found.',
      data: { dependencies: deps },
      issues: [],
      recommendations: [],
    });
  }

  /** devtwin_services */
  async services(workspace: string): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    const ws = await inspectWorkspace(path);
    if (!ws.exists) return this.missingWorkspace(path);

    this.applyEnvScope(path);
    const adapters = await runAdapters(path);
    const services = await detectServices(path, this.dependencyNames(adapters));
    const dockerInfo = await inspectDocker(path);
    const down = services.filter((s: ServiceInfo) => s.required && !s.running);

    return this.record('devtwin_services', {
      status: down.length > 0 ? Status.WARNING : Status.OK,
      summary: `${services.length} service(s) detected, ${down.length} required-but-stopped.`,
      data: { services, docker: dockerInfo },
      issues: [],
      recommendations: down.map((s) => `Start ${s.name} (expected on port ${s.port}).`),
    });
  }

  /** devtwin_check */
  async check(workspace: string, run?: string[] | null): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    const disabled = this.guardExecution();
    if (disabled) return disabled;

    const ws = await inspectWorkspace(path);
    if (!ws.exists) return this.missingWorkspace(path);

    this.applyEnvScope(path);
    const adapters = await runAdapters(path);

    const recognized: string[] = [];
    for (const a of adapters) recognized.push(...a.test_commands);

    const { toRun, skipped, rejected } = this.selectCommands(
      recognized,
      run,
      this.config.maxAutoCheckCommands,
    );

    const { results, timeoutClamped, effectiveTimeoutSeconds } = await this.runRecognizedCommands(
      path,
      toRun,
      this.config.checkTimeoutSeconds,
    );

    const partition = partitionResults(results);
    const status = executionStatus(results, rejected, skipped);

    return this.record('devtwin_check', {
      status,
      summary: executionSummary('check', results, recognized, rejected, skipped),
      data: {
        recognized_commands: recognized,
        results,
        rejected,
        skipped_commands: skipped,
        max_check_commands: this.config.maxAutoCheckCommands,
        ...this.outcomeCounts(partition, timeoutClamped, effectiveTimeoutSeconds),
      },
      issues: this.outcomeIssues(
        ROOT_DIR_LABEL,
        partition,
        'check',
        effectiveTimeoutSeconds,
        timeoutClamped,
      ),
      recommendations: [],
    });
  }

  /** devtwin_build */
  async build(workspace: string, run?: string[] | null): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    const disabled = this.guardExecution();
    if (disabled) return disabled;

    const ws = await inspectWorkspace(path);
    if (!ws.exists) return this.missingWorkspace(path);

    this.applyEnvScope(path);
    const adapters = await runAdapters(path);

    const recognized: string[] = [];
    for (const a of adapters) recognized.push(...a.build_commands);

    const { toRun, skipped, rejected } = this.selectCommands(
      recognized,
      run,
      this.config.maxAutoBuildCommands,
    );

    const { results, timeoutClamped, effectiveTimeoutSeconds } = await this.runRecognizedCommands(
      path,
      toRun,
      this.config.buildTimeoutSeconds,
    );

    const partition = partitionResults(results);
    const status = executionStatus(results, rejected, skipped);

    return this.record('devtwin_build', {
      status,
      summary: executionSummary('build', results, recognized, rejected, skipped),
      data: {
        recognized_commands: recognized,
        results,
        rejected,
        skipped_commands: skipped,
        max_build_commands: this.config.maxAutoBuildCommands,
        ...this.outcomeCounts(partition, timeoutClamped, effectiveTimeoutSeconds),
      },
      issues: this.outcomeIssues(
        path,
        partition,
        'build',
        effectiveTimeoutSeconds,
        timeoutClamped,
      ),
      recommendations:
        skipped.length > 0
          ? [
              `${skipped.length} recognized build command(s) were not attempted because of the ` +
                `${this.config.maxAutoBuildCommands}-build cap; name them explicitly with \`run\` to build them.`,
            ]
          : [],
    });
  }

  /** devtwin_build_all */
  async buildAll(workspace: string): Promise<ToolResult> {
    const { path: root, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    const disabled = this.guardExecution();
    if (disabled) return disabled;

    this.applyEnvScope(root);
    if (!pathExists(root)) return this.missingWorkspace(root);

    const targets = this.monorepoTargets(root);
    if (targets.length === 0) {
      return this.record('devtwin_build_all', {
        status: Status.UNKNOWN,
        summary: 'No recognized ecosystems found in the workspace root or its subdirectories.',
        data: { ecosystems: [] },
        issues: [],
        recommendations: [],
      });
    }

    const results: Array<Record<string, unknown>> = [];
    const issues: Array<Record<string, unknown>> = [];
    const summaryParts: string[] = [];
    const skippedCommands: string[] = [];
    let budget = this.config.maxAutoBuildCommands;

    for (const target of targets) {
      const adapters = await runAdapters(target.path);
      const buildCommands: string[] = [];
      for (const a of adapters) buildCommands.push(...a.build_commands);

      // Spend the shared command budget in scan order; anything past it is
      // reported as skipped rather than silently dropped. selectCommands (not
      // a raw slice) so a refused/dangerous command earlier in scan order
      // doesn't occupy a budget slot it never actually spends.
      const { toRun, skipped } = this.selectCommands(buildCommands, null, Math.max(budget, 0));
      skippedCommands.push(...skipped);

      const { results: buildResults, timeoutClamped, effectiveTimeoutSeconds } =
        await this.runRecognizedCommands(target.path, toRun, this.config.buildTimeoutSeconds);

      const partition = partitionResults(buildResults);
      const executed = executedCount(partition);
      // The budget exists to bound wall-clock time, so only builds that
      // actually ran spend it. Charging for a command the allowlist refused
      // would exhaust the budget on zero work and report the real builds
      // further down the scan as "skipped".
      budget -= executed;

      const buildStatus = executionStatus(buildResults, [], skipped);
      issues.push(
        ...this.outcomeIssues(
          target.name,
          partition,
          'build',
          effectiveTimeoutSeconds,
          timeoutClamped,
        ),
      );

      results.push({
        directory: target.name,
        ecosystems: target.ecosystems,
        status: buildStatus,
        build_commands: buildCommands,
        build_results: buildResults,
        skipped_commands: skipped,
        ...this.outcomeCounts(partition, timeoutClamped, effectiveTimeoutSeconds),
      });

      let part = `${target.name} (${partition.passed.length}/${executed} passed`;
      if (partition.timedOut.length > 0) part += `, ${partition.timedOut.length} timed out`;
      if (partition.refused.length > 0) part += `, ${partition.refused.length} refused`;
      if (partition.unavailable.length > 0) {
        part += `, ${partition.unavailable.length} tool not installed`;
      }
      if (skipped.length > 0) part += `, ${skipped.length} skipped`;
      summaryParts.push(`${part})`);
    }

    // Aggregate: ERROR if any directory failed, WARNING if any command was
    // refused, timed out or skipped, OK only if something actually built,
    // else UNKNOWN -- "Built 1 ecosystem(s): backend (0/0)" is not an `ok`.
    const statuses = new Set(results.map((r) => r['status']));
    let status: Status;
    if (statuses.has(Status.ERROR)) status = Status.ERROR;
    else if (statuses.has(Status.WARNING) || skippedCommands.length > 0) status = Status.WARNING;
    else if (statuses.has(Status.OK)) status = Status.OK;
    else status = Status.UNKNOWN;

    let summary = `Built ${results.length} ecosystem(s): ${summaryParts.join(', ')}`;
    if (skippedCommands.length > 0) {
      summary +=
        `. ${skippedCommands.length} command(s) skipped: ` +
        `at most ${this.config.maxAutoBuildCommands} builds run per call.`;
    }

    return this.record('devtwin_build_all', {
      status,
      summary,
      data: {
        ecosystems: results,
        max_build_commands: this.config.maxAutoBuildCommands,
        skipped_commands: skippedCommands,
      },
      issues,
      recommendations:
        skippedCommands.length > 0
          ? [
              `${skippedCommands.length} build command(s) were not run because of the ` +
                `${this.config.maxAutoBuildCommands}-build cap; build those directories ` +
                'individually with devtwin_build.',
            ]
          : [],
    });
  }

  /** devtwin_health_all */
  async healthAll(workspace: string): Promise<ToolResult> {
    const { path: root, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    this.applyEnvScope(root);
    if (!pathExists(root)) return this.missingWorkspace(root);

    const targets = this.monorepoTargets(root);
    if (targets.length === 0) {
      return this.record('devtwin_health_all', {
        status: Status.UNKNOWN,
        summary: 'No recognized ecosystems found in the workspace root or its subdirectories.',
        data: { ecosystems: [] },
        issues: [],
        recommendations: [],
      });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const target of targets) {
      const report = await computeHealth(target.path);
      results.push({
        directory: target.name,
        ecosystems: target.ecosystems,
        health_score: report.health_score,
        status: report.status,
        project_summary: report.project_summary,
        runtime_summary: report.runtime_summary,
        dependency_summary: report.dependency_summary,
        service_summary: report.service_summary,
        issues: report.issues,
        issue_count: report.issues.length,
        recommendations: report.recommendations,
        recommendation_count: report.recommendations.length,
      });
    }

    // Aggregate: ERROR if any subdirectory errored, WARNING if any warned, else OK.
    let status: Status = Status.OK;
    if (results.some((r) => r['status'] === Status.ERROR)) status = Status.ERROR;
    else if (results.some((r) => r['status'] === Status.WARNING)) status = Status.WARNING;

    const summary =
      `Checked ${results.length} ecosystem(s): ` +
      results.map((r) => `${String(r['directory'])} (${Number(r['health_score'])}/100)`).join(', ');

    const allIssues: Array<Record<string, unknown>> = [];
    const allRecommendations: string[] = [];
    for (const r of results) {
      const issues = r['issues'];
      if (Array.isArray(issues)) allIssues.push(...(issues as Array<Record<string, unknown>>));
      const recommendations = r['recommendations'];
      if (Array.isArray(recommendations)) allRecommendations.push(...(recommendations as string[]));
    }

    return this.record('devtwin_health_all', {
      status,
      summary,
      data: { ecosystems: results },
      issues: allIssues,
      recommendations: allRecommendations,
    });
  }

  /** devtwin_prepare -- plans only, never executes. */
  async prepare(workspace: string): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    const ws = await inspectWorkspace(path);
    if (!ws.exists) return this.missingWorkspace(path);

    this.applyEnvScope(path);
    const health = await computeHealth(path);
    const drift = await computeDrift(path);
    const adapters = await runAdapters(path);
    const services = await detectServices(path, this.dependencyNames(adapters));

    const steps: Array<Record<string, unknown>> = [];
    let order = 1;

    for (const item of drift.items) {
      steps.push({
        order: order++,
        action: `Align ${item.subject} to ${item.expected}`,
        action_class: ActionClass.READ_ONLY,
        detail: `Environment has ${item.actual}; project expects ${item.expected} (source: ${item.source}).`,
        command: null,
      });
    }

    const hasCompose =
      pathExists(join(path, 'compose.yaml')) || pathExists(join(path, 'docker-compose.yml'));

    for (const svc of services) {
      if (svc.required && !svc.running) {
        steps.push({
          order: order++,
          action: `Start ${svc.name}`,
          action_class: ActionClass.REQUIRES_APPROVAL,
          detail: `Expected on port ${svc.port}. Evidence: ${svc.source.join('; ')}`,
          command: hasCompose ? 'docker compose up -d' : null,
        });
      }
    }

    for (const a of adapters) {
      const deps = a.dependencies;
      if (deps && (deps.installed === 'not_installed' || deps.installed === 'unknown')) {
        let installCmd: string | null = null;
        if (a.ecosystem === 'python') {
          installCmd = deps.manager === 'uv' ? 'uv sync' : 'pip install -r requirements.txt';
        } else if (a.ecosystem === 'node') {
          const byManager: Record<string, string> = {
            npm: 'npm install',
            pnpm: 'pnpm install',
            yarn: 'yarn install',
            bun: 'bun install',
          };
          installCmd = byManager[deps.manager ?? 'npm'] ?? 'npm install';
        }
        if (installCmd) {
          steps.push({
            order: order++,
            action: `Install ${a.ecosystem} dependencies`,
            action_class: ActionClass.REQUIRES_APPROVAL,
            detail: `manager=${deps.manager}`,
            command: installCmd,
          });
        }
      }
    }

    for (const a of adapters) {
      for (const cmd of a.test_commands) {
        steps.push({
          order: order++,
          action: `Run ${a.ecosystem} checks`,
          action_class: ActionClass.SAFE,
          detail: 'Recognized check command; run it yourself or via devtwin_check.',
          command: cmd,
        });
      }
    }

    return this.record('devtwin_prepare', {
      status: steps.length > 0 ? Status.OK : Status.UNKNOWN,
      summary: `${steps.length}-step preparation plan generated. No changes have been made.`,
      data: { plan: steps, health_score: health.health_score },
      issues: [],
      recommendations: [
        "Review each step's action_class before executing anything requires_approval.",
      ],
    });
  }

  /** devtwin_precommit -- read-only commit-readiness summary. */
  async precommit(workspace: string): Promise<ToolResult> {
    const { path, denied } = this.openWorkspace(workspace);
    if (denied) return denied;

    const ws = await inspectWorkspace(path);
    if (!ws.exists) return this.missingWorkspace(path);

    this.applyEnvScope(path);
    const git = await inspectGit(path);
    const health = await computeHealth(path);

    if (!git.is_repo) {
      return this.record('devtwin_precommit', {
        status: Status.UNKNOWN,
        summary: 'Not a Git repository.',
        data: { git },
        issues: [],
        recommendations: [],
      });
    }

    const issues: Array<Record<string, unknown>> = [];

    if (git.has_conflicts) {
      issues.push({
        severity: 'high',
        code: 'git.merge_conflicts',
        title: 'Unresolved merge conflicts present',
        message: 'Resolve conflicts before committing.',
      });
    }

    const suspectStaged = git.staged_files.filter((f) =>
      SECRET_FILE_PATTERNS.some((pattern) => f.toLowerCase().includes(pattern)),
    );
    if (suspectStaged.length > 0) {
      issues.push({
        severity: 'critical',
        code: 'git.possible_secret_staged',
        title: 'Staged file(s) look like they may contain secrets',
        message: 'These filenames match common secret-file patterns.',
        evidence: suspectStaged,
        recommendation:
          'Unstage and review before committing; add to .gitignore if appropriate.',
      });
    }

    if (health.status !== Status.OK) {
      issues.push({
        severity: 'medium',
        code: 'health.not_ok',
        title: 'Project health is not fully healthy',
        message: `health_score=${health.health_score} (${health.status})`,
      });
    }

    const ready = git.is_repo && !git.has_conflicts && suspectStaged.length === 0;

    return this.record('devtwin_precommit', {
      status: ready ? Status.OK : Status.WARNING,
      summary: ready
        ? 'Looks ready to commit.'
        : 'Some items need attention before committing.',
      data: {
        git,
        health_score: health.health_score,
        staged_count: git.staged_files.length,
        unstaged_count: git.unstaged_files.length,
        untracked_count: git.untracked_files.length,
      },
      issues,
      recommendations: [],
    });
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Everything a workspace-scoped tool needs before it touches the disk: the
   * single absolute path the whole call operates on, plus the refusal that
   * stops the call when that path is outside the allowlist.
   *
   * Resolving exactly once is the point. While the guard resolved the
   * argument but the inspection re-resolved the caller's RAW string further
   * down, an omitted workspace was checked as `defaultWorkspace` -- and
   * approved -- then read as `process.cwd()`, a directory the allowlist never
   * approved. Every method below takes `path` from here and passes that same
   * value to the guard, the env scope, the core functions and the adapters.
   */
  private openWorkspace(workspace: string): { path: string; denied: ToolResult | null } {
    const path = this.resolveWorkspace(workspace);
    return { path, denied: this.guardWorkspace(path) };
  }

  /**
   * Point the environment checks at this workspace before any adapter or
   * service detector runs. Without this they would fall back to an empty
   * project environment. Takes the already-resolved path, so it can never
   * scope the environment to a different directory than the one inspected.
   */
  private applyEnvScope(path: string): void {
    configureEnvSource({
      allowHostEnv: this.config.allowHostEnvironment,
      workspace: path,
    });
  }

  private dependencyNames(adapters: AdapterResult[]): Set<string> {
    const names = new Set<string>();
    for (const a of adapters) {
      if (a.dependencies) for (const note of a.dependencies.notes) names.add(note);
    }
    return names;
  }

  /**
   * Directories the monorepo scans should visit: the workspace root itself
   * (labelled `.`) first, then each configured subdirectory. Without the root,
   * a single-package repository reported "no recognized ecosystems" for a
   * project sitting right there. Resolved paths are de-duplicated so a
   * symlinked subdirectory is never scanned -- or built -- twice.
   */
  private monorepoTargets(
    root: string,
  ): Array<{ name: string; path: string; ecosystems: string[] }> {
    const candidates: Array<[string, string]> = [
      [ROOT_DIR_LABEL, root],
      ...this.config.monorepoDirectories.map(
        (subdir): [string, string] => [subdir, join(root, subdir)],
      ),
    ];

    const targets: Array<{ name: string; path: string; ecosystems: string[] }> = [];
    const seen = new Set<string>();
    for (const [name, path] of candidates) {
      if (!isDirectory(path)) continue;
      const resolved = realPath(path);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const profile = detectProject(resolved);
      if (profile.ecosystems.length > 0) {
        targets.push({ name, path: resolved, ecosystems: profile.ecosystems });
      }
    }
    return targets;
  }

  /** Wire-shape counts for a set of command outcomes, shared by every executing tool. */
  private outcomeCounts(
    partition: OutcomePartition,
    timeoutClamped: boolean,
    effectiveTimeoutSeconds: number,
  ): Record<string, unknown> {
    return {
      executed_count: executedCount(partition),
      passed_count: partition.passed.length,
      failed_count: partition.failed.length,
      refused_count: partition.refused.length,
      refused_commands: partition.refused.map((r) => r.command),
      unavailable_count: partition.unavailable.length,
      timed_out_count: partition.timedOut.length,
      timeout_clamped: timeoutClamped,
      effective_timeout_seconds: effectiveTimeoutSeconds,
    };
  }

  /** Issues for the outcomes that never produced a pass or a failure. */
  private outcomeIssues(
    directory: string,
    partition: OutcomePartition,
    kind: string,
    effectiveTimeoutSeconds: number,
    timeoutClamped: boolean,
  ): Array<Record<string, unknown>> {
    const issues: Array<Record<string, unknown>> = [];
    if (partition.refused.length > 0) {
      issues.push(refusedIssue(directory, partition.refused, kind));
    }
    if (partition.timedOut.length > 0) {
      issues.push(
        timedOutIssue(
          directory,
          partition.timedOut,
          kind,
          effectiveTimeoutSeconds,
          timeoutClamped,
        ),
      );
    }
    return issues;
  }

  /** Whether `command` would pass the allowlist -- checked without running it. */
  private isRunnable(command: string): boolean {
    return this.allowedArgs(command) !== null;
  }

  /** Split and allowlist-check a command in one place, reused by selection and execution. */
  private allowedArgs(command: string): string[] | null {
    const args = splitCommand(command);
    if (args.length === 0 || !isAllowedExecutable(args[0]!) || isDangerous(args)) return null;
    return args;
  }

  /**
   * Decide what to execute from `recognized`, honouring an explicit `run`.
   *
   * Three rules a naive membership filter gets wrong:
   *
   * - `rejected` is computed against the FULL recognized list, before any cap,
   *   so a command the cap drops is never reported as "unrecognized" -- that
   *   tells the caller it does not exist and they stop asking for it.
   * - A repeated name in `run` is collapsed. Membership-filtering `run`
   *   against the recognized list matches every repeat, so
   *   `run: [cmd, cmd, cmd]` would otherwise run `cmd` three times against a
   *   cap of one.
   * - Only commands that would really spawn a process spend the budget. A
   *   refusal costs nothing, so letting one consume the window pushes a real
   *   command into "skipped" while the budget sits unused.
   */
  private selectCommands(
    recognized: string[],
    run: string[] | null | undefined,
    budget: number,
  ): { toRun: string[]; skipped: string[]; rejected: string[] } {
    let selected: string[];
    let rejected: string[];

    if (run && run.length > 0) {
      rejected = run.filter((c) => !recognized.includes(c));
      const seen = new Set<string>();
      selected = [];
      for (const candidate of run) {
        if (recognized.includes(candidate) && !seen.has(candidate)) {
          seen.add(candidate);
          selected.push(candidate);
        }
      }
    } else {
      rejected = [];
      selected = [...recognized];
    }

    const toRun: string[] = [];
    const skipped: string[] = [];
    let used = 0;
    for (const command of selected) {
      if (!this.isRunnable(command)) {
        toRun.push(command); // free: yields a refusal entry, spawns nothing
      } else if (used < budget) {
        toRun.push(command);
        used += 1;
      } else {
        skipped.push(command);
      }
    }

    return { toRun, skipped, rejected };
  }

  /** Execute an already-selected command list. Selection happens in `selectCommands`. */
  private async runRecognizedCommands(
    path: string,
    commands: string[],
    timeoutSeconds: number,
  ): Promise<{
    results: CommandOutcome[];
    timeoutClamped: boolean;
    effectiveTimeoutSeconds: number;
  }> {
    const budget = this.config.platformTimeoutBudgetSeconds;
    const effectiveTimeout = Math.min(timeoutSeconds, budget);
    const clamped = effectiveTimeout < timeoutSeconds;

    const results: CommandOutcome[] = [];
    for (const commandStr of commands) {
      const args = this.allowedArgs(commandStr);
      if (args === null) {
        results.push({
          command: commandStr,
          executed: false,
          reason: "not in DevTwin's allowlist of recognized commands",
        });
        continue;
      }

      const outcome = await runCommand(args, { cwd: path, timeout: effectiveTimeout });
      results.push({
        command: commandStr,
        executed: true,
        result: this.trimOutput(outcome),
        passed: outcome.available && outcome.returncode === 0,
        ...(clamped ? { timeout_clamped: true } : {}),
      });
    }

    return { results, timeoutClamped: clamped, effectiveTimeoutSeconds: effectiveTimeout };
  }

  /** Keep a single command's captured output inside the configured ceiling. */
  private trimOutput(result: CommandResult): CommandResult {
    const max = this.config.maxOutputChars;
    if (result.stdout.length <= max && result.stderr.length <= max) return result;
    return {
      ...result,
      stdout: result.stdout.slice(0, max),
      stderr: result.stderr.slice(0, max),
    };
  }

  /**
   * Expand `~`, resolve to absolute, follow symlinks -- the
   * Path(...).expanduser().resolve() equivalent.
   *
   * A falsy `workspace` means the caller omitted the argument, which is what
   * makes `defaultWorkspace` reachable. Symlinks are followed here rather
   * than only inside `guardWorkspace`, so the path the guard approves is
   * byte-for-byte the path everything downstream reads, and `workspace.root`
   * (which realpaths) can never disagree with `profile.root` (which does not).
   */
  private resolveWorkspace(workspace: string): string {
    return realPath(resolve(expandUser(workspace || this.config.defaultWorkspace)));
  }

  private workspaceAllowlist(): string[] {
    return this.config.allowedWorkspaceRoots
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => resolve(expandUser(s)));
  }

  /**
   * Refuse workspaces outside the configured roots. Empty allowlist means no
   * restriction; when set, the path must be inside one of the roots. Both
   * sides are resolved through symlinks first, so neither `../` nor a symlink
   * planted inside an allowed root can point out of it.
   *
   * Takes the path `resolveWorkspace` already produced -- never a raw
   * argument -- so the directory approved here is the directory inspected.
   */
  private guardWorkspace(path: string): ToolResult | null {
    const roots = this.workspaceAllowlist().map((root) => realPath(root));
    if (roots.length === 0) return null;

    const allowed = roots.some((root) => path === root || path.startsWith(root + sep));
    if (allowed) return null;

    return {
      status: Status.ERROR,
      summary: 'Workspace is outside the configured allowedWorkspaceRoots.',
      data: { workspace: path, allowed: false },
      issues: [],
      recommendations: ['Ask an administrator to add this path to allowedWorkspaceRoots.'],
    };
  }

  private guardExecution(): ToolResult | null {
    if (this.config.enableCommandExecution) return null;
    return {
      status: Status.UNKNOWN,
      summary: 'Command execution is disabled by configuration.',
      data: { command_execution_enabled: false },
      issues: [],
      recommendations: ['Enable enableCommandExecution to run recognized project commands.'],
    };
  }

  /** `path` is the resolved workspace, so the message names the directory actually looked for. */
  private missingWorkspace(path: string): ToolResult {
    return {
      status: Status.ERROR,
      summary: `Workspace '${path}' does not exist.`,
      data: {},
      issues: [],
      recommendations: [],
    };
  }

  /** Config as shown to callers. DevTwin holds no credentials, so nothing is redacted. */
  private publicConfig(): Record<string, unknown> {
    return { ...this.config } as Record<string, unknown>;
  }

  /**
   * Append to the activity log and enforce the response-size ceiling, so a
   * huge build log can never push a tool result past the platform limit.
   */
  private record(tool: string, result: ToolResult): ToolResult {
    this.logs.push({
      timestamp: new Date().toISOString(),
      tool,
      status: result.status,
      summary: result.summary,
      duration_ms: 0,
    });
    if (this.logs.length > this.config.logRetentionEntries) {
      this.logs = this.logs.slice(-this.config.logRetentionEntries);
    }
    this.emit('tool_result', { tool, status: result.status });
    return this.enforceResponseSize(result);
  }

  private enforceResponseSize(result: ToolResult): ToolResult {
    let serialized: string;
    try {
      serialized = JSON.stringify(result);
    } catch {
      return result;
    }
    if (Buffer.byteLength(serialized, 'utf8') <= this.config.maxResponseBytes) return result;

    // Command output is the only field that grows without bound. It lives
    // under `results` for the single-directory tools and under
    // `ecosystems[].build_results` for the monorepo ones -- trim both, and
    // only claim an omission if something was actually trimmed.
    const data: Record<string, unknown> = { ...result.data };
    let trimmedAnything = false;

    const results = data['results'];
    if (Array.isArray(results)) {
      data['results'] = trimOutcomes(results as CommandOutcome[]);
      trimmedAnything = true;
    }

    const ecosystems = data['ecosystems'];
    if (Array.isArray(ecosystems)) {
      data['ecosystems'] = (ecosystems as Array<Record<string, unknown>>).map((entry) => {
        const buildResults = entry['build_results'];
        if (!Array.isArray(buildResults)) return entry;
        trimmedAnything = true;
        return { ...entry, build_results: trimOutcomes(buildResults as CommandOutcome[]) };
      });
    }

    if (!trimmedAnything) {
      // Nothing here is command output, so there is nothing safe to drop.
      // Say that plainly rather than claiming a trim that did not happen.
      return {
        ...result,
        summary: `${result.summary} (response exceeds the size limit)`,
        data: { ...data, response_oversized: true },
      };
    }

    return {
      ...result,
      data: { ...data, output_omitted: true },
      summary: `${result.summary} (large command output omitted to stay within the response size limit)`,
    };
  }
}

/** Trim the captured output of each command outcome to a small excerpt. */
function trimOutcomes(outcomes: CommandOutcome[]): CommandOutcome[] {
  return outcomes.map((r) =>
    r.result
      ? { ...r, result: { ...r.result, stdout: r.result.stdout.slice(0, 2000), stderr: '' } }
      : r,
  );
}

/**
 * Resolve symlinks. Falls back to the lexical path when it does not exist --
 * a non-existent path is reported as missing by the caller anyway.
 */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Expand a leading `~` the way Python's Path.expanduser() does. */
function expandUser(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : p;
}

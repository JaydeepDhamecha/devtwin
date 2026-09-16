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
    const workspace = this.config.defaultWorkspace;
    let workspaceReadable = false;
    try {
      workspaceReadable = pathExists(resolve(expandUser(workspace)));
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
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    const ws = await inspectWorkspace(workspace);
    if (!ws.exists) return this.missingWorkspace(workspace);

    const profile = detectProject(workspace);
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
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    this.applyEnvScope(workspace);
    const report = await computeHealth(workspace);
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
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    this.applyEnvScope(workspace);
    const report = await computeDrift(workspace);
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
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    this.applyEnvScope(workspace);
    const report = await diagnoseFailure(workspace, errorMessage, command ?? null);
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
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    const ws = await inspectWorkspace(workspace);
    if (!ws.exists) return this.missingWorkspace(workspace);

    const path = this.applyEnvScope(workspace);
    const profile = detectProject(workspace);
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
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    const ws = await inspectWorkspace(workspace);
    if (!ws.exists) return this.missingWorkspace(workspace);

    const path = this.applyEnvScope(workspace);
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
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    const ws = await inspectWorkspace(workspace);
    if (!ws.exists) return this.missingWorkspace(workspace);

    const path = this.applyEnvScope(workspace);
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
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    const disabled = this.guardExecution();
    if (disabled) return disabled;

    const ws = await inspectWorkspace(workspace);
    if (!ws.exists) return this.missingWorkspace(workspace);

    const path = this.applyEnvScope(workspace);
    const adapters = await runAdapters(path);

    const recognized: string[] = [];
    for (const a of adapters) recognized.push(...a.test_commands);

    // Without an explicit selection only the first N run; with one, the full
    // recognized list is the allowlist the selection is checked against.
    const candidates =
      run && run.length > 0 ? recognized : recognized.slice(0, this.config.maxAutoCheckCommands);

    const { results, rejected } = await this.runRecognizedCommands(
      path,
      candidates,
      this.config.checkTimeoutSeconds,
      run,
    );

    const failed = results.filter((r) => r.executed && !r.passed);
    const status =
      failed.length > 0 ? Status.ERROR : results.length > 0 ? Status.OK : Status.UNKNOWN;

    return this.record('devtwin_check', {
      status,
      summary:
        results.length > 0
          ? `Ran ${results.length} check(s), ${failed.length} failed.`
          : 'No recognized check commands were found for this project.',
      data: { recognized_commands: recognized, results, rejected },
      issues: [],
      recommendations: [],
    });
  }

  /** devtwin_build */
  async build(workspace: string, run?: string[] | null): Promise<ToolResult> {
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    const disabled = this.guardExecution();
    if (disabled) return disabled;

    const ws = await inspectWorkspace(workspace);
    if (!ws.exists) return this.missingWorkspace(workspace);

    const path = this.applyEnvScope(workspace);
    const adapters = await runAdapters(path);

    const recognized: string[] = [];
    for (const a of adapters) recognized.push(...a.build_commands);

    const { results, rejected } = await this.runRecognizedCommands(
      path,
      recognized,
      this.config.buildTimeoutSeconds,
      run,
    );

    const failed = results.filter((r) => r.executed && !r.passed);
    const status =
      failed.length > 0 ? Status.ERROR : results.length > 0 ? Status.OK : Status.UNKNOWN;

    return this.record('devtwin_build', {
      status,
      summary:
        results.length > 0
          ? `Ran ${results.length} build(s), ${failed.length} failed.`
          : 'No recognized build commands were found for this project.',
      data: { recognized_commands: recognized, results, rejected },
      issues: [],
      recommendations: [],
    });
  }

  /** devtwin_build_all */
  async buildAll(workspace: string): Promise<ToolResult> {
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    const disabled = this.guardExecution();
    if (disabled) return disabled;

    const root = this.applyEnvScope(workspace);
    if (!pathExists(root)) return this.missingWorkspace(workspace);

    const targets = this.monorepoTargets(root);
    if (targets.length === 0) {
      return this.record('devtwin_build_all', {
        status: Status.UNKNOWN,
        summary: 'No recognized ecosystems found in subdirectories.',
        data: { ecosystems: [] },
        issues: [],
        recommendations: [],
      });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const target of targets) {
      const adapters = await runAdapters(target.path);
      const buildCommands: string[] = [];
      for (const a of adapters) buildCommands.push(...a.build_commands);

      const { results: buildResults } = await this.runRecognizedCommands(
        target.path,
        buildCommands,
        this.config.buildTimeoutSeconds,
      );
      const failedBuilds = buildResults.filter((r) => r.executed && !r.passed);
      const buildStatus =
        failedBuilds.length > 0
          ? Status.ERROR
          : buildResults.length > 0
            ? Status.OK
            : Status.UNKNOWN;

      results.push({
        directory: target.name,
        ecosystems: target.ecosystems,
        status: buildStatus,
        build_commands: buildCommands,
        build_results: buildResults,
        passed_count: buildResults.filter((r) => r.passed).length,
        failed_count: failedBuilds.length,
      });
    }

    const status = results.some((r) => r['status'] === Status.ERROR) ? Status.ERROR : Status.OK;
    const summary =
      `Built ${results.length} ecosystem(s): ` +
      results
        .map((r) => {
          const passed = Number(r['passed_count'] ?? 0);
          const failed = Number(r['failed_count'] ?? 0);
          return `${String(r['directory'])} (${passed}/${passed + failed})`;
        })
        .join(', ');

    return this.record('devtwin_build_all', {
      status,
      summary,
      data: { ecosystems: results },
      issues: [],
      recommendations: [],
    });
  }

  /** devtwin_health_all */
  async healthAll(workspace: string): Promise<ToolResult> {
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    const root = this.applyEnvScope(workspace);
    if (!pathExists(root)) return this.missingWorkspace(workspace);

    const targets = this.monorepoTargets(root);
    if (targets.length === 0) {
      return this.record('devtwin_health_all', {
        status: Status.UNKNOWN,
        summary: 'No recognized ecosystems found in subdirectories.',
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
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    const ws = await inspectWorkspace(workspace);
    if (!ws.exists) return this.missingWorkspace(workspace);

    const path = this.applyEnvScope(workspace);
    const health = await computeHealth(workspace);
    const drift = await computeDrift(workspace);
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
    const guard = this.guardWorkspace(workspace);
    if (guard) return guard;

    const ws = await inspectWorkspace(workspace);
    if (!ws.exists) return this.missingWorkspace(workspace);

    const path = this.applyEnvScope(workspace);
    const git = await inspectGit(path);
    const health = await computeHealth(workspace);

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
   * Point the environment checks at this workspace before any adapter or
   * service detector runs. Without this they would fall back to an empty
   * project environment.
   */
  private applyEnvScope(workspace: string): string {
    const path = this.resolveWorkspace(workspace);
    configureEnvSource({
      allowHostEnv: this.config.allowHostEnvironment,
      workspace: path,
    });
    return path;
  }

  private dependencyNames(adapters: AdapterResult[]): Set<string> {
    const names = new Set<string>();
    for (const a of adapters) {
      if (a.dependencies) for (const note of a.dependencies.notes) names.add(note);
    }
    return names;
  }

  private monorepoTargets(
    root: string,
  ): Array<{ name: string; path: string; ecosystems: string[] }> {
    const targets: Array<{ name: string; path: string; ecosystems: string[] }> = [];
    for (const subdir of this.config.monorepoDirectories) {
      const path = join(root, subdir);
      if (!isDirectory(path)) continue;
      const profile = detectProject(path);
      if (profile.ecosystems.length > 0) {
        targets.push({ name: subdir, path, ecosystems: profile.ecosystems });
      }
    }
    return targets;
  }

  /**
   * Run recognized commands, respecting the allowlist.
   *
   * `candidates` is the set DevTwin itself discovered; `run` is the caller's
   * optional subset of it. A command the caller names that is not in
   * `candidates` is rejected, never executed -- there is no path from
   * caller-supplied text to a spawned process.
   */
  private async runRecognizedCommands(
    path: string,
    candidates: string[],
    timeoutSeconds: number,
    run?: string[] | null,
  ): Promise<{ results: CommandOutcome[]; rejected: string[] }> {
    let toRun: string[];
    let rejected: string[] = [];

    if (run && run.length > 0) {
      toRun = run.filter((c) => candidates.includes(c));
      rejected = run.filter((c) => !candidates.includes(c));
    } else {
      toRun = candidates;
    }

    const budget = this.config.platformTimeoutBudgetSeconds;
    const effectiveTimeout = Math.min(timeoutSeconds, budget);
    const clamped = effectiveTimeout < timeoutSeconds;

    const results: CommandOutcome[] = [];
    for (const commandStr of toRun) {
      const args = splitCommand(commandStr);
      if (args.length === 0 || !isAllowedExecutable(args[0]!) || isDangerous(args)) {
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

    return { results, rejected };
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

  /** Expand `~`, resolve to absolute -- the Path(...).expanduser().resolve() equivalent. */
  private resolveWorkspace(workspace: string): string {
    return resolve(expandUser(workspace || this.config.defaultWorkspace));
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
   */
  private guardWorkspace(workspace: string): ToolResult | null {
    const roots = this.workspaceAllowlist().map((root) => realPath(root));
    if (roots.length === 0) return null;

    const target = realPath(this.resolveWorkspace(workspace));
    const allowed = roots.some((root) => target === root || target.startsWith(root + sep));
    if (allowed) return null;

    return {
      status: Status.ERROR,
      summary: 'Workspace is outside the configured allowedWorkspaceRoots.',
      data: { workspace, allowed: false },
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

  private missingWorkspace(workspace: string): ToolResult {
    return {
      status: Status.ERROR,
      summary: `Workspace '${workspace}' does not exist.`,
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

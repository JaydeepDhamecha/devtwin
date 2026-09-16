/**
 * Health scoring engine: combines detection, runtime, dependency, service,
 * and Git signals into one transparent score with concrete issues.
 *
 * Scoring is intentionally simple and documented so it's testable and so no
 * single optional/missing tool can tank the whole score by itself: each issue
 * subtracts a fixed amount based on severity, floored at 0.
 */

import { ADAPTERS, GENERIC_ADAPTER } from '../adapters/index.js';
import { versionMismatch } from '../adapters/base.js';
import { detectProject } from './detector.js';
import {
  Severity,
  Status,
  type AdapterResult,
  type HealthIssue,
  type HealthReport,
  type ServiceInfo,
} from './models.js';
import { inspectWorkspace } from './workspace.js';
import { detectServices } from '../services/index.js';

export const SEVERITY_PENALTY: Record<Severity, number> = {
  [Severity.INFO]: 0,
  [Severity.LOW]: 3,
  [Severity.MEDIUM]: 8,
  [Severity.HIGH]: 15,
  [Severity.CRITICAL]: 25,
};

function dependencyNames(adapterResults: AdapterResult[]): Set<string> {
  const names = new Set<string>();
  for (const result of adapterResults) {
    for (const note of result.dependencies ? result.dependencies.notes : []) {
      names.add(note);
    }
  }
  return names;
}

export async function runAdapters(root: string): Promise<AdapterResult[]> {
  // Adapters are independent: run them concurrently, but keep the registry's
  // order in the results so output stays deterministic.
  const results = await Promise.all(ADAPTERS.map((a) => a.run(root)));
  const applicable = results.filter((r) => r.applicable);
  if (applicable.length === 0) {
    const genericResult = await GENERIC_ADAPTER.run(root);
    return [genericResult];
  }
  return applicable;
}

function score(issues: HealthIssue[]): number {
  let value = 100;
  for (const issue of issues) {
    value -= SEVERITY_PENALTY[issue.severity] ?? 0;
  }
  return Math.max(0, Math.min(100, value));
}

function statusForScore(value: number): Status {
  if (value >= 90) return Status.OK;
  if (value >= 50) return Status.WARNING;
  return Status.ERROR;
}

export async function computeHealth(root: string): Promise<HealthReport> {
  const profile = detectProject(root);
  const workspace = await inspectWorkspace(root);
  const path = workspace.root;

  const issues: HealthIssue[] = [];
  const recommendations: string[] = [];

  if (!workspace.exists) {
    issues.push({
      severity: Severity.CRITICAL,
      code: 'workspace.not_found',
      title: 'Workspace path does not exist',
      message: `'${root}' could not be found on disk.`,
      evidence: [`path checked: ${workspace.root}`],
      recommendation: 'Verify the workspace path passed to DevTwin.',
      confidence: null,
    });
    return {
      health_score: 0,
      status: Status.ERROR,
      project_summary: 'Workspace not found',
      runtime_summary: 'unknown',
      service_summary: 'unknown',
      dependency_summary: 'unknown',
      issues,
      recommendations: ['Point DevTwin at a valid, existing directory.'],
    };
  }

  const adapterResults = await runAdapters(path);

  const runtimeLines: string[] = [];
  for (const result of adapterResults) {
    issues.push(...result.issues);
    for (const rt of result.runtimes) {
      runtimeLines.push(`${rt.name}=${rt.installed_version || rt.presence}`);
      if (
        rt.required_version &&
        rt.installed_version &&
        versionMismatch(rt.required_version, rt.installed_version)
      ) {
        issues.push({
          severity: Severity.MEDIUM,
          code: `${result.ecosystem}.runtime_drift`,
          title: `${rt.name} version differs from project requirement`,
          message:
            `Project requires ${rt.name} ${rt.required_version} ` +
            `(from ${rt.source}), but ${rt.installed_version} is installed.`,
          evidence: [
            `required=${rt.required_version}`,
            `installed=${rt.installed_version}`,
          ],
          recommendation: `Install/switch to ${rt.name} ${rt.required_version}.`,
          confidence: null,
        });
      }
    }
    for (const depNote of result.dependencies ? result.dependencies.notes : []) {
      if (depNote.includes('not found') || depNote.includes('may not be installed')) {
        issues.push({
          severity: Severity.LOW,
          code: `${result.ecosystem}.dependencies_not_installed`,
          title: 'Dependencies may not be installed',
          message: depNote,
          evidence: [depNote],
          recommendation: "Run the ecosystem's install command before building or testing.",
          confidence: null,
        });
      }
    }
  }

  const depNames = dependencyNames(adapterResults);
  let services: ServiceInfo[] = [];
  try {
    services = await detectServices(path, depNames);
  } catch {
    // Service detection is best-effort metadata; never let it break health.
    services = [];
  }
  for (const svc of services) {
    if (svc.required && !svc.running) {
      issues.push({
        severity: Severity.HIGH,
        code: 'service.not_running',
        title: `${svc.name} appears required but is not running`,
        message:
          `Detected signals suggesting '${svc.name}' is required ` +
          `(confidence=${svc.required_confidence}), but port ${svc.port} is not listening.`,
        evidence: svc.source,
        recommendation: `Start ${svc.name} (e.g. via docker compose or a local install).`,
        confidence: svc.required_confidence,
      });
    }
  }

  if (workspace.git && workspace.git.is_repo && workspace.git.has_conflicts) {
    issues.push({
      severity: Severity.HIGH,
      code: 'git.merge_conflicts',
      title: 'Unresolved merge conflicts',
      message: 'Git status shows unmerged paths.',
      evidence: [...workspace.git.staged_files, ...workspace.git.unstaged_files].slice(0, 10),
      recommendation: 'Resolve conflicts before continuing.',
      confidence: null,
    });
  }

  const healthScore = score(issues);
  const status = statusForScore(healthScore);

  const uniqueRecommendations = new Set<string>();
  for (const issue of issues) {
    if (issue.recommendation) uniqueRecommendations.add(issue.recommendation);
  }
  recommendations.push(...[...uniqueRecommendations].sort());

  const ecosystems = profile.ecosystems.length > 0 ? profile.ecosystems.join(', ') : 'unrecognized';
  const projectSummary = `${profile.primary_ecosystem || 'generic'} project (detected: ${ecosystems})`;
  const runtimeSummary = runtimeLines.length > 0 ? runtimeLines.join(', ') : 'no runtimes inspected';
  const serviceSummary =
    services.length > 0
      ? services.map((s) => `${s.name}=${s.running ? 'running' : 'stopped'}`).join(', ')
      : 'no required services detected';
  const depSummaryParts: string[] = [];
  for (const result of adapterResults) {
    if (result.dependencies) {
      depSummaryParts.push(
        `${result.ecosystem}:${result.dependencies.manager || 'unknown manager'}`
      );
    }
  }
  const dependencySummary =
    depSummaryParts.length > 0 ? depSummaryParts.join(', ') : 'no dependency manifests found';

  return {
    health_score: healthScore,
    status,
    project_summary: projectSummary,
    runtime_summary: runtimeSummary,
    service_summary: serviceSummary,
    dependency_summary: dependencySummary,
    issues,
    recommendations,
  };
}

/** Drift engine: expected project state vs. actual local state. */

import { versionMismatch } from '../adapters/base.js';
import { runAdapters } from './health.js';
import { Presence, Severity, type DriftItem, type DriftReport } from './models.js';
import { inspectWorkspace } from './workspace.js';

export async function computeDrift(root: string): Promise<DriftReport> {
  const workspace = await inspectWorkspace(root);
  if (!workspace.exists) {
    return { has_drift: false, items: [], summary: `Workspace '${root}' does not exist.` };
  }

  const path = workspace.root;
  const adapterResults = await runAdapters(path);

  const items: DriftItem[] = [];

  for (const result of adapterResults) {
    for (const rt of result.runtimes) {
      if (!rt.required_version) continue;
      if (rt.presence === Presence.NOT_INSTALLED) {
        items.push({
          subject: rt.name,
          expected: rt.required_version,
          actual: 'not installed',
          source: rt.source || 'detected requirement',
          severity: Severity.CRITICAL,
        });
        continue;
      }
      if (!rt.installed_version) continue;
      if (versionMismatch(rt.required_version, rt.installed_version)) {
        items.push({
          subject: rt.name,
          expected: rt.required_version,
          actual: rt.installed_version,
          source: rt.source || 'detected requirement',
          severity: Severity.MEDIUM,
        });
      }
    }

    for (const tool of result.build_tools) {
      if (
        tool.required_version &&
        tool.installed_version &&
        versionMismatch(tool.required_version, tool.installed_version)
      ) {
        items.push({
          subject: tool.name,
          expected: tool.required_version,
          actual: tool.installed_version,
          source: tool.source || 'detected requirement',
          severity: Severity.MEDIUM,
        });
      }
    }
  }

  const hasDrift = items.length > 0;
  const summary = hasDrift
    ? `${items.length} drift item(s) found between project requirements and the local environment.`
    : 'No drift detected between project requirements and the local environment.';

  return { has_drift: hasDrift, items, summary };
}

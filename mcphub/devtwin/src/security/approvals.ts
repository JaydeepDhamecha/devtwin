/**
 * Action classification for anything that isn't a pure read.
 *
 * Every step DevTwin proposes (in `dev_prepare` plans, mainly) carries an
 * `ActionClass` so a calling agent -- or the human behind it -- can decide
 * what's safe to auto-run versus what needs a human to say "yes".
 * DevTwin itself never escalates a plan step into an execution; it only
 * classifies and describes.
 */

import { ActionClass, type Capability } from '../core/models.js';

export const READ_ONLY_TOOLS = new Set([
  'dev_detect',
  'dev_health',
  'dev_drift',
  'dev_explain_failure',
  'dev_project_info',
  'dev_dependencies',
  'dev_services',
  'dev_precommit',
]);

// dev_check and dev_prepare execute recognized, allowlisted commands
// (tests/build/lint) -- "safe" in the sense of non-destructive, but not
// purely read-only since they may leave build artifacts behind.
export const SAFE_EXECUTION_TOOLS = new Set(['dev_check']);

// dev_prepare only plans by default; it never executes without a separate,
// explicit human approval step outside of this plugin's scope.
export const PLANNING_TOOLS = new Set(['dev_prepare']);

export function classifyTool(toolName: string): ActionClass {
  if (READ_ONLY_TOOLS.has(toolName)) return ActionClass.READ_ONLY;
  if (SAFE_EXECUTION_TOOLS.has(toolName)) return ActionClass.SAFE;
  if (PLANNING_TOOLS.has(toolName)) return ActionClass.READ_ONLY; // planning itself never mutates
  return ActionClass.REQUIRES_APPROVAL;
}

export function capabilityTable(): Capability[] {
  const caps: Capability[] = [];
  for (const name of [...READ_ONLY_TOOLS].sort()) {
    caps.push({ name, action_class: ActionClass.READ_ONLY, description: '' });
  }
  for (const name of [...SAFE_EXECUTION_TOOLS].sort()) {
    caps.push({
      name,
      action_class: ActionClass.SAFE,
      description:
        'Runs recognized, allowlisted project commands (tests/build/lint) with a timeout.',
    });
  }
  for (const name of [...PLANNING_TOOLS].sort()) {
    caps.push({
      name,
      action_class: ActionClass.READ_ONLY,
      description: 'Produces a plan only; never executes or mutates the machine.',
    });
  }
  return caps;
}

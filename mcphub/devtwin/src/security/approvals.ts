/**
 * Action classification for anything that isn't a pure read.
 *
 * Every step DevTwin proposes (in `devtwin_prepare` plans, mainly) carries an
 * `ActionClass` so a calling agent -- or the human behind it -- can decide
 * what's safe to auto-run versus what needs a human to say "yes".
 * DevTwin itself never escalates a plan step into an execution; it only
 * classifies and describes.
 *
 * The names here are this plugin's `devtwin_*` tool names, not the upstream
 * Python server's `dev_*` ones: an unrecognized name falls through to
 * REQUIRES_APPROVAL, so a stale name turns every read into an approval prompt.
 * `classifiedToolNames()` exists so a test can hold this file to `tools.ts`.
 */

import { ActionClass, type Capability } from '../core/models.js';

export const READ_ONLY_TOOLS = new Set([
  'devtwin_detect',
  'devtwin_health',
  'devtwin_health_all',
  'devtwin_drift',
  'devtwin_explain_failure',
  'devtwin_project_info',
  'devtwin_dependencies',
  'devtwin_services',
  'devtwin_precommit',
  // Settings tools that only report: DevTwin's own state, never the project's.
  'devtwin_status',
  'devtwin_health_check',
  'devtwin_get_logs',
]);

// devtwin_check, devtwin_build and devtwin_build_all execute recognized,
// allowlisted commands (tests/build/lint) -- "safe" in the sense of
// non-destructive, but not purely read-only since they may leave build
// artifacts behind.
export const SAFE_EXECUTION_TOOLS = new Set([
  'devtwin_check',
  'devtwin_build',
  'devtwin_build_all',
]);

// devtwin_prepare only plans by default; it never executes without a separate,
// explicit human approval step outside of this plugin's scope.
export const PLANNING_TOOLS = new Set(['devtwin_prepare']);

// Writing or clearing DevTwin's own settings changes what later calls are
// allowed to do (workspace roots, command execution), so it is never automatic.
export const CONFIGURATION_TOOLS = new Set(['devtwin_configure', 'devtwin_remove']);

/** Every tool with an explicit classification; `tools.ts` must match this set. */
export function classifiedToolNames(): string[] {
  return [
    ...READ_ONLY_TOOLS,
    ...SAFE_EXECUTION_TOOLS,
    ...PLANNING_TOOLS,
    ...CONFIGURATION_TOOLS,
  ];
}

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
  for (const name of [...CONFIGURATION_TOOLS].sort()) {
    caps.push({
      name,
      action_class: ActionClass.REQUIRES_APPROVAL,
      description: "Changes DevTwin's own configuration; never touches the project.",
    });
  }
  return caps;
}

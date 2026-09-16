/**
 * Tool call routing.
 *
 * Handlers stay thin: read the arguments defensively, hand off to the
 * manager, and wrap whatever comes back in the MCP response envelope. No
 * business logic lives here.
 */

import type { McpContext, McpToolResponse } from '@mcphub/core/src/mcp/plugin.interface.js';

import type { ToolResult } from './core/models.js';
import type { DevTwinManager } from './devtwin.manager.js';
import { tools } from './tools.js';

const KNOWN_TOOLS = new Set(tools.map((tool) => tool.name));

/** Serialize a DevTwin result into the MCP text-content envelope. */
function respond(result: ToolResult): McpToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: result.status === 'error',
  };
}

function errorResponse(message: string): McpToolResponse {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Read `workspace`, or `''` when the caller omitted it.
 *
 * The empty string is deliberate: the manager resolves a workspace as
 * `workspace || defaultWorkspace`, so an omitted argument has to arrive as a
 * falsy value for the administrator's configured default to apply. Sending a
 * literal `'.'` from here would silently pin every call to the plugin
 * server's own working directory instead.
 */
function workspaceArg(args: Record<string, unknown>): string {
  const value = args['workspace'];
  return typeof value === 'string' && value.length > 0 ? value : '';
}

/**
 * The caller's command selection: absent, usable, or malformed.
 *
 * `value: null` is the absent case -- the manager reads it as "the caller
 * named nothing" and falls back to its own capped default selection.
 */
type SelectionArg = { ok: true; value: string[] | null } | { ok: false; reason: string };

/**
 * Read an optional array of command names.
 *
 * A malformed value must never collapse into the absent case. It used to:
 * anything that was not an array of strings became `null`, and `null` makes
 * the manager run every recognized command with nothing marked as rejected.
 * So `{run: 'npm run build'}` -- a string where an array belongs -- silently
 * ran the whole project instead of the one command named, and the result
 * looked like it had been asked for. A selection we cannot use goes back to
 * the caller as an error rather than escalating into a broader action.
 */
function commandSelectionArg(args: Record<string, unknown>, key: string): SelectionArg {
  const value = args[key];
  if (value === undefined || value === null) return { ok: true, value: null };

  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: `\`${key}\` must be an array of command strings, not ${typeof value}.`,
    };
  }
  if (value.length === 0) {
    return { ok: false, reason: `\`${key}\` was an empty array, so it names no command.` };
  }

  const items = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (items.length !== value.length) {
    // Dropping the unusable entries and running the rest would report a
    // selection DevTwin never actually attempted in full.
    return {
      ok: false,
      reason:
        `\`${key}\` must contain only non-empty command strings; ` +
        `${value.length - items.length} of ${value.length} entries are not.`,
    };
  }
  return { ok: true, value: items };
}

/** Same message everywhere: what was wrong, and the two ways to fix it. */
function malformedSelection(toolName: string, reason: string): McpToolResponse {
  return errorResponse(
    `${toolName} did not run: ${reason} Name the commands to run as an array of ` +
      'strings, or omit `run` to let DevTwin choose. Nothing was executed.',
  );
}

export async function handleToolCall(
  toolName: string,
  args: unknown,
  context: McpContext,
  manager: DevTwinManager,
): Promise<McpToolResponse> {
  if (!KNOWN_TOOLS.has(toolName)) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // Never trust the declared argument type.
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (toolName) {
      // ----------------------------------------------------------- settings
      case 'devtwin_configure':
        return respond(manager.configure(a, context));
      case 'devtwin_status':
        return respond(manager.status(context));
      case 'devtwin_remove':
        return respond(manager.remove(context));
      case 'devtwin_health_check':
        return respond(await manager.deepHealthCheck(context));
      case 'devtwin_get_logs':
        return respond(manager.getLogs(a, context));

      // --------------------------------------------------------------- core
      case 'devtwin_detect':
        return respond(await manager.detect(workspaceArg(a)));
      case 'devtwin_project_info':
        return respond(await manager.projectInfo(workspaceArg(a)));
      case 'devtwin_dependencies':
        return respond(await manager.dependencies(workspaceArg(a)));
      case 'devtwin_health':
        return respond(await manager.health(workspaceArg(a)));
      case 'devtwin_health_all':
        return respond(await manager.healthAll(workspaceArg(a)));
      case 'devtwin_drift':
        return respond(await manager.drift(workspaceArg(a)));
      case 'devtwin_services':
        return respond(await manager.services(workspaceArg(a)));
      case 'devtwin_precommit':
        return respond(await manager.precommit(workspaceArg(a)));

      // ------------------------------------------------------------ service
      case 'devtwin_explain_failure': {
        const errorMessage = a['error_message'];
        if (typeof errorMessage !== 'string' || errorMessage.trim().length === 0) {
          return errorResponse('devtwin_explain_failure requires a non-empty error_message.');
        }
        const command = typeof a['command'] === 'string' ? (a['command'] as string) : null;
        return respond(
          await manager.explainFailure(workspaceArg(a), errorMessage, command),
        );
      }
      case 'devtwin_prepare':
        return respond(await manager.prepare(workspaceArg(a)));
      case 'devtwin_check': {
        const selection = commandSelectionArg(a, 'run');
        if (!selection.ok) return malformedSelection(toolName, selection.reason);
        return respond(await manager.check(workspaceArg(a), selection.value));
      }
      case 'devtwin_build': {
        const selection = commandSelectionArg(a, 'run');
        if (!selection.ok) return malformedSelection(toolName, selection.reason);
        return respond(await manager.build(workspaceArg(a), selection.value));
      }
      case 'devtwin_build_all':
        return respond(await manager.buildAll(workspaceArg(a)));

      default:
        // Unreachable: the KNOWN_TOOLS check above already throws for any
        // name not handled here.
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    // Surface a short, path-free message -- never a stack trace.
    const message = error instanceof Error ? error.message : 'unknown error';
    return errorResponse(`DevTwin could not complete ${toolName}: ${message}`);
  }
}

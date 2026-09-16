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

/** Read `workspace`, falling back to the manager's configured default. */
function workspaceArg(args: Record<string, unknown>): string {
  const value = args['workspace'];
  return typeof value === 'string' && value.length > 0 ? value : '.';
}

/** Read an optional string array, ignoring anything that is not a string. */
function stringArrayArg(args: Record<string, unknown>, key: string): string[] | null {
  const value = args[key];
  if (!Array.isArray(value)) return null;
  const items = value.filter((v): v is string => typeof v === 'string');
  return items.length > 0 ? items : null;
}

export async function handleToolCall(
  toolName: string,
  args: unknown,
  context: McpContext,
  manager: DevTwinManager,
): Promise<McpToolResponse> {
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
      case 'devtwin_check':
        return respond(await manager.check(workspaceArg(a), stringArrayArg(a, 'run')));
      case 'devtwin_build':
        return respond(await manager.build(workspaceArg(a), stringArrayArg(a, 'run')));
      case 'devtwin_build_all':
        return respond(await manager.buildAll(workspaceArg(a)));

      default:
        return errorResponse(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    // Surface a short, path-free message -- never a stack trace.
    const message = error instanceof Error ? error.message : 'unknown error';
    return errorResponse(`DevTwin could not complete ${toolName}: ${message}`);
  }
}

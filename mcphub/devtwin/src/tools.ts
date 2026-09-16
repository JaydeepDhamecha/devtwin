/**
 * DevTwin MCP tool definitions.
 *
 * Every tool name shares the `devtwin_` prefix derived from the plugin name,
 * and every tool declares a category. The five settings tools are required of
 * every MCPHub plugin; the rest expose DevTwin's environment intelligence.
 */

import type { McpToolDefinition } from '@mcphub/core/src/mcp/plugin.interface.js';

/** Shared `workspace` parameter -- the directory a tool inspects. */
const workspaceProperty = {
  type: 'string',
  description:
    'Absolute or relative path to the project directory to inspect. Defaults to the configured defaultWorkspace.',
  default: '.',
};

export const tools: McpToolDefinition[] = [
  // ------------------------------------------------------------- settings
  {
    name: 'devtwin_configure',
    description:
      'Store DevTwin configuration: default workspace, allowed workspace roots, command timeouts, and whether recognized project commands may be executed.',
    category: 'settings',
    inputSchema: {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          description:
            'Configuration object. Any omitted field keeps its default. See the plugin settings panel for the full field list.',
          additionalProperties: true,
        },
      },
      required: [],
      additionalProperties: true,
    },
  },
  {
    name: 'devtwin_status',
    description:
      'Return DevTwin readiness and effective configuration: whether command execution is enabled, whether workspace roots are restricted, and which ecosystem adapters are registered.',
    category: 'settings',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'devtwin_remove',
    description:
      'Clear all DevTwin state and configuration. DevTwin creates no database tables and writes no files, so nothing persists after this call.',
    category: 'settings',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'devtwin_health_check',
    description:
      'Deep health check of DevTwin itself: confirms the workspace is readable and that recognized commands can be spawned. Does not inspect the project.',
    category: 'settings',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'devtwin_get_logs',
    description:
      'Return recent DevTwin tool activity (tool name, status, summary, timestamp), newest first.',
    category: 'settings',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of entries to return (1-500).',
          default: 50,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  // ----------------------------------------------------------------- core
  {
    name: 'devtwin_detect',
    description:
      'Detect what kind of project lives at the workspace: languages, ecosystems, and the evidence (files) behind each detection. Fast, file-based only.',
    category: 'core',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceProperty },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_project_info',
    description:
      'Detailed project inspection: detected ecosystems, runtimes (installed vs required), build tools, test/build commands, environment variables in use, OS info, and Git state. Broader and slower than devtwin_detect.',
    category: 'core',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceProperty },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_dependencies',
    description:
      'Dependency state per detected ecosystem: package manager, lockfile presence and consistency signals, dependency counts, and whether packages appear installed locally.',
    category: 'core',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceProperty },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_health',
    description:
      'Full environment health check: combines project detection, runtime versions, dependency state, required services, ports, and Git state into a 0-100 health score with concrete issues and recommendations.',
    category: 'core',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceProperty },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_health_all',
    description:
      'Scan monorepo subdirectories for ecosystems and run a health check on each. Returns per-ecosystem health score, runtime and dependency state, issues, and recommendations.',
    category: 'core',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceProperty },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_drift',
    description:
      'Compare expected project state (runtime and tool versions declared in project files) against what is actually installed. Reports each mismatch as a structured drift item.',
    category: 'core',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceProperty },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_services',
    description:
      'Local service detection: which services (Postgres, Redis, and compose-defined services) this project appears to need, whether each is currently running or listening, and the evidence behind that conclusion.',
    category: 'core',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceProperty },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_precommit',
    description:
      'Read-only commit-readiness summary: Git status (dirty, staged, conflicts), project health, and staged files that look like they may contain secrets. Never commits, stages, or modifies anything.',
    category: 'core',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceProperty },
      required: [],
      additionalProperties: false,
    },
  },

  // -------------------------------------------------------------- service
  {
    name: 'devtwin_explain_failure',
    description:
      'Diagnose a development failure. Give it the error or output text and optionally the command that produced it; it cross-references project type, runtimes, services, ports, and dependencies to rank likely root causes with evidence.',
    category: 'service',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: workspaceProperty,
        error_message: {
          type: 'string',
          description: 'The error text or failing command output to diagnose.',
        },
        command: {
          type: 'string',
          description: 'Optional: the command that produced the error.',
        },
      },
      required: ['error_message'],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_prepare',
    description:
      'Produce an ordered preparation plan for a newly cloned repository: align runtimes, start required services, install dependencies, run checks. Never executes anything; each step is classified by blast radius (read_only, safe, requires_approval, dangerous).',
    category: 'service',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceProperty },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_check',
    description:
      'Run recognized project checks (tests and linters) discovered from project files, such as pytest, npm test, ./gradlew test, or cargo test. Only commands DevTwin itself recognized are ever executed, each with a timeout.',
    category: 'service',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: workspaceProperty,
        run: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional subset of the recognized check commands to run. Anything not recognized is rejected, never executed. Call devtwin_project_info first to see what is available.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_build',
    description:
      'Run recognized project build commands discovered from project files, such as npm run build, ./gradlew build, xcodebuild build, or dotnet build. Only commands DevTwin itself recognized are ever executed, each with a timeout.',
    category: 'service',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: workspaceProperty,
        run: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional subset of the recognized build commands to run. Anything not recognized is rejected, never executed.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'devtwin_build_all',
    description:
      'Scan monorepo subdirectories for ecosystems and run their recognized build commands. Use it to verify a backend change has not broken the Android, iOS, or frontend builds.',
    category: 'service',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceProperty },
      required: [],
      additionalProperties: false,
    },
  },
];

/** Every tool name, used for pricing coverage checks. */
export const TOOL_NAMES: string[] = tools.map((t) => t.name);

/**
 * DevTwin plugin for MCPHub.
 *
 * Gives an AI coding agent a live, structured view of a development
 * environment: what kind of project it is, what runtimes, dependencies and
 * services it needs, what is actually installed and running, and why
 * something might be failing.
 *
 * DevTwin holds no credentials, creates no database tables, and writes no
 * files. Every command it can execute is drawn from an allowlist discovered
 * by its own ecosystem adapters -- there is no path from model-supplied text
 * to a spawned process.
 */

import { BasePlugin } from '@mcphub/core/src/mcp/base-plugin.js';
import type {
  ConfigMeta,
  HealthStatus,
  McpActionPlanDefinition,
  McpContext,
  McpToolDefinition,
  McpToolResponse,
  PluginPricing,
} from '@mcphub/core/src/mcp/plugin.interface.js';

import { configSchema } from './config.schema.js';
import { DevTwinManager } from './devtwin.manager.js';
import { handleToolCall } from './handlers.js';
import { tools } from './tools.js';

export default class DevTwinPlugin extends BasePlugin {
  // ------------------------------------------------------------- identity
  readonly name = 'devtwin';
  readonly displayName = 'DevTwin';
  readonly description =
    'Live, structured view of a development environment: project detection, runtime and dependency state, required services, version drift, and evidence-based failure diagnosis across 10 language ecosystems.';
  readonly version = '1.0.0';
  readonly icon = 'activity';

  /** Version of the upstream DevTwin MCP server this plugin wraps. */
  readonly providerVersion = '0.1.0';
  readonly category = 'DevTools';
  readonly technologies = [
    'Node.js',
    'TypeScript',
    'Python',
    'Java',
    'Kotlin',
    'Go',
    'Rust',
    '.NET',
    'Swift',
    'Ruby',
    'PHP',
    'Docker',
    'PostgreSQL',
    'Redis',
  ];

  /**
   * Tiers reflect cost, not capability gating for its own sake: detection is
   * pure filesystem work, the analysis tools shell out for version probes,
   * and the build/check tools spawn real builds.
   */
  readonly pricing: PluginPricing = {
    tools: {
      free: [
        'devtwin_configure',
        'devtwin_status',
        'devtwin_remove',
        'devtwin_health_check',
        'devtwin_get_logs',
        'devtwin_detect',
      ],
      pro: [
        'devtwin_project_info',
        'devtwin_dependencies',
        'devtwin_health',
        'devtwin_drift',
        'devtwin_services',
        'devtwin_precommit',
        'devtwin_explain_failure',
        'devtwin_prepare',
      ],
      // Covers the remaining build/check tools and everything above.
      enterprise: '*',
    },
    limits: {
      free: { callsPerMonth: 200 },
      pro: { callsPerMonth: 5000 },
      enterprise: { callsPerMonth: -1 },
    },
  };

  private readonly manager = new DevTwinManager(configSchema.parse({}));

  // ---------------------------------------------------------------- wiring

  override getTools(): McpToolDefinition[] {
    return tools;
  }

  async handleToolCall(
    toolName: string,
    args: unknown,
    context: McpContext,
  ): Promise<McpToolResponse> {
    return handleToolCall(toolName, args, context, this.manager);
  }

  // ------------------------------------------------------------ config UI

  override getConfigMeta(): ConfigMeta {
    return {
      groups: [
        { key: 'general', label: 'General', order: 0 },
        { key: 'execution', label: 'Command Execution', order: 1 },
        { key: 'limits', label: 'Limits & Retention', order: 2 },
      ],
      fields: {
        defaultWorkspace: {
          group: 'general',
          label: 'Default workspace',
          fieldType: 'text',
          description: 'Directory inspected when a tool call omits one.',
          placeholder: '.',
        },
        allowedWorkspaceRoots: {
          group: 'general',
          label: 'Allowed workspace roots',
          fieldType: 'textarea',
          description:
            'Absolute paths DevTwin may inspect, one per line. Leave empty for no restriction. Recommended on shared deployments.',
          placeholder: '/srv/projects',
        },
        monorepoDirectories: {
          group: 'general',
          label: 'Monorepo subdirectories',
          fieldType: 'list',
          description:
            'Subdirectory names scanned by devtwin_health_all and devtwin_build_all.',
        },
        allowHostEnvironment: {
          group: 'execution',
          label: 'Treat host environment as the project environment',
          fieldType: 'boolean',
          description:
            "Read environment variables from the running process. Correct only when DevTwin runs on the developer's own machine. Off by default; variable names are read from the workspace .env files instead.",
        },
        enableCommandExecution: {
          group: 'execution',
          label: 'Enable command execution',
          fieldType: 'boolean',
          description:
            'When off, devtwin_check, devtwin_build and devtwin_build_all report as disabled instead of spawning processes. Analysis tools keep working.',
        },
        checkTimeoutSeconds: {
          group: 'execution',
          label: 'Check timeout (seconds)',
          fieldType: 'number',
          description:
            'Time allowed for a recognized test or lint command. The value that actually applies is the lower of this and the platform timeout budget below.',
        },
        buildTimeoutSeconds: {
          group: 'execution',
          label: 'Build timeout (seconds)',
          fieldType: 'number',
          description:
            'Time allowed for a recognized build command. The value that actually applies is the lower of this and the platform timeout budget below, which is why the budget ships at the same 300s rather than overriding this silently.',
        },
        platformTimeoutBudgetSeconds: {
          group: 'execution',
          label: 'Platform timeout budget (seconds)',
          fieldType: 'number',
          description:
            'Hard ceiling on every command timeout so a call stays inside the platform execution budget. It overrides the two timeouts above whenever it is lower, and a command still running at the ceiling is reported as timed out, never as failed. Defaults to 300s so the build timeout above governs out of the box; lower it to your deployment\'s real per-call limit.',
        },
        maxAutoCheckCommands: {
          group: 'limits',
          label: 'Max automatic check commands',
          fieldType: 'number',
          description: 'How many recognized checks run when the caller names none.',
        },
        maxAutoBuildCommands: {
          group: 'limits',
          label: 'Max automatic build commands',
          fieldType: 'number',
          description:
            'How many builds a devtwin_build call runs, and the total devtwin_build_all runs across all directories. Anything past the cap is reported as skipped.',
        },
        maxOutputChars: {
          group: 'limits',
          label: 'Max output characters',
          fieldType: 'number',
          description: 'Per-command output truncation.',
        },
        maxResponseBytes: {
          group: 'limits',
          label: 'Max response bytes',
          fieldType: 'number',
          description: 'Ceiling on a serialized tool result, to stay under the 1MB limit.',
        },
        logRetentionEntries: {
          group: 'limits',
          label: 'Log entries retained',
          fieldType: 'number',
          description: 'How many activity log entries devtwin_get_logs keeps.',
        },
        logRetentionDays: {
          group: 'limits',
          label: 'Log retention (days)',
          fieldType: 'number',
          description: 'Age after which retained log entries are dropped.',
        },
      },
    };
  }

  /**
   * DevTwin authenticates to nothing and stores no credentials: it reads the
   * local environment and runs allowlisted project commands. There is
   * deliberately no API key, token, or password in its config schema, so
   * this list is empty rather than padded with a field that does not exist.
   */
  override getSensitiveConfigFields(): string[] {
    return [];
  }

  // ----------------------------------------------------------- action plans

  override getActionPlans(): McpActionPlanDefinition[] {
    return [
      {
        name: 'devtwin-setup',
        display_name: 'DevTwin Setup',
        description:
          'Point DevTwin at a project and confirm it can read the environment and report health.',
        trigger_phrases: [
          'setup devtwin',
          'configure devtwin',
          'check my dev environment',
          'why is my project not building',
        ],
        plugin_name: this.name,
        expected_outcome:
          'DevTwin is configured for a workspace and returns a health score with concrete issues.',
        steps: [
          {
            id: 'configure',
            order: 1,
            title: 'Set the workspace and execution policy',
            description:
              'Store the default workspace, optional allowed roots, and whether recognized commands may run.',
            tool_to_call: 'devtwin_configure',
            expected_output: '{ configured: true }',
          },
          {
            id: 'verify',
            order: 2,
            title: 'Verify DevTwin can read the environment',
            description:
              'Confirm the workspace is readable and that recognized commands can be spawned.',
            tool_to_call: 'devtwin_health_check',
            depends_on: ['configure'],
            expected_output: '{ healthy: true }',
          },
          {
            id: 'detect',
            order: 3,
            title: 'Detect the project type',
            description:
              'Identify ecosystems and the indicator files behind each detection.',
            tool_to_call: 'devtwin_detect',
            depends_on: ['verify'],
            expected_output: '{ profile: { ecosystems: [...], primary_ecosystem: "..." } }',
          },
          {
            id: 'health',
            order: 4,
            title: 'Score the environment',
            description:
              'Combine runtimes, dependencies, services and Git state into a 0-100 health score.',
            tool_to_call: 'devtwin_health',
            depends_on: ['detect'],
            expected_output: '{ health_score: 85, issues: [...] }',
          },
        ],
      },
      {
        name: 'devtwin-build-impact',
        display_name: 'Cross-Stack Build Impact Check',
        description:
          'After a backend change in a monorepo, verify the Android, iOS and frontend builds still pass.',
        trigger_phrases: [
          'did my change break the mobile build',
          'check build impact',
          'verify all builds still pass',
        ],
        plugin_name: this.name,
        expected_outcome:
          'Per-ecosystem build results for every monorepo subdirectory, with failures and their output.',
        steps: [
          {
            id: 'detect',
            order: 1,
            title: 'Identify the stacks in this repository',
            description: 'Detect which ecosystems live in the monorepo subdirectories.',
            tool_to_call: 'devtwin_detect',
            expected_output: '{ profile: { ecosystems: [...] } }',
          },
          {
            id: 'health-all',
            order: 2,
            title: 'Check each stack is buildable',
            description:
              'Confirm each subproject has its runtimes and dependencies before spending time on builds.',
            tool_to_call: 'devtwin_health_all',
            depends_on: ['detect'],
            expected_output: '{ ecosystems: [{ directory: "android", health_score: 90 }] }',
          },
          {
            id: 'build-all',
            order: 3,
            title: 'Build every stack',
            description:
              'Run each subproject recognized build command and report pass/fail with output.',
            tool_to_call: 'devtwin_build_all',
            depends_on: ['health-all'],
            expected_output: '{ ecosystems: [{ directory: "android", failed_count: 0 }] }',
          },
          {
            id: 'explain',
            order: 4,
            title: 'Diagnose any failure',
            description:
              'Feed a failing build output back in to rank likely root causes with evidence.',
            tool_to_call: 'devtwin_explain_failure',
            depends_on: ['build-all'],
            expected_output: '{ strongest: { cause: "...", confidence: 0.8 } }',
          },
        ],
      },
    ];
  }

  // ---------------------------------------------------------------- health

  override async healthCheck(): Promise<HealthStatus> {
    const base = await super.healthCheck();
    const probe = await this.manager.deepHealthCheck();
    return {
      ...base,
      healthy: probe.status === 'ok',
      details: {
        status: probe.status === 'ok' ? 'running' : 'degraded',
        ...probe.data,
      },
    };
  }

  // ------------------------------------------------------------- discovery

  /** Maps each tool to the underlying service method it calls. */
  getSDKMetadata(): Record<string, string> {
    return {
      devtwin_configure: 'DevTwinManager.configure()',
      devtwin_status: 'DevTwinManager.status()',
      devtwin_remove: 'DevTwinManager.remove()',
      devtwin_health_check: 'DevTwinManager.deepHealthCheck()',
      devtwin_get_logs: 'DevTwinManager.getLogs()',
      devtwin_detect: 'DevTwinManager.detect()',
      devtwin_project_info: 'DevTwinManager.projectInfo()',
      devtwin_dependencies: 'DevTwinManager.dependencies()',
      devtwin_health: 'DevTwinManager.health()',
      devtwin_health_all: 'DevTwinManager.healthAll()',
      devtwin_drift: 'DevTwinManager.drift()',
      devtwin_services: 'DevTwinManager.services()',
      devtwin_precommit: 'DevTwinManager.precommit()',
      devtwin_explain_failure: 'DevTwinManager.explainFailure()',
      devtwin_prepare: 'DevTwinManager.prepare()',
      devtwin_check: 'DevTwinManager.check()',
      devtwin_build: 'DevTwinManager.build()',
      devtwin_build_all: 'DevTwinManager.buildAll()',
    };
  }

  /** The manager runs without the MCP runtime, and extends EventEmitter. */
  getStandaloneService(): DevTwinManager {
    return this.manager;
  }
}

export { DevTwinManager } from './devtwin.manager.js';
export { configSchema } from './config.schema.js';
export { tools } from './tools.js';

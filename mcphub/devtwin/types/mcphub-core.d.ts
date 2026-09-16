/**
 * Local ambient declarations for the MCPHub core contracts.
 *
 * The dev kit mandates that plugins import from
 * `@mcphub/core/src/mcp/...` -- those modules exist in the MCPHub monorepo,
 * not in this standalone plugin directory. These declarations let the plugin
 * typecheck on its own while the import specifiers in `src/` stay exactly as
 * the platform requires. Nothing here ships at runtime.
 */

declare module '@mcphub/core/src/mcp/plugin.interface.js' {
  export interface McpToolDefinition {
    name: string;
    description: string;
    category?: 'settings' | 'core' | 'service';
    inputSchema: {
      type: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  }

  export interface McpContext {
    customerId?: string;
    userId?: string;
    [key: string]: unknown;
  }

  export interface HealthStatus {
    healthy: boolean;
    status?: string;
    details?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface McpActionPlanStep {
    id: string;
    order: number;
    title: string;
    description: string;
    tool_to_call: string;
    depends_on?: string[];
    expected_output: string;
  }

  export interface McpActionPlanDefinition {
    name: string;
    display_name: string;
    description: string;
    trigger_phrases: string[];
    plugin_name: string;
    expected_outcome: string;
    steps: McpActionPlanStep[];
  }

  export interface PluginPricingLimits {
    callsPerMonth: number;
  }

  export interface PluginPricing {
    tools: {
      free: string[] | '*';
      pro: string[] | '*';
      enterprise: string[] | '*';
    };
    limits: {
      free: PluginPricingLimits;
      pro: PluginPricingLimits;
      enterprise: PluginPricingLimits;
    };
  }

  export interface ConfigFieldMeta {
    group: string;
    label: string;
    fieldType: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea' | 'list';
    description?: string;
    placeholder?: string;
    options?: Array<{ label: string; value: string }>;
  }

  export interface ConfigMeta {
    groups: Array<{ key: string; label: string; order: number }>;
    fields: Record<string, ConfigFieldMeta>;
  }

  export interface McpToolResponse {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }
}

declare module '@mcphub/core/src/mcp/base-plugin.js' {
  import type {
    ConfigMeta,
    HealthStatus,
    McpActionPlanDefinition,
    McpToolDefinition,
  } from '@mcphub/core/src/mcp/plugin.interface.js';

  export abstract class BasePlugin {
    abstract readonly name: string;
    abstract readonly displayName: string;
    abstract readonly description: string;
    abstract readonly version: string;
    abstract readonly icon: string;

    getTools(): McpToolDefinition[];
    getConfigMeta(): ConfigMeta;
    getSensitiveConfigFields(): string[];
    getActionPlans(): McpActionPlanDefinition[];
    healthCheck(): Promise<HealthStatus>;
  }
}

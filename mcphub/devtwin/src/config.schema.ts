/**
 * DevTwin plugin configuration.
 *
 * Every field MUST have .default() -- configSchema.safeParse({}) has to
 * succeed with empty input. .passthrough() comes BEFORE .default({}) so the
 * admin settings panel can send extra fields without the parse failing.
 */

import { z } from 'zod';

const baseConfigSchema = z
  .object({
    /** Workspace used when a tool call omits one. */
    defaultWorkspace: z.string().default('.'),

    /**
     * Absolute paths DevTwin is allowed to inspect, newline- or comma-separated.
     * Empty means "no restriction" -- set this in shared deployments.
     */
    allowedWorkspaceRoots: z.string().default(''),

    /**
     * Treat the host process environment as the project's environment.
     * Correct when DevTwin runs on the developer's own machine; wrong (and
     * a leak risk) when it runs on a shared server, so it defaults to off.
     */
    allowHostEnvironment: z.boolean().default(false),

    /** Master switch for the tools that execute recognized project commands. */
    enableCommandExecution: z.boolean().default(true),

    /** Seconds allowed for a recognized check (test/lint) command. */
    checkTimeoutSeconds: z.number().int().min(1).max(3600).default(120),

    /** Seconds allowed for a recognized build command. */
    buildTimeoutSeconds: z.number().int().min(1).max(3600).default(300),

    /**
     * Hard ceiling applied to every command timeout, to stay inside the
     * platform's per-call execution budget. Long builds are reported as
     * timed out rather than being allowed to run past it.
     */
    platformTimeoutBudgetSeconds: z.number().int().min(1).max(3600).default(25),

    /** How many recognized check commands run when the caller names none. */
    maxAutoCheckCommands: z.number().int().min(1).max(50).default(5),

    /** Subdirectories scanned by devtwin_build_all / devtwin_health_all. */
    monorepoDirectories: z
      .array(z.string())
      .default(['android', 'ios', 'frontend', 'backend', 'app', 'web', 'mobile']),

    /** Per-command output truncation, in characters. */
    maxOutputChars: z.number().int().min(500).max(200_000).default(20_000),

    /** Serialized response ceiling, in bytes, to stay under the 1MB tool-result limit. */
    maxResponseBytes: z.number().int().min(10_000).max(1_000_000).default(900_000),

    /** How many activity log entries devtwin_get_logs retains. */
    logRetentionEntries: z.number().int().min(1).max(5000).default(200),

    /** Days after which retained log entries are dropped. */
    logRetentionDays: z.number().int().min(1).max(365).default(30),
  });

export const configSchema = baseConfigSchema.passthrough().default({});

export type DevTwinConfig = z.infer<typeof configSchema>;

/** Every field's default -- `safeParse({})` always succeeds. */
export function defaultConfig(): DevTwinConfig {
  return configSchema.parse({});
}

/**
 * Parse config for construction, where there is no previous value to keep.
 * Falls back to defaults only because the caller has nothing better.
 */
export function parseConfig(raw: unknown): DevTwinConfig {
  const parsed = configSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : defaultConfig();
}

export interface ConfigUpdate {
  config: DevTwinConfig;
  invalidFields: string[];
  accepted: boolean;
}

/**
 * Apply an update to an existing config.
 *
 * A rejected update changes nothing. Resetting to defaults instead would
 * silently drop security-relevant settings -- notably allowedWorkspaceRoots,
 * whose empty value means "no restriction" -- while still looking like a
 * successful configure call.
 */
export function applyConfig(current: DevTwinConfig, raw: unknown): ConfigUpdate {
  const incoming = (raw ?? {}) as Record<string, unknown>;
  const parsed = configSchema.safeParse(incoming);
  if (parsed.success) {
    return { config: { ...current, ...parsed.data }, invalidFields: [], accepted: true };
  }

  // Name every field that failed, so the caller can fix them rather than
  // guessing which one was rejected.
  const invalidFields = [
    ...new Set(
      parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .filter((path) => path.length > 0),
    ),
  ];
  return { config: current, invalidFields, accepted: false };
}

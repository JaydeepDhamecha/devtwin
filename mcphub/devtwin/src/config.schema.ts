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

    /**
     * Seconds allowed for a recognized check (test/lint) command.
     * The effective timeout is min(this, platformTimeoutBudgetSeconds).
     */
    checkTimeoutSeconds: z.number().int().min(1).max(3600).default(120),

    /**
     * Seconds allowed for a recognized build command.
     * The effective timeout is min(this, platformTimeoutBudgetSeconds).
     */
    buildTimeoutSeconds: z.number().int().min(1).max(3600).default(300),

    /**
     * Hard ceiling applied to every command timeout, to stay inside the
     * platform's per-call execution budget. Commands still running at the
     * ceiling are reported as timed out -- never as failed.
     *
     * The default deliberately equals the largest shipped timeout
     * (buildTimeoutSeconds, 300) so the per-command timeouts above actually
     * govern out of the box: a default of 25 clamped every build to 25s, so
     * no real `./gradlew build` or `xcodebuild` could ever finish and the
     * 300s the settings panel advertised was unreachable. Lower this to
     * whatever the hosting platform's per-call limit really is; it then
     * clamps both timeouts above, and the clamp is reported in
     * `timeout_clamped` / `effective_timeout_seconds` on every result.
     */
    platformTimeoutBudgetSeconds: z.number().int().min(1).max(3600).default(300),

    /** How many recognized check commands run when the caller names none. */
    maxAutoCheckCommands: z.number().int().min(1).max(50).default(5),

    /**
     * How many recognized build commands a single devtwin_build call runs, and
     * the total devtwin_build_all runs across every scanned directory. Builds
     * get buildTimeoutSeconds each, so an uncapped list can hold one call open
     * far longer than any client will wait; commands past the cap are reported
     * as skipped, never silently dropped.
     */
    maxAutoBuildCommands: z.number().int().min(1).max(50).default(5),

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

/**
 * The same schema with every field optional, for partial updates.
 *
 * `configSchema` fills in a default for each absent field, which is exactly
 * what a partial update must not do -- see `applyConfig`. Validation is
 * identical for the fields that ARE present.
 */
const partialConfigSchema = baseConfigSchema.partial().passthrough();

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
 *
 * An ACCEPTED update must not drop them either, which is why this validates
 * against `partialConfigSchema` and then merges only the keys the caller
 * actually sent. Parsing a partial update with `configSchema` returned a
 * fully-populated object -- every default materialized -- so spreading it
 * over the current config reset every omitted field: an admin raising
 * maxOutputChars silently cleared allowedWorkspaceRoots (back to "no
 * restriction") and allowHostEnvironment, the precise outcome the paragraph
 * above says must never happen.
 */
export function applyConfig(current: DevTwinConfig, raw: unknown): ConfigUpdate {
  const incoming = (raw ?? {}) as Record<string, unknown>;
  const parsed = partialConfigSchema.safeParse(incoming);
  if (parsed.success) {
    // Drive the merge off the caller's own keys, not the parse output: a key
    // the caller never sent has no validated value to apply, and the current
    // one stands. Unknown keys ride through `.passthrough()` the same way.
    const validated = parsed.data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(incoming)) {
      if (key in validated) patch[key] = validated[key];
    }
    return {
      config: { ...current, ...patch } as DevTwinConfig,
      invalidFields: [],
      accepted: true,
    };
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

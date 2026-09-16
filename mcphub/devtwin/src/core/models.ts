/**
 * Typed data model shared across DevTwin's core and adapters.
 *
 * Ported from the Python `devtwin.core.models` dataclasses. Every type here is
 * a plain interface so tool results are JSON-serializable with no conversion
 * step -- what the adapters build is exactly what goes over the wire.
 */

export const Status = {
  OK: 'ok',
  WARNING: 'warning',
  ERROR: 'error',
  UNKNOWN: 'unknown',
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const Severity = {
  INFO: 'info',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const ActionClass = {
  READ_ONLY: 'read_only',
  SAFE: 'safe',
  REQUIRES_APPROVAL: 'requires_approval',
  DANGEROUS: 'dangerous',
} as const;
export type ActionClass = (typeof ActionClass)[keyof typeof ActionClass];

/**
 * Existence/availability state for a tool, runtime, or variable.
 * Never conflate "not installed" with "unknown".
 */
export const Presence = {
  DETECTED: 'detected',
  NOT_DETECTED: 'not_detected',
  INSTALLED: 'installed',
  NOT_INSTALLED: 'not_installed',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
} as const;
export type Presence = (typeof Presence)[keyof typeof Presence];

/** Uniform envelope returned by every MCP tool. */
export interface ToolResult {
  status: Status;
  summary: string;
  data: Record<string, unknown>;
  issues: Array<Record<string, unknown>>;
  recommendations: string[];
}

/** Result of a safely-executed subprocess. */
export interface CommandResult {
  executable: string;
  args: string[];
  returncode: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  available: boolean;
  duration_ms: number;
}

export interface RuntimeInfo {
  name: string;
  presence: Presence;
  installed_version?: string | null;
  required_version?: string | null;
  path?: string | null;
  /** where the required version was read from */
  source?: string | null;
}

export interface DependencyInfo {
  ecosystem: string;
  manager: string | null;
  lockfile: string | null;
  lockfile_present: boolean;
  manifest_present: boolean;
  installed: Presence;
  dependency_count: number | null;
  dev_dependency_count: number | null;
  notes: string[];
}

export interface PortInfo {
  port: number;
  listening: boolean;
  protocol: string;
  process_name?: string | null;
  pid?: number | null;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  port?: number | null;
}

export interface ServiceInfo {
  name: string;
  required: boolean;
  /** 0..1 */
  required_confidence: number;
  running: boolean;
  port?: number | null;
  /** signals that led to this conclusion */
  source: string[];
  detail?: string | null;
}

export interface EnvironmentVariableStatus {
  name: string;
  present: boolean;
  is_secret: boolean;
  /** only ever set for non-secret vars */
  value_preview?: string | null;
}

export interface Capability {
  name: string;
  action_class: ActionClass;
  description: string;
}

export interface HealthIssue {
  severity: Severity;
  code: string;
  title: string;
  message: string;
  evidence: string[];
  recommendation?: string | null;
  confidence?: number | null;
}

export interface GitState {
  is_repo: boolean;
  branch?: string | null;
  dirty: boolean;
  staged_files: string[];
  unstaged_files: string[];
  untracked_files: string[];
  has_conflicts: boolean;
  root?: string | null;
}

export interface ProjectProfile {
  root: string;
  ecosystems: string[];
  primary_ecosystem: string | null;
  indicators: Record<string, string[]>;
  confidence: Record<string, number>;
}

export interface WorkspaceState {
  root: string;
  exists: boolean;
  is_directory: boolean;
  git: GitState | null;
}

export interface AdapterResult {
  ecosystem: string;
  applicable: boolean;
  runtimes: RuntimeInfo[];
  dependencies: DependencyInfo | null;
  build_tools: RuntimeInfo[];
  test_commands: string[];
  build_commands: string[];
  environment: EnvironmentVariableStatus[];
  issues: HealthIssue[];
  notes: string[];
}

export interface HealthReport {
  health_score: number;
  status: Status;
  project_summary: string;
  runtime_summary: string;
  service_summary: string;
  dependency_summary: string;
  issues: HealthIssue[];
  recommendations: string[];
}

export interface DriftItem {
  subject: string;
  expected: string;
  actual: string;
  source: string;
  severity: Severity;
}

export interface DriftReport {
  has_drift: boolean;
  items: DriftItem[];
  summary: string;
}

export interface RootCauseCandidate {
  cause: string;
  /** 0..1 */
  confidence: number;
  evidence: string[];
  recommendation?: string | null;
}

export interface DiagnosticReport {
  query: string;
  candidates: RootCauseCandidate[];
  strongest: RootCauseCandidate | null;
  summary: string;
}

/** Build an AdapterResult with every collection defaulted, like the Python dataclass. */
export function emptyAdapterResult(ecosystem: string, applicable: boolean): AdapterResult {
  return {
    ecosystem,
    applicable,
    runtimes: [],
    dependencies: null,
    build_tools: [],
    test_commands: [],
    build_commands: [],
    environment: [],
    issues: [],
    notes: [],
  };
}

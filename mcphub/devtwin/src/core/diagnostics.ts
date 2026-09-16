/**
 * Failure diagnosis: turn an error message + local evidence into ranked,
 * honestly-hedged root cause candidates.
 *
 * Every candidate must be backed by concrete evidence (a detected file, a
 * parsed config value, actual command output, an actual port/process state).
 * Confidence is never asserted as certainty -- language stays in "likely"/
 * "possible cause" territory unless evidence is direct and singular.
 */

import { computeDrift } from './drift.js';
import { computeHealth } from './health.js';
import type { DiagnosticReport, HealthIssue, RootCauseCandidate } from './models.js';
import { inspectWorkspace } from './workspace.js';
import { checkPort } from '../system/ports.js';

const PORT_IN_USE_RE = /(?:EADDRINUSE|address already in use).*?:?(\d{2,5})/i;
const GENERIC_PORT_RE = /:(\d{2,5})\b/;
const CONNECTION_REFUSED_RE = /(connection refused|could not connect|ECONNREFUSED)/i;
const MODULE_NOT_FOUND_PY_RE = /No module named ['"]?([\w.]+)/;
const MODULE_NOT_FOUND_NODE_RE = /Cannot find module ['"]([^'"]+)['"]/;
const COMMAND_NOT_FOUND_RE = /(command not found|is not recognized as an internal|ENOENT)/i;
const PERMISSION_DENIED_RE = /permission denied/i;

export async function diagnoseFailure(
  root: string,
  errorMessage: string,
  command: string | null = null
): Promise<DiagnosticReport> {
  const workspace = await inspectWorkspace(root);
  const candidates: RootCauseCandidate[] = [];

  if (!workspace.exists) {
    return {
      query: errorMessage,
      candidates: [],
      strongest: null,
      summary: `Workspace '${root}' does not exist -- cannot gather evidence.`,
    };
  }

  const health = await computeHealth(root);
  const drift = await computeDrift(root);

  const combinedText = `${command || ''}\n${errorMessage}`;

  const portMatch = PORT_IN_USE_RE.exec(combinedText);
  if (portMatch) {
    const port = parseInt(portMatch[1]!, 10);
    const info = await checkPort(port);
    if (info.listening) {
      const evidence = [`port ${port} is currently listening`];
      if (info.process_name) {
        evidence.push(`owned by process '${info.process_name}' (pid ${info.pid})`);
      }
      candidates.push({
        cause: `Port ${port} is already in use by another process.`,
        confidence: 0.85,
        evidence,
        recommendation: `Stop the process on port ${port}, or configure the app to use a different port.`,
      });
    }
  }

  if (CONNECTION_REFUSED_RE.test(combinedText)) {
    const connPortMatch = GENERIC_PORT_RE.exec(combinedText);
    const targetPort = connPortMatch ? parseInt(connPortMatch[1]!, 10) : null;
    let matchedService: HealthIssue | null = null;
    for (const issue of health.issues) {
      if (
        issue.code === 'service.not_running' &&
        (targetPort === null || issue.message.includes(String(targetPort)))
      ) {
        matchedService = issue;
        break;
      }
    }
    if (matchedService) {
      candidates.push({
        cause: matchedService.title,
        confidence: 0.75,
        evidence: matchedService.evidence,
        recommendation: matchedService.recommendation ?? null,
      });
    } else {
      candidates.push({
        cause: 'A required network service is unreachable.',
        confidence: 0.4,
        evidence: ['error message indicates a refused/failed connection'],
        recommendation:
          'Verify the target service is running and listening on the expected port.',
      });
    }
  }

  const pyModuleMatch = MODULE_NOT_FOUND_PY_RE.exec(errorMessage);
  if (pyModuleMatch) {
    candidates.push({
      cause: `Python dependency '${pyModuleMatch[1]}' is not installed in the active environment.`,
      confidence: 0.7,
      evidence: [`error message: No module named '${pyModuleMatch[1]}'`],
      recommendation:
        'Install project dependencies (e.g. `uv sync`, `pip install -r requirements.txt`) ' +
        'and confirm the correct virtual environment is active.',
    });
  }

  const nodeModuleMatch = MODULE_NOT_FOUND_NODE_RE.exec(errorMessage);
  if (nodeModuleMatch) {
    candidates.push({
      cause: `Node dependency '${nodeModuleMatch[1]}' is not installed.`,
      confidence: 0.7,
      evidence: [`error message: Cannot find module '${nodeModuleMatch[1]}'`],
      recommendation: "Run the project's install command (e.g. `npm install`, `pnpm install`).",
    });
  }

  if (COMMAND_NOT_FOUND_RE.test(combinedText) && command) {
    const parts = command.split(/\s+/).filter((part) => part.length > 0);
    const exe = parts.length > 0 ? parts[0]! : command;
    candidates.push({
      cause: `'${exe}' is not installed or not on PATH.`,
      confidence: 0.6,
      evidence: [`command attempted: ${command}`],
      recommendation: `Install '${exe}' or ensure it is on PATH.`,
    });
  }

  if (PERMISSION_DENIED_RE.test(combinedText)) {
    candidates.push({
      cause:
        'A permission error is blocking the command (file permissions, or a wrapper script not marked executable).',
      confidence: 0.4,
      evidence: ["error message contains 'permission denied'"],
      recommendation:
        'Check file/directory permissions; for wrapper scripts (gradlew/mvnw) ensure the executable bit is set.',
    });
  }

  if (drift.has_drift) {
    for (const item of drift.items.slice(0, 3)) {
      candidates.push({
        cause: `${item.subject} version drift: project expects ${item.expected}, environment has ${item.actual}.`,
        confidence: 0.5,
        evidence: [`source: ${item.source}`],
        recommendation: `Align local ${item.subject} with the project's required version (${item.expected}).`,
      });
    }
  }

  if (candidates.length === 0) {
    candidates.push({
      cause: 'No specific root cause could be matched from the error message and available evidence.',
      confidence: 0.15,
      evidence: [
        `project health score: ${health.health_score}`,
        `runtime summary: ${health.runtime_summary}`,
      ],
      recommendation:
        'Run `dev_health` and `dev_check` for a broader look, or share the full error output.',
    });
  }

  // Stable sort by descending confidence: ties keep detection order, so the
  // more specific evidence that was gathered first stays first.
  candidates.sort((a, b) => b.confidence - a.confidence);
  const strongest = candidates[0]!;

  const summary =
    strongest.confidence >= 0.5
      ? `Likely cause: ${strongest.cause}`
      : `Possible cause (low confidence): ${strongest.cause}`;

  return {
    query: errorMessage,
    candidates,
    strongest,
    summary,
  };
}

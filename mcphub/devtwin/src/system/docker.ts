/**
 * Safe, read-only Docker inspection.
 *
 * DevTwin never stops, removes, or otherwise mutates containers. Every
 * function here maps to a read-only `docker` subcommand.
 */

import { Presence } from '../core/models.js';
import { runCommand, which } from '../core/runner.js';
import { existsAny } from './filesystem.js';

export interface ContainerInfo {
  name: string;
  image: string;
  status: string;
  ports: string;
}

export interface DockerInfo {
  presence: Presence;
  version: string | null;
  daemon_running: boolean;
  containers: ContainerInfo[];
  compose_files: string[];
}

export const COMPOSE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];

export function findComposeFiles(root: string): string[] {
  return existsAny(root, COMPOSE_FILE_NAMES);
}

export async function inspectDocker(root?: string | null): Promise<DockerInfo> {
  if (which('docker') === null) {
    return {
      presence: Presence.NOT_INSTALLED,
      version: null,
      daemon_running: false,
      containers: [],
      compose_files: root ? findComposeFiles(root) : [],
    };
  }

  const versionResult = await runCommand(['docker', 'version', '--format', '{{.Server.Version}}'], {
    timeout: 5,
  });
  const daemonRunning = versionResult.available && versionResult.returncode === 0;
  let versionStr: string | null = null;
  if (daemonRunning) {
    versionStr = versionResult.stdout.trim() || null;
  } else {
    // Daemon down, but CLI installed -- try the client-only version.
    const clientVersion = await runCommand(['docker', '--version'], { timeout: 5 });
    if (clientVersion.available) {
      versionStr = clientVersion.stdout.trim() || null;
    }
  }

  const containers: ContainerInfo[] = [];
  if (daemonRunning) {
    const psResult = await runCommand(['docker', 'ps', '--format', '{{json .}}'], { timeout: 8 });
    if (psResult.available && psResult.returncode === 0) {
      for (const rawLine of psResult.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        containers.push({
          name: asString(raw['Names']),
          image: asString(raw['Image']),
          status: asString(raw['Status']),
          ports: asString(raw['Ports']),
        });
      }
    }
  }

  return {
    presence: Presence.INSTALLED,
    version: versionStr,
    daemon_running: daemonRunning,
    containers,
    compose_files: root ? findComposeFiles(root) : [],
  };
}

/** `dict.get(key, "")` equivalent that also tolerates non-string JSON values. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Generic compose-service detection for services with no dedicated detector.
 *
 * Avoids a YAML dependency: compose files have a predictable structure, so a
 * line-based scan for the `services:` block and its immediate children is
 * enough to recover service names without a full parser.
 */

import { join } from 'node:path';

import type { ServiceInfo } from '../core/models.js';
import { findComposeFiles } from '../system/docker.js';
import { readTextFile } from '../system/filesystem.js';
import { isPortListening } from '../system/ports.js';

const SERVICE_NAME_RE = /^ {2}([a-zA-Z0-9_.-]+):\s*$/;
const IMAGE_RE = /^\s*image:\s*["']?([^\s"']+)/;
const PORT_MAPPING_RE = /^\s*-\s*["']?(\d+):(\d+)/;

const KNOWN_SERVICE_NAMES = new Set(['postgresql', 'postgres', 'redis']);

interface ComposeService {
  image: string | null;
  ports: number[];
}

/** Return {serviceName: {image, ports}} for the compose file at `path`. */
function parseCompose(path: string): Record<string, ComposeService> {
  const text = readTextFile(path);
  if (text === null) {
    return {};
  }
  const lines = text.split(/\r?\n/);

  const services: Record<string, ComposeService> = {};
  let inServices = false;
  let current: string | null = null;

  for (const line of lines) {
    if (line.replace(/\s+$/, '') === 'services:') {
      inServices = true;
      continue;
    }
    if (!inServices) {
      continue;
    }
    if (line && !line.startsWith(' ')) {
      break; // left the services block
    }

    const nameMatch = SERVICE_NAME_RE.exec(line);
    if (nameMatch) {
      current = nameMatch[1]!;
      services[current] = { image: null, ports: [] };
      continue;
    }

    if (current === null) {
      continue;
    }

    const imageMatch = IMAGE_RE.exec(line);
    if (imageMatch) {
      services[current]!.image = imageMatch[1]!;
      continue;
    }

    const portMatch = PORT_MAPPING_RE.exec(line);
    if (portMatch) {
      services[current]!.ports.push(Number.parseInt(portMatch[1]!, 10));
    }
  }

  return services;
}

/** Detect compose-defined services beyond Postgres/Redis (which have dedicated detectors). */
export async function detectGenericServices(root: string): Promise<ServiceInfo[]> {
  const infos: ServiceInfo[] = [];
  for (const filename of findComposeFiles(root)) {
    const parsed = parseCompose(join(root, filename));
    for (const [name, meta] of Object.entries(parsed)) {
      const image = (meta.image ?? '').toLowerCase();
      if (
        [...KNOWN_SERVICE_NAMES].some(
          (known) => image.includes(known) || name.toLowerCase().includes(known),
        )
      ) {
        continue;
      }
      const ports = meta.ports;
      const port = ports.length > 0 ? ports[0]! : null;
      const running = port ? await isPortListening(port) : false;
      infos.push({
        name,
        required: true,
        required_confidence: 0.5,
        running,
        port,
        source: [`${filename} defines service '${name}'`],
        detail: image ? `image: ${image}` : null,
      });
    }
  }
  return infos;
}

/**
 * Generic compose-service detection for services with no dedicated detector.
 *
 * Avoids a YAML dependency: compose files have a predictable structure, so a
 * line-based scan for the `services:` block and its immediate children is
 * enough to recover service names without a full parser.
 *
 * What a service publishes decides how loudly DevTwin may talk about it. A
 * published port can be probed, so "not listening" is a fact. A service with
 * no published port -- an internal-only worker, a one-shot migration job --
 * can only be seen through Docker, and where Docker can't answer, DevTwin says
 * it doesn't know rather than reporting a required service that is down.
 */

import { join } from 'node:path';

import type { ServiceInfo } from '../core/models.js';
import { inspectDocker, findComposeFiles, type ContainerInfo } from '../system/docker.js';
import { readTextFile } from '../system/filesystem.js';
import { isPortListening } from '../system/ports.js';

const SERVICE_NAME_RE = /^ {2}([a-zA-Z0-9_.-]+):\s*$/;
const IMAGE_RE = /^\s*image:\s*["']?([^\s"']+)/;
const PORT_MAPPING_RE = /^\s*-\s*["']?(\d+):(\d+)/;

const KNOWN_SERVICE_NAMES = new Set(['postgresql', 'postgres', 'redis']);

/** Compose defines it and the published port can be probed either way. */
const PROBEABLE_CONFIDENCE = 0.5;

/**
 * Nothing published, and no running container to match it to. Compose services
 * like this are as often one-shot jobs (migrations, seeding, fixtures) that are
 * *meant* to be stopped as they are long-lived workers, and DevTwin has no way
 * to tell -- so this stays under the 0.3 "required" bar used across detectors
 * instead of becoming a high-severity "port null is not listening".
 */
const UNVERIFIABLE_CONFIDENCE = 0.25;

/** Confidence at or above which a service is called required (as in base.ts). */
const REQUIRED_CONFIDENCE = 0.3;

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

/**
 * Whether `container` is plausibly this compose service.
 *
 * Compose names containers `<project>-<service>-<n>` (or `_`-separated, and
 * `container_name:` overrides both), so the service name appearing as a whole
 * segment is the reliable signal; an exact image match covers the rest.
 */
function containerMatches(container: ContainerInfo, name: string, image: string): boolean {
  if (container.name.toLowerCase().split(/[-_]/).includes(name.toLowerCase())) {
    return true;
  }
  return image !== '' && container.image.toLowerCase() === image;
}

/** Detect compose-defined services beyond Postgres/Redis (which have dedicated detectors). */
export async function detectGenericServices(root: string): Promise<ServiceInfo[]> {
  const infos: ServiceInfo[] = [];

  // Only services without a published port need Docker, and one `docker ps` is
  // enough for all of them -- so it is inspected lazily, at most once.
  let containers: ContainerInfo[] | null = null;
  const runningContainers = async (): Promise<ContainerInfo[]> => {
    containers ??= (await inspectDocker(root)).containers;
    return containers;
  };

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
      const details: string[] = [];
      if (image) {
        details.push(`image: ${image}`);
      }

      let running: boolean;
      let confidence: number;
      if (port !== null) {
        running = await isPortListening(port);
        confidence = PROBEABLE_CONFIDENCE;
      } else {
        // No published port: the container is the only thing left to look at.
        const container = (await runningContainers()).find((c) =>
          containerMatches(c, name, image),
        );
        running = container !== undefined;
        confidence = container ? PROBEABLE_CONFIDENCE : UNVERIFIABLE_CONFIDENCE;
        details.push(
          container
            ? `no published port; container '${container.name}' is running`
            : `no published port -- DevTwin cannot determine whether '${name}' is running`,
        );
      }

      infos.push({
        name,
        // `required` is what callers turn into "this must be running": claim it
        // only where DevTwin could actually check.
        required: confidence >= REQUIRED_CONFIDENCE,
        required_confidence: confidence,
        running,
        port,
        source: [`${filename} defines service '${name}'`],
        detail: details.length > 0 ? details.join('; ') : null,
      });
    }
  }
  return infos;
}

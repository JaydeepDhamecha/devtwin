/** Local service detection: which services a project needs, and their state. */

import type { ServiceInfo } from '../core/models.js';
import type { ServiceDetector } from './base.js';
import { detectGenericServices } from './generic.js';
import { PostgresDetector } from './postgres.js';
import { RedisDetector } from './redis.js';

export const DETECTORS: ServiceDetector[] = [new PostgresDetector(), new RedisDetector()];

export async function detectServices(
  root: string,
  dependencyNamesPresent: Set<string>,
): Promise<ServiceInfo[]> {
  let results: ServiceInfo[] = [];
  for (const d of DETECTORS) {
    results.push(await d.detect(root, dependencyNamesPresent));
  }
  results = results.filter((r) => r.required || r.running);
  results.push(...(await detectGenericServices(root)));
  return results;
}

export { ServiceDetector } from './base.js';
export { detectGenericServices } from './generic.js';
export { PostgresDetector } from './postgres.js';
export { RedisDetector } from './redis.js';

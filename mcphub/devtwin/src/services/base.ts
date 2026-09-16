/**
 * Local service detection contract.
 *
 * A service is "required" only when multiple independent signals point at it
 * -- an env var like `DATABASE_URL`, a compose service, a dependency on a
 * matching client library, or a README mention are each weak evidence alone.
 * Confidence is the sum of matched signal weights, capped at 1.0, so callers
 * (and the model) can see exactly why DevTwin thinks a service matters instead
 * of asserting it outright.
 */

import { join } from 'node:path';

import type { ServiceInfo } from '../core/models.js';
import { inspectDocker } from '../system/docker.js';
import { availableEnvNames } from '../system/environment.js';
import { readTextFile } from '../system/filesystem.js';
import { isPortListening } from '../system/ports.js';

export const SIGNAL_WEIGHTS: Record<string, number> = {
  env_var: 0.45,
  compose_service: 0.5,
  dependency: 0.35,
  config_file: 0.3,
  readme_hint: 0.15,
};

/** A matched signal: the human-readable evidence and its confidence weight. */
type Signal = [string, number];

export abstract class ServiceDetector {
  abstract readonly name: string;
  abstract readonly defaultPort: number;
  readonly envVarPatterns: readonly string[] = [];
  readonly dependencyNames: readonly string[] = [];
  readonly composeImageHints: readonly string[] = [];
  readonly readmeKeywords: readonly string[] = [];

  protected envSignal(): Signal | null {
    for (const name of availableEnvNames()) {
      for (const pattern of this.envVarPatterns) {
        if (new RegExp(pattern, 'i').test(name)) {
          return [`environment variable ${name} is set`, SIGNAL_WEIGHTS['env_var']!];
        }
      }
    }
    return null;
  }

  protected composeSignal(root: string): Signal | null {
    for (const filename of [
      'compose.yaml',
      'compose.yml',
      'docker-compose.yml',
      'docker-compose.yaml',
    ]) {
      const raw = readTextFile(join(root, filename));
      if (raw === null) {
        continue;
      }
      const text = raw.toLowerCase();
      for (const hint of this.composeImageHints) {
        if (text.includes(hint)) {
          return [`${filename} references image '${hint}'`, SIGNAL_WEIGHTS['compose_service']!];
        }
      }
    }
    return null;
  }

  protected dependencySignal(dependencyNamesPresent: Set<string>): Signal | null {
    const lowered = new Set([...dependencyNamesPresent].map((d) => d.toLowerCase()));
    for (const dep of this.dependencyNames) {
      if (lowered.has(dep.toLowerCase())) {
        return [`dependency on '${dep}' detected`, SIGNAL_WEIGHTS['dependency']!];
      }
    }
    return null;
  }

  protected readmeSignal(root: string): Signal | null {
    for (const filename of ['README.md', 'README', 'README.rst']) {
      const raw = readTextFile(join(root, filename));
      if (raw === null) {
        continue;
      }
      const text = raw.toLowerCase();
      for (const kw of this.readmeKeywords) {
        if (text.includes(kw.toLowerCase())) {
          return [`${filename} mentions '${kw}'`, SIGNAL_WEIGHTS['readme_hint']!];
        }
      }
    }
    return null;
  }

  async detect(root: string, dependencyNamesPresent: Set<string>): Promise<ServiceInfo> {
    const sources: string[] = [];
    let confidence = 0.0;

    for (const signal of [
      this.envSignal(),
      this.composeSignal(root),
      this.dependencySignal(dependencyNamesPresent),
      this.readmeSignal(root),
    ]) {
      if (signal) {
        const [text, weight] = signal;
        sources.push(text);
        confidence += weight;
      }
    }

    confidence = Math.min(1.0, confidence);
    const required = confidence >= 0.3;

    const running = await isPortListening(this.defaultPort);
    let detail: string | null = null;
    if (!running) {
      // A container may be up while the port isn't published/reachable -- say so
      // rather than reporting a flat "not running".
      const dockerInfo = await inspectDocker(root);
      for (const container of dockerInfo.containers) {
        if (this.composeImageHints.some((hint) => container.image.toLowerCase().includes(hint))) {
          detail = `container '${container.name}' is running but port ${this.defaultPort} is not reachable locally`;
          break;
        }
      }
    }

    return {
      name: this.name,
      required,
      required_confidence: Math.round(confidence * 100) / 100,
      running,
      port: this.defaultPort,
      source: sources,
      detail,
    };
  }
}

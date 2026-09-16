/**
 * Environment variable presence checks -- never values, for secrets.
 *
 * DevTwin only ever tells a model *whether* a variable is set and, for
 * non-secret variables, a capped preview. Secret-named variables never have
 * their value surfaced, per the privacy-first design principle.
 *
 * Scoping matters as much as redaction. The local DevTwin server runs inside
 * the developer's own shell, so `process.env` there IS the project's
 * environment. Hosted, it is the *platform's* environment instead -- reading
 * it would both leak platform-internal variables and give wrong answers about
 * the project. So the host environment is off by default: variables are read
 * from the workspace's own .env files, and `configureEnvSource` opts into the
 * host environment only where that is genuinely the project's environment.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';

import type { EnvironmentVariableStatus } from '../core/models.js';
import { isSecretName, safePreview } from '../security/secrets.js';
import { readTextFile } from './filesystem.js';

/** .env-style files consulted for declared variable names, in order. */
const DOTENV_FILENAMES = ['.env', '.env.local', '.env.development', '.env.example', '.env.sample'];

/** Platform-internal names that are never reported, even with host env enabled. */
const PLATFORM_RESERVED = new Set([
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'MCPHUB_API_KEY',
  'MCPHUB_TOKEN',
]);

interface EnvScope {
  hostEnvAllowed: boolean;
  projectEnvNames: Set<string>;
}

/**
 * The scope is per tool call, not per process: one manager instance serves
 * every caller, and its methods interleave at `await` points. Module-level
 * state would let one call's workspace leak into another's answers, so the
 * scope rides the async context instead.
 */
const envScopeStorage = new AsyncLocalStorage<EnvScope>();

const EMPTY_SCOPE: EnvScope = { hostEnvAllowed: false, projectEnvNames: new Set() };

function currentScope(): EnvScope {
  return envScopeStorage.getStore() ?? EMPTY_SCOPE;
}

/**
 * Point the env checks at a workspace. Call once per tool invocation, before
 * adapters or service detectors run. The scope applies to everything awaited
 * from the calling context onwards, and to nothing outside it.
 */
export function configureEnvSource(options: {
  allowHostEnv: boolean;
  workspace?: string | null;
}): void {
  const projectEnvNames = new Set<string>();
  if (options.workspace) {
    for (const filename of DOTENV_FILENAMES) {
      for (const name of loadDotenvVarNames(join(options.workspace, filename))) {
        projectEnvNames.add(name);
      }
    }
  }
  envScopeStorage.enterWith({ hostEnvAllowed: options.allowHostEnv, projectEnvNames });
}

/** Run `fn` under an explicit scope -- the safest form where a callback fits. */
export function withEnvSource<T>(
  options: { allowHostEnv: boolean; workspace?: string | null },
  fn: () => T,
): T {
  const projectEnvNames = new Set<string>();
  if (options.workspace) {
    for (const filename of DOTENV_FILENAMES) {
      for (const name of loadDotenvVarNames(join(options.workspace, filename))) {
        projectEnvNames.add(name);
      }
    }
  }
  return envScopeStorage.run(
    { hostEnvAllowed: options.allowHostEnv, projectEnvNames },
    fn,
  );
}

/** Every variable name DevTwin may consider, from the configured sources. */
export function availableEnvNames(): string[] {
  const { hostEnvAllowed, projectEnvNames } = currentScope();
  const names = new Set(projectEnvNames);
  if (hostEnvAllowed) {
    for (const name of Object.keys(process.env)) {
      if (!PLATFORM_RESERVED.has(name)) names.add(name);
    }
  }
  return [...names];
}

/** Read a value only when the host environment is the project's environment. */
function hostValue(name: string): string | undefined {
  if (!currentScope().hostEnvAllowed || PLATFORM_RESERVED.has(name)) return undefined;
  return process.env[name];
}

export function checkEnvVar(name: string): EnvironmentVariableStatus {
  const declaredInProject = currentScope().projectEnvNames.has(name);
  const value = hostValue(name);
  const secret = isSecretName(name);
  return {
    name,
    present: declaredInProject || value !== undefined,
    is_secret: secret,
    // Secret-named variables never get a preview, redacted or otherwise.
    value_preview: secret ? null : safePreview(name, value ?? null),
  };
}

export function checkEnvVars(names: string[]): EnvironmentVariableStatus[] {
  return names.map((n) => checkEnvVar(n));
}

/** Return variable *names* declared in a .env-style file. Never values. */
export function loadDotenvVarNames(path: string): string[] {
  const names: string[] = [];
  const text = readTextFile(path);
  if (text === null) {
    return [];
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    let key = line.split('=')[0]!.trim();
    if (key.startsWith('export ')) {
      key = key.slice('export '.length).trim();
    }
    if (key) {
      names.push(key);
    }
  }
  return names;
}

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
 *
 * Two questions a caller may ask are kept apart, because conflating them is how
 * a fresh clone starts looking broken: "does this project declare it needs the
 * variable" (`declaredEnvNames`/`isEnvVarDeclared` -- template files count) and
 * "does the variable actually have a value here" (`availableEnvNames`, and
 * `present` on a status -- template files never count).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';

import type { EnvironmentVariableStatus } from '../core/models.js';
import { isSecretName, safePreview } from '../security/secrets.js';
import { readTextFile } from './filesystem.js';

/** .env-style files that hold this workspace's real values, in order. */
const DOTENV_VALUE_FILENAMES = ['.env', '.env.local', '.env.development'];

/**
 * Template files. By definition these list the variables a developer still has
 * to set, so a name found only here is declared, never set -- counting it as
 * set is what turns "clone and run" into a false "required service is down".
 */
const DOTENV_TEMPLATE_FILENAMES = ['.env.example', '.env.sample'];

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
  /** names a workspace .env file gives a value to */
  projectEnvNames: Set<string>;
  /** names only a template file declares -- needed here, but not set here */
  templateEnvNames: Set<string>;
}

/** Split a workspace's .env files into "has a value" and "declared only". */
function scanWorkspaceEnv(workspace?: string | null): Omit<EnvScope, 'hostEnvAllowed'> {
  const projectEnvNames = new Set<string>();
  const templateEnvNames = new Set<string>();
  if (!workspace) {
    return { projectEnvNames, templateEnvNames };
  }
  for (const filename of DOTENV_VALUE_FILENAMES) {
    for (const name of loadDotenvVarNames(join(workspace, filename))) {
      projectEnvNames.add(name);
    }
  }
  for (const filename of DOTENV_TEMPLATE_FILENAMES) {
    for (const name of loadDotenvVarNames(join(workspace, filename))) {
      // A name a real .env file also sets is set, whatever the template says.
      if (!projectEnvNames.has(name)) templateEnvNames.add(name);
    }
  }
  return { projectEnvNames, templateEnvNames };
}

/**
 * The scope is per tool call, not per process: one manager instance serves
 * every caller, and its methods interleave at `await` points. Module-level
 * state would let one call's workspace leak into another's answers, so the
 * scope rides the async context instead.
 */
const envScopeStorage = new AsyncLocalStorage<EnvScope>();

const EMPTY_SCOPE: EnvScope = {
  hostEnvAllowed: false,
  projectEnvNames: new Set(),
  templateEnvNames: new Set(),
};

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
  envScopeStorage.enterWith({
    hostEnvAllowed: options.allowHostEnv,
    ...scanWorkspaceEnv(options.workspace),
  });
}

/** Run `fn` under an explicit scope -- the safest form where a callback fits. */
export function withEnvSource<T>(
  options: { allowHostEnv: boolean; workspace?: string | null },
  fn: () => T,
): T {
  return envScopeStorage.run(
    { hostEnvAllowed: options.allowHostEnv, ...scanWorkspaceEnv(options.workspace) },
    fn,
  );
}

/**
 * Every variable name that actually has a value here, from the configured
 * sources. Names a template file merely declares are *not* included: callers
 * (service detection, above all) read this list as "these are set".
 */
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

/**
 * Every variable the project declares it needs, set or not -- the union of its
 * .env files and its .env.example/.env.sample templates. Use this to answer
 * "what does this project need", never "what is configured here".
 */
export function declaredEnvNames(): string[] {
  const { projectEnvNames, templateEnvNames } = currentScope();
  return [...new Set([...projectEnvNames, ...templateEnvNames])];
}

/** Whether the project declares `name` at all, set or not. */
export function isEnvVarDeclared(name: string): boolean {
  const { projectEnvNames, templateEnvNames } = currentScope();
  return projectEnvNames.has(name) || templateEnvNames.has(name);
}

/** Read a value only when the host environment is the project's environment. */
function hostValue(name: string): string | undefined {
  if (!currentScope().hostEnvAllowed || PLATFORM_RESERVED.has(name)) return undefined;
  return process.env[name];
}

export function checkEnvVar(name: string): EnvironmentVariableStatus {
  const value = hostValue(name);
  const secret = isSecretName(name);
  // `present` is "this variable has a value here": a workspace .env file gives
  // it one (even when the value itself is never read), or the host environment
  // does and that environment is the project's. A variable only a template
  // declares is not set -- ask isEnvVarDeclared() for that question instead.
  const hasValue = currentScope().projectEnvNames.has(name) || value !== undefined;
  return {
    name,
    present: hasValue,
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

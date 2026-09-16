/**
 * Secret detection and redaction.
 *
 * DevTwin must never hand a model secret values. This module classifies
 * environment variable *names* as likely-secret and produces redacted previews
 * for the rest. Detection is name-based (context, not just substring) so we
 * don't flag every variable that happens to contain "KEY" as an obvious false
 * positive machine -- but we always err toward treating a variable as secret
 * when unsure, because leaking one secret is worse than over-redacting one.
 *
 * Nothing in this module ever returns, logs, or embeds a detected secret's
 * value: callers only ever get back the variable *name* and a placeholder.
 */

const SECRET_NAME_PATTERNS = [
  'PASSWORD',
  'PASSWD',
  'SECRET',
  'TOKEN',
  'API[_-]?KEY',
  'PRIVATE[_-]?KEY',
  'ACCESS[_-]?KEY',
  'AUTH',
  'CREDENTIAL',
  'CERT(IFICATE)?',
  'SIGNING[_-]?KEY',
  'CLIENT[_-]?SECRET',
  'SESSION[_-]?KEY',
  'ENCRYPTION[_-]?KEY',
];

const SECRET_NAME_RE = new RegExp(SECRET_NAME_PATTERNS.map((p) => `(?:${p})`).join('|'), 'i');

// Names that merely contain a sensitive-looking substring but conventionally
// hold non-secret data (e.g. flags/paths), so we don't over-flag them.
const ALLOWLIST = new Set(['AUTHOR', 'AUTHORS', 'PATH', 'GOPATH', 'GEM_PATH', 'NODE_AUTH_TOKEN_URL']);

/** Heuristically decide whether an env var *name* likely holds a secret. */
export function isSecretName(varName: string): boolean {
  const upper = varName.toUpperCase();
  if (ALLOWLIST.has(upper)) return false;
  return SECRET_NAME_RE.test(upper);
}

/** Return a redaction placeholder, never the real value. */
export function redact(value: string, options: { keep?: number } = {}): string {
  const keep = options.keep ?? 0;
  if (!value) return '<empty>';
  if (keep <= 0) return '<redacted>';
  return value.slice(0, keep) + '…<redacted>';
}

/**
 * Return a value preview safe to show a model, or null if absent.
 *
 * Secret-named variables never get their value echoed -- only presence.
 */
export function safePreview(varName: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (isSecretName(varName)) return '<redacted>';
  // Even non-secret values are capped to avoid dumping large blobs.
  return value.length <= 200 ? value : value.slice(0, 200) + '…';
}

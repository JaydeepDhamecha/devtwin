/**
 * Regression tests for the five defects found in code review.
 *
 * Each test fails loudly if the old behaviour comes back.
 * Usage: node scripts/regression-test.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, '.regress-build');

rmSync(buildDir, { recursive: true, force: true });
execFileSync(join(root, 'node_modules/.bin/tsc'), ['--outDir', buildDir, '--noEmit', 'false'], {
  cwd: root,
  stdio: 'pipe',
});
mkdirSync(buildDir, { recursive: true });
writeFileSync(
  join(buildDir, '_s.js'),
  'export class BasePlugin { async healthCheck(){return {healthy:true};} }\n',
);
const indexPath = join(buildDir, 'index.js');
writeFileSync(
  indexPath,
  readFileSync(indexPath, 'utf8').replace('@mcphub/core/src/mcp/base-plugin.js', './_s.js'),
);

const { default: Plugin } = await import(pathToFileURL(indexPath).href);
const { runCommand } = await import(pathToFileURL(join(buildDir, 'core/runner.js')).href);
const { DevTwinManager } = await import(pathToFileURL(join(buildDir, 'devtwin.manager.js')).href);

let failures = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`))
    .catch((e) => {
      console.log(`  FAIL  ${name} — ${e.message}`);
      failures += 1;
    });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const call = async (p, tool, args) =>
  JSON.parse((await p.handleToolCall(tool, args, {})).content[0].text);

const scratch = mkdtempSync(join(tmpdir(), 'devtwin-regress-'));
console.log('\nRegression tests\n');

// 1 — large command output must not be reported as "executable not found".
await test('runner: >80KB of output is captured, not misreported', async () => {
  // No process.exit(): it would close the pipe before the write flushes,
  // truncating the output for reasons unrelated to what is under test.
  const script = "process.stdout.write('x'.repeat(400000));";
  const r = await runCommand(['node', '-e', script], { timeout: 20 });
  assert(r.available === true, `available=${r.available} (regression: overflow read as not-runnable)`);
  assert(r.returncode === 0, `returncode=${r.returncode}, expected 0`);
  assert(r.stdout.length === 20000, `stdout=${r.stdout.length} chars, expected 20000 (truncated by us)`);
  return `400KB produced, ${r.stdout.length} chars kept, available=true`;
});

// 2 — an invalid field must not wipe the security-relevant settings.
await test('config: invalid update is rejected, allowlist survives', async () => {
  const p = new Plugin();
  const ok = await call(p, 'devtwin_configure', {
    config: { allowedWorkspaceRoots: scratch, enableCommandExecution: false },
  });
  assert(ok.status === 'ok', 'valid configure should succeed');
  const bad = await call(p, 'devtwin_configure', { config: { checkTimeoutSeconds: -5 } });
  assert(bad.status === 'error', `expected rejection, got ${bad.status}`);
  assert(
    bad.data.invalid_fields.includes('checkTimeoutSeconds'),
    `invalid_fields=${JSON.stringify(bad.data.invalid_fields)}`,
  );
  const st = await call(p, 'devtwin_status', {});
  assert(
    st.data.workspace_roots_restricted === true,
    'regression: allowedWorkspaceRoots was cleared by an unrelated invalid field',
  );
  assert(st.data.config.enableCommandExecution === false, 'regression: other settings were reset');
  return 'rejected, prior config intact';
});

// 3 — a symlink inside an allowed root must not escape it.
await test('guard: symlink out of an allowed root is refused', async () => {
  const allowed = join(scratch, 'allowed');
  const outside = join(scratch, 'outside');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'package.json'), '{"name":"secret"}');
  const escape = join(allowed, 'escape');
  try { symlinkSync(outside, escape, 'dir'); } catch { /* already there */ }

  const p = new Plugin();
  await call(p, 'devtwin_configure', { config: { allowedWorkspaceRoots: allowed } });
  const inside = await call(p, 'devtwin_detect', { workspace: allowed });
  assert(inside.status !== 'error' || !inside.summary.includes('outside'), 'allowed root was refused');
  const escaped = await call(p, 'devtwin_detect', { workspace: escape });
  assert(
    escaped.summary.includes('outside the configured allowedWorkspaceRoots'),
    `regression: symlink escaped the allowlist (got "${escaped.summary}")`,
  );
  return 'symlink refused, real path inside root allowed';
});

// 4 — the size guard must not claim a trim it did not perform.
await test('size guard: honest about what it trimmed', async () => {
  const m = new DevTwinManager({ maxResponseBytes: 10000 });
  // project_info holds no command output: nothing is safe to drop.
  const info = await m.projectInfo(resolve(root, '../..'));
  const serialized = Buffer.byteLength(JSON.stringify(info), 'utf8');
  if (serialized > 10000) {
    assert(
      info.data.output_omitted === undefined,
      'regression: claimed output was omitted from a payload with no command output',
    );
    assert(info.data.response_oversized === true, 'oversized payload not flagged');
  }
  // build_all stores output under ecosystems[].build_results, not results.
  const guard = Object.getPrototypeOf(m).constructor;
  assert(typeof guard === 'function', 'manager class unavailable');
  const fake = {
    status: 'ok',
    summary: 'built',
    data: {
      ecosystems: [
        {
          directory: 'android',
          build_results: [
            { command: './gradlew build', executed: true, passed: true, result: { executable: 'gradlew', args: [], returncode: 0, stdout: 'y'.repeat(60000), stderr: 'z'.repeat(60000), timed_out: false, available: true, duration_ms: 1 } },
          ],
        },
      ],
    },
    issues: [],
    recommendations: [],
  };
  const trimmed = m.enforceResponseSize(fake);
  const kept = trimmed.data.ecosystems[0].build_results[0].result.stdout.length;
  assert(kept === 2000, `regression: build_results not trimmed (stdout=${kept} chars)`);
  assert(trimmed.data.output_omitted === true, 'trim not reported');
  return `ecosystems[].build_results trimmed to ${kept} chars`;
});

// 5 — concurrent calls must not share env scope.
await test('env scope: concurrent calls do not cross-contaminate', async () => {
  const a = join(scratch, 'proj-a');
  const b = join(scratch, 'proj-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, 'package.json'), '{"name":"a"}');
  writeFileSync(join(b, 'package.json'), '{"name":"b"}');
  writeFileSync(join(a, '.env'), 'DATABASE_URL=postgres://a/db\n');
  writeFileSync(join(b, '.env'), 'UNRELATED=1\n');

  const m = new DevTwinManager({});
  const [ra, rb] = await Promise.all([m.services(a), m.services(b)]);
  const evidence = (r) => JSON.stringify(r.data.services.flatMap((s) => s.source));
  assert(
    evidence(ra).includes('DATABASE_URL'),
    `project A lost its own .env evidence: ${evidence(ra)}`,
  );
  assert(
    !evidence(rb).includes('DATABASE_URL'),
    `regression: project B saw project A's .env — ${evidence(rb)}`,
  );
  return "A keeps its evidence, B does not inherit it";
});

// 6 — empty scheme list must fall through, as it does in Python.
await test('swift: empty scheme array falls through instead of yielding undefined', async () => {
  const { asNonEmptyStringArray } = await import(
    pathToFileURL(join(buildDir, 'adapters/swift.js')).href
  );
  assert(asNonEmptyStringArray([]) === null, 'regression: [] treated as a usable scheme list');
  assert(asNonEmptyStringArray(undefined) === null, 'undefined should be null');
  assert(asNonEmptyStringArray([1, 2]) === null, 'non-string entries should be rejected');
  const ok = asNonEmptyStringArray(['App', 'Pods-App']);
  assert(ok !== null && ok[0] === 'App', 'valid list should pass through');
  // The Python `a or b` fall-through, written out.
  const project = asNonEmptyStringArray([]);
  const workspace = asNonEmptyStringArray(['WorkspaceScheme']);
  const chosen = project ?? workspace;
  assert(chosen[0] === 'WorkspaceScheme', 'regression: empty project list blocked the fall-through');
  return 'empty list falls through to workspace schemes';
});

rmSync(buildDir, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'all regression tests passed' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);

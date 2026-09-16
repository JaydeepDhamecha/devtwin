/**
 * Regression tests for every defect found in code review.
 *
 * Each test fails loudly if the old behaviour comes back.
 * Usage: node scripts/regression-test.mjs
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
const { runCommand, OUTPUT_OVERFLOW_NOTE } = await import(
  pathToFileURL(join(buildDir, 'core/runner.js')).href,
);
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

// 7 — an omitted workspace must fall through to the configured default.
await test('handlers: omitted workspace uses defaultWorkspace, not process.cwd()', async () => {
  const configured = join(scratch, 'default-ws');
  mkdirSync(configured, { recursive: true });
  writeFileSync(join(configured, 'package.json'), '{"name":"default-ws"}');
  writeFileSync(join(configured, 'DEFAULT_WORKSPACE_MARKER'), 'here\n');

  const p = new Plugin();
  const ok = await call(p, 'devtwin_configure', {
    config: { defaultWorkspace: configured, allowedWorkspaceRoots: configured },
  });
  assert(ok.status === 'ok', `configure failed: ${ok.summary}`);

  // No workspace argument at all. The old handler substituted a literal '.',
  // which the manager's `workspace || defaultWorkspace` could never override,
  // so the admin's setting was dead and process.cwd() was inspected instead.
  const info = await call(p, 'devtwin_project_info', {});
  assert(
    info.status !== 'error',
    `regression: the default workspace was refused by its own allowlist (${info.summary})`,
  );
  assert(
    info.data.top_level_entries.includes('DEFAULT_WORKSPACE_MARKER'),
    `regression: inspected ${JSON.stringify(info.data.top_level_entries.slice(0, 5))} — not the configured default`,
  );

  // An explicit workspace still wins over the default.
  const outside = await call(p, 'devtwin_project_info', { workspace: join(scratch, 'proj-a') });
  assert(
    outside.summary.includes('outside the configured allowedWorkspaceRoots'),
    `explicit workspace no longer takes precedence (got "${outside.summary}")`,
  );
  return 'omitted workspace inspected the configured default';
});

// 8 — a relative executable with a subdirectory must resolve against cwd.
await test('runner: nested relative executable resolves against the passed cwd', async () => {
  const project = join(scratch, 'php-proj');
  const binDir = join(project, 'vendor', 'bin');
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, 'phpunit');
  writeFileSync(script, '#!/bin/sh\necho phpunit-ran\n');
  chmodSync(script, 0o755);

  // Old code special-cased only a './' prefix; every other relative path fell
  // through to which(), which joins it to process.cwd() — the plugin server's
  // directory — so an allowlisted vendor/bin/phpunit was always "not installed".
  const r = await runCommand(['vendor/bin/phpunit'], { cwd: project, timeout: 10 });
  assert(
    r.available === true,
    'regression: nested relative executable reported as not installed',
  );
  assert(r.returncode === 0, `returncode=${r.returncode}, expected 0`);
  assert(r.stdout.includes('phpunit-ran'), `stdout=${JSON.stringify(r.stdout)}`);

  // The './gradlew' form and bare PATH lookups must keep their semantics.
  const dot = await runCommand(['./vendor/bin/phpunit'], { cwd: project, timeout: 10 });
  assert(dot.available === true, "regression: the './' prefix stopped resolving against cwd");
  const bare = await runCommand(['node', '-e', 'process.stdout.write("ok")'], { timeout: 10 });
  assert(bare.available === true && bare.stdout === 'ok', 'regression: bare PATH lookup broke');
  // A non-executable file is still not a runnable command.
  const plain = join(project, 'vendor', 'bin', 'notes.txt');
  writeFileSync(plain, 'not a program\n');
  chmodSync(plain, 0o644);
  const denied = await runCommand(['vendor/bin/notes.txt'], { cwd: project, timeout: 10 });
  assert(denied.available === false, 'regression: a non-executable file was accepted');
  return 'vendor/bin/phpunit found under cwd, X_OK check intact';
});

// 9 — the generic adapter must never hand `docker` to the build runner.
await test('generic: docker is never an executed build command', async () => {
  const { GenericAdapter } = await import(
    pathToFileURL(join(buildDir, 'adapters/generic.js')).href
  );
  const proj = join(scratch, 'dockerized');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'Dockerfile'), 'FROM alpine\n');
  writeFileSync(join(proj, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres\n');
  writeFileSync(join(proj, 'Makefile'), 'build:\n\techo built\n');

  const adapter = new GenericAdapter();
  const commands = await adapter.inspectBuildCommands(proj);
  assert(
    !commands.some((c) => c.includes('docker')),
    `regression: docker reached the build runner — ${JSON.stringify(commands)}`,
  );
  assert(commands.includes('make build'), `make build lost: ${JSON.stringify(commands)}`);

  // Removed from execution, re-surfaced as advice nothing runs.
  const codes = (await adapter.healthChecks(proj, [])).map((i) => i.code);
  assert(
    codes.includes('generic.docker_image_build_available'),
    `Dockerfile advice missing: ${JSON.stringify(codes)}`,
  );
  assert(
    codes.includes('generic.compose_services_available'),
    `compose advice missing: ${JSON.stringify(codes)}`,
  );
  return `${JSON.stringify(commands)}, advice: ${codes.length} issue(s)`;
});

// 10 — an interpolated value with a space must survive the quote/split round trip.
await test('swift: a scheme with a space stays one argv entry', async () => {
  const { joinArgs, shellQuote } = await import(
    pathToFileURL(join(buildDir, 'adapters/swift.js')).href
  );
  const { splitCommand } = await import(
    pathToFileURL(join(buildDir, 'security/permissions.js')).href
  );
  for (const scheme of ['My App', "Bob's App", 'Plain']) {
    const command = joinArgs(['xcodebuild', 'build', '-scheme', scheme, '-workspace', 'My App.xcworkspace']);
    const argv = splitCommand(command);
    assert(
      argv[0] === 'xcodebuild',
      `regression: executable got quoted, allowlist would miss it — ${JSON.stringify(argv[0])}`,
    );
    assert(
      argv[3] === scheme,
      `regression: "${scheme}" split into pieces — ${JSON.stringify(argv)}`,
    );
    assert(argv.length === 6, `expected 6 argv entries, got ${argv.length}: ${JSON.stringify(argv)}`);
  }
  assert(shellQuote('') === "''", 'an empty argument must not vanish');
  return 'space and apostrophe survive joinArgs -> splitCommand';
});

// 11 — a CocoaPods workspace must not build a pod instead of the app.
await test('swift: a Pods workspace does not select a Pods scheme', async () => {
  const { SwiftAdapter } = await import(pathToFileURL(join(buildDir, 'adapters/swift.js')).href);
  const { splitCommand } = await import(
    pathToFileURL(join(buildDir, 'security/permissions.js')).href
  );
  const proj = join(scratch, 'pods-app');
  mkdirSync(join(proj, 'MyApp.xcworkspace'), { recursive: true });
  writeFileSync(join(proj, 'Podfile'), "platform :ios, '16.0'\ntarget 'MyApp' do\nend\n");

  // Fake xcodebuild: the pod's own scheme comes first, as CocoaPods emits it.
  const fakeBin = join(scratch, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  const fake = join(fakeBin, 'xcodebuild');
  writeFileSync(
    fake,
    '#!/bin/sh\ncat <<\'JSON\'\n{"workspace":{"name":"MyApp","schemes":["Alamofire","Pods-MyApp","MyAppTests","MyApp"]}}\nJSON\n',
    { mode: 0o755 },
  );

  const realPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${realPath}`;
  try {
    const adapter = new SwiftAdapter();
    const commands = await adapter.inspectBuildCommands(proj);
    assert(commands.length === 1, `expected one build command, got ${JSON.stringify(commands)}`);
    const argv = splitCommand(commands[0]);
    const scheme = argv[argv.indexOf('-scheme') + 1];
    assert(
      !scheme.startsWith('Pods') && scheme !== 'Alamofire',
      `regression: DevTwin would build a dependency, not the app — scheme "${scheme}"`,
    );
    assert(scheme === 'MyApp', `expected the app scheme MyApp, got "${scheme}"`);
    // Platform comes from the Podfile, not from a hardcoded iOS assumption.
    assert(argv.includes('iphonesimulator'), `iOS SDK missing: ${JSON.stringify(argv)}`);
    // A generic simulator destination is always rejected by `xcodebuild test`.
    const tests = await adapter.inspectTests(proj);
    assert(tests.length === 0, `regression: emitted a test command xcodebuild rejects — ${JSON.stringify(tests)}`);
    const codes = (await adapter.healthChecks(proj, [])).map((i) => i.code);
    assert(codes.includes('swift.scheme_selected'), `scheme choice not reported: ${JSON.stringify(codes)}`);
    return `selected "${scheme}" out of 4 schemes, no test command emitted`;
  } finally {
    process.env.PATH = realPath;
  }
});

// ---------------------------------------------------------------------------
// Outcome accounting: a command that never ran must never be reported as a
// command that passed. `bazel` is a real build tool DevTwin does not
// allowlist, so `bazel build //...` is the canonical recognized-but-refused
// command; the slow build is allowlisted, real, and never finishes in time.
// ---------------------------------------------------------------------------

const REFUSED_BUILD = 'bazel build //...';
const REFUSED_CHECK = 'bazel test //...';
const SLOW_BUILD = 'node -e "setTimeout(() => {}, 30000)"';
// 20MB of output -- past MAX_CAPTURE_BYTES, so Node kills the child mid-write
// and it never reaches an exit status.
const NOISY_SCRIPT = "process.stdout.write('x'.repeat(20000000));";
const NOISY_BUILD = `node -e "${NOISY_SCRIPT}"`;
// A build whose only effect is a file on disk: evidence of a command that ran
// when the caller never successfully asked for anything.
const sentinel = join(scratch, 'sentinel-ran');
const SENTINEL_BUILD = `node -e "require('fs').writeFileSync('${sentinel}', 'ran')"`;
const sentinelA = join(scratch, 'sentinel-dual-a');
const sentinelB = join(scratch, 'sentinel-dual-b');
const DUAL_BUILD_A = `node -e "require('fs').writeFileSync('${sentinelA}', 'ran')"`;
const DUAL_BUILD_B = `node -e "require('fs').writeFileSync('${sentinelB}', 'ran')"`;
const checkSentinelA = join(scratch, 'sentinel-dual-check-a');
const checkSentinelB = join(scratch, 'sentinel-dual-check-b');
const DUAL_CHECK_A = `node -e "require('fs').writeFileSync('${checkSentinelA}', 'ran')"`;
const DUAL_CHECK_B = `node -e "require('fs').writeFileSync('${checkSentinelB}', 'ran')"`;

const { ADAPTERS, EcosystemAdapter } = await import(
  pathToFileURL(join(buildDir, 'adapters/index.js')).href
);

/** Adapter that emits fixed commands for any directory whose name is `marker`. */
class MarkerAdapter extends EcosystemAdapter {
  constructor(marker, commands) {
    super();
    this.ecosystem = `marker-${marker}`;
    this.marker = marker;
    this.commands = commands;
  }
  detect(root) {
    return root.endsWith(this.marker);
  }
  async inspectTests() {
    return this.commands.test ?? [];
  }
  async inspectBuildCommands() {
    return this.commands.build ?? [];
  }
}
ADAPTERS.push(
  new MarkerAdapter('bazel-check', { test: [REFUSED_CHECK] }),
  new MarkerAdapter('bazel-build', { build: [REFUSED_BUILD] }),
  new MarkerAdapter('slow-build', { build: [SLOW_BUILD] }),
  new MarkerAdapter('noisy-build', { build: [NOISY_BUILD] }),
  new MarkerAdapter('sentinel-build', { build: [SENTINEL_BUILD], test: [SENTINEL_BUILD] }),
  new MarkerAdapter('dual-build', { build: [DUAL_BUILD_A, DUAL_BUILD_B] }),
  new MarkerAdapter('dual-check', { test: [DUAL_CHECK_A, DUAL_CHECK_B] }),
);

/** A node-detected project (so the monorepo scans see an ecosystem) named `name`. */
function markerProject(name) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `{"name":"${name}"}`);
  return dir;
}

// 12 — a check that was refused by the allowlist is not a check that passed.
await test('check: a refused command is not reported as a passing check', async () => {
  const dir = markerProject('bazel-check');
  const p = new Plugin();
  const r = await call(p, 'devtwin_check', { workspace: dir });
  assert(r.data.recognized_commands.includes(REFUSED_CHECK), 'the command was not recognized');
  assert(r.data.results.every((x) => x.executed === false), 'something executed unexpectedly');
  assert(r.status !== 'ok', `regression: status=${r.status} for a check that never ran`);
  assert(r.data.executed_count === 0, `executed_count=${r.data.executed_count}, expected 0`);
  assert(r.data.passed_count === 0, `regression: passed_count=${r.data.passed_count}`);
  assert(r.data.refused_count === 1, `refused_count=${r.data.refused_count}, expected 1`);
  assert(r.data.refused_commands[0] === REFUSED_CHECK, 'refused command not named');
  assert(r.summary.includes('refused'), `regression: summary hides the refusal — "${r.summary}"`);
  // A refused *test* command is a check refusal, not a build refusal.
  assert(
    r.issues.some((i) => i.code === 'check.commands_refused'),
    `no check refusal issue: ${JSON.stringify(r.issues.map((i) => i.code))}`,
  );
  return `status=${r.status} — ${r.summary}`;
});

// 13 — the same defect in devtwin_build and devtwin_build_all.
await test('build: a refused command is not reported as a passing build', async () => {
  const dir = markerProject('bazel-build');
  const p = new Plugin();
  const r = await call(p, 'devtwin_build', { workspace: dir });
  assert(r.data.results.every((x) => x.executed === false), 'something executed unexpectedly');
  assert(r.status !== 'ok', `regression: status=${r.status} for a build that never ran`);
  assert(r.data.executed_count === 0, `executed_count=${r.data.executed_count}, expected 0`);
  assert(r.data.passed_count === 0, `regression: passed_count=${r.data.passed_count}`);
  assert(r.data.refused_count === 1, `refused_count=${r.data.refused_count}, expected 1`);
  assert(r.data.refused_commands[0] === REFUSED_BUILD, 'refused command not named');
  assert(r.summary.includes('refused'), `regression: summary hides the refusal — "${r.summary}"`);
  assert(
    r.issues.some((i) => i.code === 'build.commands_refused'),
    `no build refusal issue: ${JSON.stringify(r.issues.map((i) => i.code))}`,
  );

  // devtwin_build_all aggregated the same way: "backend (0/0)" with status ok.
  const all = await call(p, 'devtwin_build_all', { workspace: dir });
  assert(all.status !== 'ok', `regression: build_all status=${all.status} with nothing built`);
  const entry = all.data.ecosystems.find((e) => e.directory === '.');
  assert(entry, `root entry missing: ${JSON.stringify(all.data.ecosystems.map((e) => e.directory))}`);
  assert(entry.status !== 'ok', `regression: directory status=${entry.status}`);
  assert(entry.passed_count === 0 && entry.refused_count === 1, JSON.stringify(entry));
  assert(all.summary.includes('refused'), `regression: summary hides the refusal — "${all.summary}"`);
  return `build=${r.status}, build_all=${all.status}`;
});

// 14 — a build DevTwin stopped at its own clamped timeout is not a failed build.
await test('build: a timed-out build is not reported as a failure', async () => {
  const dir = markerProject('slow-build');
  const p = new Plugin();
  const cfg = await call(p, 'devtwin_configure', {
    config: { platformTimeoutBudgetSeconds: 1, buildTimeoutSeconds: 300 },
  });
  assert(cfg.status === 'ok', `configure failed: ${cfg.summary}`);

  const r = await call(p, 'devtwin_build', { workspace: dir });
  const outcome = r.data.results[0];
  assert(outcome && outcome.executed === true, `nothing executed: ${JSON.stringify(r.data.results)}`);
  assert(outcome.result.timed_out === true, `expected a timeout: ${JSON.stringify(outcome.result)}`);
  assert(
    r.data.failed_count === 0,
    `regression: a clamped timeout counted as ${r.data.failed_count} failed build(s)`,
  );
  assert(r.data.timed_out_count === 1, `timed_out_count=${r.data.timed_out_count}, expected 1`);
  assert(
    r.status !== 'error',
    "regression: status=error for a build stopped by DevTwin's own timeout budget",
  );
  assert(r.data.timeout_clamped === true, 'the clamp that caused the timeout is not surfaced');
  assert(
    r.data.effective_timeout_seconds === 1,
    `effective timeout not reported: ${r.data.effective_timeout_seconds}`,
  );
  assert(
    r.issues.some((i) => i.code === 'build.commands_timed_out'),
    `no timeout issue: ${JSON.stringify(r.issues.map((i) => i.code))}`,
  );
  return `status=${r.status}, timed_out=1, failed=0, clamped to 1s`;
});

// 15 — the workspace root itself must be scanned, and never scanned twice.
await test('scan: build_all/health_all scan the workspace root, once', async () => {
  const dir = markerProject('root-only');
  const p = new Plugin();

  const all = await call(p, 'devtwin_build_all', { workspace: dir });
  assert(
    !all.summary.includes('No recognized ecosystems'),
    `regression: a single-package repo reported nothing — "${all.summary}"`,
  );
  assert(
    all.data.ecosystems.some((e) => e.directory === '.'),
    `root not scanned: ${JSON.stringify(all.data.ecosystems.map((e) => e.directory))}`,
  );
  assert(all.status === 'unknown', `regression: nothing built, yet status=${all.status}`);

  const health = await call(p, 'devtwin_health_all', { workspace: dir });
  assert(
    health.data.ecosystems.some((e) => e.directory === '.'),
    `regression: health_all skipped the root — "${health.summary}"`,
  );

  // A configured subdirectory symlinked back at the root must not be built twice.
  try { symlinkSync(dir, join(dir, 'app'), 'dir'); } catch { /* already there */ }
  const again = await call(p, 'devtwin_build_all', { workspace: dir });
  const directories = again.data.ecosystems.map((e) => e.directory);
  assert(
    directories.length === 1 && directories[0] === '.',
    `regression: the root was scanned twice — ${JSON.stringify(directories)}`,
  );
  return `root scanned as '.', symlinked 'app' de-duplicated`;
});

// 16 — a partial configure must change only the fields the caller sent.
await test('config: a partial update keeps every field the caller omitted', async () => {
  const p = new Plugin();
  const first = await call(p, 'devtwin_configure', {
    config: {
      allowedWorkspaceRoots: scratch,
      allowHostEnvironment: true,
      defaultWorkspace: scratch,
      maxAutoBuildCommands: 3,
    },
  });
  assert(first.status === 'ok', `initial configure failed: ${first.summary}`);

  // One unrelated number. Every field in the schema carries a .default(), so
  // parsing this with the full schema returned a fully-populated object and
  // the spread reset everything below to its default — silently turning the
  // workspace allowlist back into "" (no restriction).
  const second = await call(p, 'devtwin_configure', { config: { maxOutputChars: 50000 } });
  assert(second.status === 'ok', `partial configure rejected: ${second.summary}`);
  const cfg = second.data.config;
  assert(cfg.maxOutputChars === 50000, `the field that WAS sent did not apply: ${cfg.maxOutputChars}`);
  assert(
    cfg.allowedWorkspaceRoots === scratch,
    `regression: allowedWorkspaceRoots reset to ${JSON.stringify(cfg.allowedWorkspaceRoots)} — an empty value means NO restriction`,
  );
  assert(
    cfg.allowHostEnvironment === true,
    'regression: allowHostEnvironment was reset by an unrelated update',
  );
  assert(cfg.defaultWorkspace === scratch, `regression: defaultWorkspace reset to ${cfg.defaultWorkspace}`);
  assert(cfg.maxAutoBuildCommands === 3, `regression: maxAutoBuildCommands reset to ${cfg.maxAutoBuildCommands}`);

  const st = await call(p, 'devtwin_status', {});
  assert(
    st.data.workspace_roots_restricted === true,
    'regression: the restriction was dropped by a one-field update',
  );

  // Validation and the reject-everything behaviour must survive the change.
  const bad = await call(p, 'devtwin_configure', { config: { maxOutputChars: 1 } });
  assert(bad.status === 'error', `an out-of-range value was accepted: ${bad.summary}`);
  assert(bad.data.invalid_fields.includes('maxOutputChars'), JSON.stringify(bad.data.invalid_fields));
  const after = await call(p, 'devtwin_status', {});
  assert(after.data.config.maxOutputChars === 50000, 'a rejected update changed a value');
  return 'one field changed, the other four survived, invalid still rejected';
});

// 17 — an omitted workspace must resolve once, for every part of the response.
await test('workspace: omitted argument inspects defaultWorkspace, consistently', async () => {
  const configured = join(scratch, 'resolve-once');
  mkdirSync(configured, { recursive: true });
  writeFileSync(join(configured, 'package.json'), '{"name":"resolve-once"}');
  writeFileSync(join(configured, 'RESOLVE_ONCE_MARKER'), 'here\n');
  const expected = realpathSync(configured);

  const p = new Plugin();
  const cfg = await call(p, 'devtwin_configure', { config: { defaultWorkspace: configured } });
  assert(cfg.status === 'ok', `configure failed: ${cfg.summary}`);

  // devtwin_project_info resolved the workspace twice: once inside
  // applyEnvScope (which honoured defaultWorkspace) and once by handing the
  // raw '' to detectProject/inspectWorkspace (which resolved it to
  // process.cwd()). A single response described two different directories.
  const info = await call(p, 'devtwin_project_info', {});
  assert(info.status !== 'error', `project_info failed: ${info.summary}`);
  assert(
    info.data.workspace.root === expected,
    `regression: workspace.root=${info.data.workspace.root}, expected ${expected}`,
  );
  assert(
    info.data.profile.root === expected,
    `regression: profile described ${info.data.profile.root} while the adapters read ${expected}`,
  );
  assert(
    info.data.top_level_entries.includes('RESOLVE_ONCE_MARKER'),
    `adapters read the wrong directory: ${JSON.stringify(info.data.top_level_entries.slice(0, 5))}`,
  );

  // devtwin_detect never went through applyEnvScope at all, so it ignored
  // defaultWorkspace outright.
  const detect = await call(p, 'devtwin_detect', {});
  assert(
    detect.data.workspace.root === expected && detect.data.profile.root === expected,
    `regression: detect read ${detect.data.profile.root} / ${detect.data.workspace.root}, expected ${expected}`,
  );
  assert(
    detect.data.profile.ecosystems.includes('node'),
    `the configured default was not detected: ${JSON.stringify(detect.data.profile.ecosystems)}`,
  );
  return `workspace.root, profile.root and the adapters all read ${expected}`;
});

// 18 — an omitted workspace must not become a way out of the allowlist.
await test('guard: a call with no workspace cannot read outside allowedWorkspaceRoots', async () => {
  const allowed = join(scratch, 'guarded-default');
  mkdirSync(allowed, { recursive: true });
  writeFileSync(join(allowed, 'package.json'), '{"name":"guarded"}');
  const expected = realpathSync(allowed);

  const p = new Plugin();
  const cfg = await call(p, 'devtwin_configure', {
    config: { defaultWorkspace: allowed, allowedWorkspaceRoots: allowed },
  });
  assert(cfg.status === 'ok', `configure failed: ${cfg.summary}`);

  // The guard checked the resolved defaultWorkspace and approved it, then the
  // inspection re-resolved the raw '' to process.cwd() — this repository,
  // which is outside the allowlist and was never approved by anything.
  const cwd = realpathSync(process.cwd());
  for (const tool of [
    'devtwin_detect',
    'devtwin_project_info',
    'devtwin_dependencies',
    'devtwin_drift',
    'devtwin_precommit',
  ]) {
    const r = await call(p, tool, {});
    assert(r.status !== 'error', `${tool} failed on its own default workspace: ${r.summary}`);
    assert(
      !JSON.stringify(r).includes(cwd),
      `regression: ${tool} with no workspace read ${cwd}, outside allowedWorkspaceRoots`,
    );
  }

  const detect = await call(p, 'devtwin_detect', {});
  assert(detect.data.profile.root === expected, `read ${detect.data.profile.root}, expected ${expected}`);

  // An explicit path outside the allowlist is still refused, as before.
  const outside = await call(p, 'devtwin_detect', { workspace: scratch });
  assert(
    outside.summary.includes('outside the configured allowedWorkspaceRoots'),
    `regression: an explicit path escaped the allowlist — "${outside.summary}"`,
  );
  return '5 tools stayed inside the allowlist with no workspace argument';
});

// 19 — the shipped timeout defaults must not cancel each other out.
await test('config: default platform budget does not clamp the default build timeout', async () => {
  const { configSchema } = await import(
    pathToFileURL(join(buildDir, 'config.schema.js')).href
  );
  const defaults = configSchema.parse({});
  // runRecognizedCommands applies Math.min(timeout, budget). With a 25s
  // budget the advertised 300s build timeout was unreachable and every real
  // ./gradlew or xcodebuild build was reported as timed out out of the box.
  assert(
    Math.min(defaults.buildTimeoutSeconds, defaults.platformTimeoutBudgetSeconds) ===
      defaults.buildTimeoutSeconds,
    `regression: the default budget (${defaults.platformTimeoutBudgetSeconds}s) clamps the default build timeout (${defaults.buildTimeoutSeconds}s)`,
  );
  assert(
    Math.min(defaults.checkTimeoutSeconds, defaults.platformTimeoutBudgetSeconds) ===
      defaults.checkTimeoutSeconds,
    `regression: the default budget clamps the default check timeout (${defaults.checkTimeoutSeconds}s)`,
  );
  // The ceiling still exists: lowering it must still clamp (test 14 proves
  // the clamp is reported); it simply no longer binds at default settings.
  const lowered = configSchema.parse({ platformTimeoutBudgetSeconds: 10 });
  assert(
    Math.min(lowered.buildTimeoutSeconds, lowered.platformTimeoutBudgetSeconds) === 10,
    'the platform ceiling stopped applying when an admin lowers it',
  );

  // The settings panel must not advertise a timeout the budget overrides.
  const meta = new Plugin().getConfigMeta().fields;
  for (const field of ['buildTimeoutSeconds', 'checkTimeoutSeconds', 'platformTimeoutBudgetSeconds']) {
    assert(
      /lower|override/i.test(meta[field].description),
      `regression: ${field}'s UI description does not mention the min() interaction`,
    );
  }
  return `build=${defaults.buildTimeoutSeconds}s, check=${defaults.checkTimeoutSeconds}s, budget=${defaults.platformTimeoutBudgetSeconds}s`;
});

// 20 — a command killed for producing too much output reached no verdict, so
// it is not a failed build. Reporting it as one invents exactly the compile
// error the outcome partition exists to avoid.
await test('runner: output past the capture ceiling is not reported as a failure', async () => {
  const r = await runCommand(['node', '-e', NOISY_SCRIPT], { timeout: 30 });
  assert(r.available === true, `available=${r.available} — the command did run`);
  assert(
    r.returncode === null,
    `regression: returncode=${r.returncode} — an overflow was given an exit status it never had`,
  );
  assert(r.timed_out === true, 'regression: overflow not flagged as stopped-without-a-verdict');
  assert(
    r.stderr.startsWith(OUTPUT_OVERFLOW_NOTE),
    `overflow reads exactly like a timeout: stderr="${r.stderr.slice(0, 60)}"`,
  );
  assert(r.stdout.length === 20000, `stdout=${r.stdout.length} chars, expected 20000`);

  // ...and the same command as a recognized build command, end to end.
  const dir = markerProject('noisy-build');
  const p = new Plugin();
  const build = await call(p, 'devtwin_build', { workspace: dir });
  const outcome = build.data.results[0];
  assert(outcome && outcome.executed === true, `nothing executed: ${JSON.stringify(build.data.results)}`);
  assert(
    build.data.failed_count === 0,
    `regression: a noisy build counted as ${build.data.failed_count} failed build(s)`,
  );
  assert(
    build.data.passed_count === 0,
    `regression: passed_count=${build.data.passed_count} for a build with no verdict`,
  );
  assert(build.data.timed_out_count === 1, `timed_out_count=${build.data.timed_out_count}, expected 1`);
  assert(
    build.status !== 'error',
    'regression: status=error for a build DevTwin stopped over output volume',
  );
  return `20MB produced, returncode=null, failed=0, status=${build.status}`;
});

// 21 — a malformed `run` is reported, never quietly widened into the default
// run of every recognized command.
await test('handlers: a malformed `run` does not silently run everything', async () => {
  const dir = markerProject('sentinel-build');
  const p = new Plugin();

  for (const [label, run] of [
    ['a string instead of an array', 'node --version'],
    ['a list of non-strings', [123]],
    ['a list with one unusable entry', [SENTINEL_BUILD, null]],
    ['an empty list', []],
  ]) {
    for (const tool of ['devtwin_build', 'devtwin_check']) {
      // Not `call`: a malformed argument must come back as an error, not as a
      // result envelope, so the response body is not JSON.
      const r = await p.handleToolCall(tool, { workspace: dir, run }, {});
      const text = r.content[0].text;
      assert(r.isError === true, `regression: ${tool} accepted ${label} — "${text}"`);
      assert(text.includes('run'), `${tool} error does not name the argument: "${text}"`);
      assert(!text.startsWith('{'), `regression: ${tool} answered ${label} with a result envelope`);
    }
    assert(!existsSync(sentinel), `regression: ${label} ran the project's commands anyway`);
  }

  // The sentinel only proves something if this project really does write it.
  const ok = await call(p, 'devtwin_build', { workspace: dir });
  assert(ok.data.passed_count === 1, `control build did not run: ${JSON.stringify(ok.data.results)}`);
  assert(existsSync(sentinel), 'control build ran but wrote no sentinel -- the test proves nothing');
  return '4 malformed selections rejected, nothing executed';
});

// 22 — an explicit `run` must still respect the per-call cap, and a name
// repeated in `run` must not spend the budget more than once.
await test('build: an explicit `run` is deduped and still capped', async () => {
  const dir = markerProject('dual-build');
  const p = new Plugin();
  await call(p, 'devtwin_configure', { config: { maxAutoBuildCommands: 1 } });

  const r = await call(p, 'devtwin_build', {
    workspace: dir,
    run: [DUAL_BUILD_A, DUAL_BUILD_B, DUAL_BUILD_A],
  });

  assert(r.data.results.length === 1, `regression: cap bypassed — ${JSON.stringify(r.data.results)}`);
  assert(
    r.data.skipped_commands.includes(DUAL_BUILD_B),
    `regression: B was not reported as skipped — ${JSON.stringify(r.data.skipped_commands)}`,
  );
  assert(existsSync(sentinelA), 'A should have run once');
  assert(!existsSync(sentinelB), 'regression: B ran despite the 1-command cap');
  return `run=[A,B,A] against cap=1 -> executed=${r.data.results.length}, skipped=${r.data.skipped_commands.length}`;
});

// 23 — devtwin_check must honour the same cap/dedup rules as devtwin_build.
await test('check: an explicit `run` is deduped and still capped', async () => {
  const dir = markerProject('dual-check');
  const p = new Plugin();
  await call(p, 'devtwin_configure', { config: { maxAutoCheckCommands: 1 } });

  const r = await call(p, 'devtwin_check', {
    workspace: dir,
    run: [DUAL_CHECK_A, DUAL_CHECK_B, DUAL_CHECK_A],
  });

  assert(r.data.results.length === 1, `regression: cap bypassed — ${JSON.stringify(r.data.results)}`);
  assert(
    r.data.skipped_commands.includes(DUAL_CHECK_B),
    `regression: B was not reported as skipped — ${JSON.stringify(r.data.skipped_commands)}`,
  );
  assert(existsSync(checkSentinelA), 'A should have run once');
  assert(!existsSync(checkSentinelB), 'regression: B ran despite the 1-command cap');
  return `run=[A,B,A] against cap=1 -> executed=${r.data.results.length}, skipped=${r.data.skipped_commands.length}`;
});

// 24 — a refused command occupying a slot in scan order must not push a real
// command past the shared budget (devtwin_build_all's per-target selection).
await test('selectCommands: a refused command does not eat the budget', async () => {
  const manager = new Plugin().getStandaloneService();
  const { toRun, skipped } = manager.selectCommands([REFUSED_BUILD, SENTINEL_BUILD], null, 1);
  assert(
    toRun.includes(SENTINEL_BUILD),
    `regression: real command dropped by a refusal occupying the budget slot — toRun=${JSON.stringify(toRun)}`,
  );
  assert(skipped.length === 0, `regression: nothing should be skipped here — ${JSON.stringify(skipped)}`);
  return `refused command is free; real command still fits under cap=1`;
});

const { withEnvSource, checkEnvVar, availableEnvNames, declaredEnvNames } = await import(
  pathToFileURL(join(buildDir, 'system/environment.js')).href
);

// 22 — a variable a template only declares must not be reported as set.
await test('env: .env.example declares a variable, it does not set one', async () => {
  const dir = join(scratch, 'env-example-only');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"env-example-only"}');
  writeFileSync(join(dir, '.env.example'), 'DATABASE_URL=postgres://user:pass@db:5432/app\n');

  withEnvSource({ allowHostEnv: false, workspace: dir }, () => {
    assert(
      checkEnvVar('DATABASE_URL').present === false,
      'regression: a variable only .env.example declares is reported as set',
    );
    assert(
      !availableEnvNames().includes('DATABASE_URL'),
      'regression: template-only name offered as an available value (drives "is set" signals)',
    );
    assert(declaredEnvNames().includes('DATABASE_URL'), 'the declaration itself was lost');
  });

  // The correction must not swing the other way: a real .env still sets it,
  // and a secret-named variable still never gets a preview.
  const configured = join(scratch, 'env-configured');
  mkdirSync(configured, { recursive: true });
  writeFileSync(join(configured, '.env'), 'DATABASE_URL=postgres://localhost/app\nAPI_KEY=abc123\n');
  withEnvSource({ allowHostEnv: false, workspace: configured }, () => {
    assert(checkEnvVar('DATABASE_URL').present === true, '.env no longer counts as set');
    const secret = checkEnvVar('API_KEY');
    assert(secret.present === true && secret.is_secret === true, JSON.stringify(secret));
    assert(secret.value_preview === null, `regression: secret preview "${secret.value_preview}"`);
  });

  // Where it used to surface: a fresh clone carrying only a template.
  const p = new Plugin();
  const health = await call(p, 'devtwin_health', { workspace: dir });
  const bogus = health.issues.filter((i) => i.code === 'service.not_running');
  assert(
    bogus.length === 0,
    `regression: .env.example manufactured ${JSON.stringify(bogus.map((i) => i.title))}`,
  );
  const svc = await call(p, 'devtwin_services', { workspace: dir });
  assert(
    svc.data.services.every((s) => !(s.required && !s.running)),
    `regression: required-but-stopped from a template alone — ${JSON.stringify(svc.data.services)}`,
  );
  return `declared=true, present=false, health=${health.data.health_score}`;
});

// 23 — a compose service DevTwin cannot probe is not a confident failure.
await test('services: a compose service with no published port is not called down', async () => {
  const dir = join(scratch, 'compose-internal');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"compose-internal"}');
  writeFileSync(
    join(dir, 'compose.yaml'),
    [
      'services:',
      '  migrator:',
      '    image: example/migrator:1',
      '  gateway:',
      '    image: example/gateway:1',
      '    ports:',
      '      - "58099:8080"',
      '',
    ].join('\n'),
  );

  const p = new Plugin();
  const r = await call(p, 'devtwin_services', { workspace: dir });
  const migrator = r.data.services.find((s) => s.name === 'migrator');
  const gateway = r.data.services.find((s) => s.name === 'gateway');
  assert(migrator, `compose service not detected: ${JSON.stringify(r.data.services)}`);
  assert(migrator.port === null, `port=${migrator.port}, expected null`);
  assert(
    migrator.required === false,
    'regression: a service with nothing to probe asserted as required-but-stopped',
  );
  assert(
    String(migrator.detail).includes('no published port'),
    `the reason is not surfaced: detail=${migrator.detail}`,
  );
  // A service that does publish a port is still checked as before.
  assert(gateway && gateway.required === true, `regression: probeable service weakened — ${JSON.stringify(gateway)}`);
  assert(gateway.port === 58099, `port=${gateway && gateway.port}, expected 58099`);

  const health = await call(p, 'devtwin_health', { workspace: dir });
  const invented = health.issues.filter(
    (i) => i.code === 'service.not_running' && i.title.includes('migrator'),
  );
  assert(invented.length === 0, `regression: "${invented[0] && invented[0].message}"`);
  return `migrator: port=null, required=false; gateway: required=true`;
});

// 24 — approvals.ts must classify this plugin's tools, not the Python ones.
await test('approvals: every tool in tools.ts has an explicit classification', async () => {
  const { tools } = await import(pathToFileURL(join(buildDir, 'tools.js')).href);
  const { classifyTool, classifiedToolNames, CONFIGURATION_TOOLS } = await import(
    pathToFileURL(join(buildDir, 'security/approvals.js')).href
  );
  const classified = new Set(classifiedToolNames());
  const names = tools.map((t) => t.name);

  const missing = names.filter((n) => !classified.has(n));
  assert(missing.length === 0, `unclassified tool(s): ${missing.join(', ')}`);
  const stale = [...classified].filter((n) => !names.includes(n));
  assert(stale.length === 0, `classified name(s) matching no tool: ${stale.join(', ')}`);

  // The stale dev_* names turned every read into an approval prompt.
  for (const name of names) {
    if (CONFIGURATION_TOOLS.has(name)) continue;
    assert(
      classifyTool(name) !== 'requires_approval',
      `regression: ${name} falls through to requires_approval`,
    );
  }
  assert(classifyTool('devtwin_detect') === 'read_only', `devtwin_detect=${classifyTool('devtwin_detect')}`);
  assert(classifyTool('devtwin_build') === 'safe', `devtwin_build=${classifyTool('devtwin_build')}`);
  assert(classifyTool('devtwin_build_all') === 'safe', `devtwin_build_all=${classifyTool('devtwin_build_all')}`);
  assert(classifyTool('devtwin_health_all') === 'read_only', `devtwin_health_all=${classifyTool('devtwin_health_all')}`);
  assert(classifyTool('devtwin_prepare') === 'read_only', `devtwin_prepare=${classifyTool('devtwin_prepare')}`);
  return `${names.length} tools, all classified`;
});

rmSync(buildDir, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'all regression tests passed' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);

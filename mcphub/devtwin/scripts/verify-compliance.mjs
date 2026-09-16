/**
 * Local compliance check for the MCPHub Basic 18.
 *
 * Compiles the plugin, stubs the platform's BasePlugin so the class can be
 * instantiated outside the MCPHub monorepo, and asserts each rule against the
 * real objects rather than against the source text.
 *
 * Usage: node scripts/verify-compliance.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, '.verify-build');

const checks = [];
function check(id, name, critical, fn) {
  try {
    const detail = fn();
    checks.push({ id, name, critical, pass: true, detail: detail ?? '' });
  } catch (error) {
    checks.push({ id, name, critical, pass: false, detail: error.message });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- compile

rmSync(buildDir, { recursive: true, force: true });
execFileSync(
  join(root, 'node_modules/.bin/tsc'),
  ['--outDir', buildDir, '--noEmit', 'false', '--declaration', 'false'],
  { cwd: root, stdio: 'pipe' },
);

// The platform supplies BasePlugin; stub it so index.js can be imported here.
mkdirSync(buildDir, { recursive: true });
writeFileSync(
  join(buildDir, '_base-plugin.stub.js'),
  `export class BasePlugin {
     getTools() { return []; }
     getConfigMeta() { return { groups: [], fields: {} }; }
     getSensitiveConfigFields() { return []; }
     getActionPlans() { return []; }
     async healthCheck() { return { healthy: true }; }
   }\n`,
);
const indexPath = join(buildDir, 'index.js');
writeFileSync(
  indexPath,
  readFileSync(indexPath, 'utf8').replace(
    '@mcphub/core/src/mcp/base-plugin.js',
    './_base-plugin.stub.js',
  ),
);

const { default: DevTwinPlugin } = await import(pathToFileURL(indexPath).href);
const { configSchema } = await import(pathToFileURL(join(buildDir, 'config.schema.js')).href);
const { tools } = await import(pathToFileURL(join(buildDir, 'tools.js')).href);

const plugin = new DevTwinPlugin();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// ----------------------------------------------------------------- checks

check(1, 'pricing — free/pro/enterprise tiers', true, () => {
  const p = plugin.pricing;
  assert(p && p.tools && p.limits, 'pricing.tools and pricing.limits are required');
  for (const tier of ['free', 'pro', 'enterprise']) {
    assert(p.tools[tier] !== undefined, `pricing.tools.${tier} missing`);
    assert(
      typeof p.limits[tier]?.callsPerMonth === 'number',
      `pricing.limits.${tier}.callsPerMonth missing`,
    );
  }
  return `free=${p.tools.free.length} pro=${p.tools.pro.length} enterprise=${p.tools.enterprise}`;
});

check(2, 'configSchema — zod schema with defaults', true, () => {
  const parsed = configSchema.safeParse({});
  assert(parsed.success, 'configSchema.safeParse({}) failed');
  return `${Object.keys(parsed.data).length} fields defaulted`;
});

check(3, 'configMeta — groups and fields', true, () => {
  const meta = plugin.getConfigMeta();
  assert(Array.isArray(meta.groups) && meta.groups.length > 0, 'groups missing');
  assert(meta.fields && Object.keys(meta.fields).length > 0, 'fields missing');
  const groupKeys = new Set(meta.groups.map((g) => g.key));
  for (const [field, def] of Object.entries(meta.fields)) {
    assert(groupKeys.has(def.group), `field ${field} references unknown group ${def.group}`);
  }
  const schemaFields = new Set(Object.keys(configSchema.safeParse({}).data));
  for (const field of Object.keys(meta.fields)) {
    assert(schemaFields.has(field), `configMeta field ${field} is not in the schema`);
  }
  return `${meta.groups.length} groups, ${Object.keys(meta.fields).length} fields`;
});

check(4, 'sensitiveFields — declared for every secret', true, () => {
  const sensitive = plugin.getSensitiveConfigFields();
  assert(Array.isArray(sensitive), 'getSensitiveConfigFields must return an array');
  const schemaFields = Object.keys(configSchema.safeParse({}).data);
  const secretLooking = schemaFields.filter((f) =>
    /key|token|secret|password|credential/i.test(f),
  );
  for (const field of secretLooking) {
    assert(sensitive.includes(field), `secret-looking field ${field} is not declared sensitive`);
  }
  return sensitive.length === 0 ? 'none (plugin holds no credentials)' : sensitive.join(', ');
});

check(5, 'actionPlans — at least one plan with 3+ steps', true, () => {
  const plans = plugin.getActionPlans();
  assert(Array.isArray(plans) && plans.length > 0, 'no action plans defined');
  const toolNames = new Set(tools.map((t) => t.name));
  for (const plan of plans) {
    assert(plan.steps.length >= 3, `plan ${plan.name} has ${plan.steps.length} steps, minimum 3`);
    for (const key of [
      'name',
      'display_name',
      'description',
      'trigger_phrases',
      'plugin_name',
      'expected_outcome',
      'steps',
    ]) {
      assert(plan[key] !== undefined, `plan ${plan.name} missing ${key}`);
    }
    for (const step of plan.steps) {
      for (const key of ['id', 'order', 'title', 'description', 'tool_to_call', 'expected_output']) {
        assert(step[key] !== undefined, `plan ${plan.name} step ${step.id} missing ${key}`);
      }
      assert(
        toolNames.has(step.tool_to_call),
        `plan ${plan.name} calls unknown tool ${step.tool_to_call}`,
      );
    }
  }
  return `${plans.length} plans, steps: ${plans.map((p) => p.steps.length).join('/')}`;
});

check(6, 'healthCheck — async health method', true, async () => 'see async section');

check(7, 'sdkMetadata — tool to SDK method map', false, () => {
  const meta = plugin.getSDKMetadata();
  const missing = tools.map((t) => t.name).filter((n) => !meta[n]);
  assert(missing.length === 0, `unmapped tools: ${missing.join(', ')}`);
  return `${Object.keys(meta).length} tools mapped`;
});

check(8, 'standaloneService — non-MCP usage', false, () => {
  const service = plugin.getStandaloneService();
  assert(service, 'getStandaloneService returned nothing');
  return service.constructor.name;
});

check(9, 'eventEmitter — standalone emits events', false, () => {
  const service = plugin.getStandaloneService();
  assert(typeof service.on === 'function' && typeof service.emit === 'function', 'not an EventEmitter');
  return 'DevTwinManager extends EventEmitter';
});

check(12, 'skillMd — SKILL.md exists at plugin root', true, () => {
  const path = join(root, 'SKILL.md');
  assert(existsSync(path), 'SKILL.md not found at plugin root');
  const text = readFileSync(path, 'utf8');
  assert(text.includes('mcphub-report-section'), 'Silent Completion Report section missing');
  for (const tool of tools) {
    assert(text.includes(tool.name), `SKILL.md does not document ${tool.name}`);
  }
  return `${text.split('\n').length} lines, all ${tools.length} tools documented`;
});

check(13, 'brandIcon — Lucide icon name plus SVG', true, () => {
  assert(typeof plugin.icon === 'string' && /^[a-z][a-z0-9-]*$/.test(plugin.icon),
    `icon "${plugin.icon}" is not a lucide-style name`);
  assert(existsSync(join(root, 'assets/icon.svg')), 'assets/icon.svg missing');
  return `icon=${plugin.icon}, assets/icon.svg present`;
});

check(14, 'toolNaming — one consistent prefix', true, () => {
  const prefix = `${plugin.name.replace(/-/g, '_')}_`;
  const bad = tools.map((t) => t.name).filter((n) => !n.startsWith(prefix));
  assert(bad.length === 0, `tools not using prefix ${prefix}: ${bad.join(', ')}`);
  const required = ['configure', 'status', 'remove', 'health_check', 'get_logs'];
  for (const suffix of required) {
    assert(
      tools.some((t) => t.name === `${prefix}${suffix}`),
      `required settings tool ${prefix}${suffix} missing`,
    );
  }
  return `${tools.length} tools, all "${prefix}", 5 settings tools present`;
});

check(15, 'toolCategories — every tool categorised', false, () => {
  const valid = new Set(['settings', 'core', 'service']);
  for (const tool of tools) {
    assert(valid.has(tool.category), `tool ${tool.name} has invalid category ${tool.category}`);
  }
  const counts = tools.reduce((acc, t) => ({ ...acc, [t.category]: (acc[t.category] ?? 0) + 1 }), {});
  return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
});

check(17, 'pricingCoverage — every tool in a tier', true, () => {
  const p = plugin.pricing;
  const covered = new Set();
  let wildcard = false;
  for (const tier of ['free', 'pro', 'enterprise']) {
    const value = p.tools[tier];
    if (value === '*') wildcard = true;
    else for (const name of value) covered.add(name);
  }
  if (!wildcard) {
    const missing = tools.map((t) => t.name).filter((n) => !covered.has(n));
    assert(missing.length === 0, `tools missing from pricing: ${missing.join(', ')}`);
  }
  for (const name of covered) {
    assert(tools.some((t) => t.name === name), `pricing lists unknown tool ${name}`);
  }
  return wildcard ? 'enterprise="*" covers all tools' : 'all tools tiered explicitly';
});

check(18, 'configDefaults — safeParse({}) succeeds', true, () => {
  const parsed = configSchema.safeParse({});
  assert(parsed.success, 'safeParse({}) failed');
  for (const [key, value] of Object.entries(parsed.data)) {
    assert(value !== undefined, `field ${key} has no default`);
  }
  return 'every field defaulted';
});

// Naming / packaging rules from 03-naming-standards.md
check('N1', 'package.json — name, main, version', true, () => {
  assert(pkg.name === `@mcphub/plugin-${plugin.name}`, `package name must be @mcphub/plugin-${plugin.name}`);
  assert(pkg.main === 'src/index.ts', 'main must be src/index.ts');
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version), 'version must be semver');
  assert(pkg.version === plugin.version, 'package.json version must match plugin version');
  return `${pkg.name}@${pkg.version}`;
});

check('N2', 'plugin name — kebab-case, <=30 chars, not reserved', true, () => {
  const reserved = new Set(['mcphub', 'mcp-hub', 'admin', 'portal', 'core', 'test', 'example', 'demo', 'plugin', 'tool', 'service']);
  assert(/^[a-z][a-z0-9-]*$/.test(plugin.name), 'name must be lowercase kebab-case');
  assert(plugin.name.length <= 30, 'name must be 30 characters or fewer');
  assert(!reserved.has(plugin.name), `name "${plugin.name}" is reserved`);
  assert(plugin.displayName && plugin.description, 'displayName and description are required');
  return `${plugin.name} (${plugin.name.length} chars), category=${plugin.category}`;
});

// Async checks
const asyncResults = [];
{
  try {
    const health = await plugin.healthCheck();
    assert(typeof health === 'object' && health !== null, 'healthCheck returned no object');
    assert('healthy' in health, 'healthCheck result has no healthy field');
    assert(health.details, 'healthCheck result has no details');
    const target = checks.find((c) => c.id === 6);
    target.pass = true;
    target.detail = `healthy=${health.healthy}, status=${health.details.status}`;
  } catch (error) {
    const target = checks.find((c) => c.id === 6);
    target.pass = false;
    target.detail = error.message;
  }
}

// ---------------------------------------------------------------- report

checks.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
let failedCritical = 0;
console.log('\nMCPHub compliance — DevTwin\n');
for (const c of checks) {
  const mark = c.pass ? 'PASS' : 'FAIL';
  const tag = c.critical ? 'critical' : 'optional';
  if (!c.pass && c.critical) failedCritical += 1;
  console.log(`  [${mark}] ${String(c.id).padEnd(3)} ${c.name} (${tag})`);
  if (c.detail) console.log(`         ${c.detail}`);
}
const passed = checks.filter((c) => c.pass).length;
console.log(`\n${passed}/${checks.length} checks passed, ${failedCritical} critical failures.\n`);
rmSync(buildDir, { recursive: true, force: true });
process.exit(failedCritical === 0 ? 0 : 1);

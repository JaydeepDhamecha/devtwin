/**
 * Swift ecosystem adapter: Swift Package Manager and Xcode (iOS/macOS) projects.
 */

import { basename, join } from 'node:path';

import {
  Presence,
  Severity,
  type AdapterResult,
  type DependencyInfo,
  type HealthIssue,
  type RuntimeInfo,
} from '../core/models.js';
import { runCommand, which } from '../core/runner.js';
import { globAny, pathExists, readTextFile } from '../system/filesystem.js';
import { EcosystemAdapter, extractVersion } from './base.js';

const TOOLS_VERSION_RE = /swift-tools-version:\s*([\d.]+)/;
// `SDKROOT = iphoneos;` / `SDKROOT = "macosx";` in an Xcode project's build settings.
const SDKROOT_RE = /SDKROOT\s*=\s*"?([A-Za-z0-9_.]+)"?/g;
// `platform :ios, '16.0'` at the top of a Podfile.
const PODFILE_PLATFORM_RE = /^\s*platform\s+:(\w+)/m;

// `xcodebuild -list` populates DerivedData on a cold cache and regularly takes
// longer than the runner's 10s default; bound it generously instead, and report
// a timeout explicitly rather than letting the feature disable itself in silence.
const SCHEME_LIST_TIMEOUT_SECONDS = 25;

// CocoaPods generates one scheme per pod plus a `Pods-<app>` aggregate. Those
// build a dependency, not the app, so they are never the right default guess.
const DEPENDENCY_SCHEME_PREFIXES = ['Pods-', 'Pods_'];
const DEPENDENCY_SCHEME_NAMES = new Set(['Pods']);
const TEST_SCHEME_SUFFIXES = ['Tests', 'UITests'];

// Characters shlex.quote() considers safe to leave bare. Keeping the executable
// name unquoted matters: the allowlist check downstream matches on argv[0].
const SHELL_SAFE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * POSIX-quote one argument -- Node has no `shlex.quote`.
 *
 * Embedded single quotes are escaped the `'"'"'` way rather than the more
 * familiar `'\''`: this plugin's own `splitCommand()` (security/permissions.ts)
 * has no backslash handling at all, so `'\''` would come back as the literal
 * characters `\` and `s`, while `'"'"'` round-trips through both that splitter
 * and a real shell. This is exactly what Python's `shlex.quote` emits.
 */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (SHELL_SAFE_RE.test(value)) return value;
  return `'${value.split("'").join(`'"'"'`)}'`;
}

/** `shlex.join` equivalent: an argv list rendered as one re-splittable string. */
export function joinArgs(args: string[]): string {
  return args.map(shellQuote).join(' ');
}

/** Narrow parsed JSON to a non-empty array of strings, or null. Exported for tests. */
export function asNonEmptyStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const strings = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return strings.length > 0 ? strings : null;
}

/**
 * Outcome of one `xcodebuild -list` probe.
 *
 * `status` is always populated, so a probe that timed out or failed is
 * distinguishable from "this project genuinely has no schemes" -- the caller
 * reports the reason instead of quietly emitting no commands.
 *
 * Internal to this adapter: nothing here is serialized over the wire.
 */
interface SchemeDetection {
  status: 'ok' | 'not_xcode' | 'xcodebuild_missing' | 'timed_out' | 'failed' | 'no_schemes';
  scheme: string | null;
  schemes: string[];
  /** Why this scheme was picked, so a wrong guess is debuggable. */
  reason: string | null;
  /** Why detection produced no scheme. */
  detail: string | null;
}

function detection(status: SchemeDetection['status'], extra: Partial<SchemeDetection> = {}): SchemeDetection {
  return { status, scheme: null, schemes: [], reason: null, detail: null, ...extra };
}

/**
 * Handles Swift Package Manager projects and Xcode (iOS/macOS) projects.
 *
 * For Xcode projects the emitted commands are tailored to the project's own
 * platform (`SDKROOT`): iOS builds target the simulator SDK, macOS builds
 * target macOS. Test commands are only emitted when a destination that can
 * actually run tests is known.
 */
export class SwiftAdapter extends EcosystemAdapter {
  readonly ecosystem = 'swift';

  // Adapter instances live in the module-level ADAPTERS list and are reused
  // across workspaces, so scheme detection is cached per root and cleared
  // around each run(): the cache exists to keep one run from forking
  // `xcodebuild -list` twice, not to survive between runs and go stale.
  private readonly schemeCache = new Map<string, SchemeDetection>();

  override async run(root: string): Promise<AdapterResult> {
    this.schemeCache.delete(root);
    try {
      return await super.run(root);
    } finally {
      this.schemeCache.delete(root);
    }
  }

  detect(root: string): boolean {
    if (pathExists(join(root, 'Package.swift')) || pathExists(join(root, 'Podfile'))) {
      return true;
    }
    return globAny(root, ['*.xcodeproj'], 1).length > 0 || globAny(root, ['*.xcworkspace'], 1).length > 0;
  }

  private usesSpm(root: string): boolean {
    return pathExists(join(root, 'Package.swift'));
  }

  private usesCocoapods(root: string): boolean {
    return pathExists(join(root, 'Podfile'));
  }

  private usesXcode(root: string): boolean {
    return globAny(root, ['*.xcodeproj'], 1).length > 0 || globAny(root, ['*.xcworkspace'], 1).length > 0;
  }

  /** First `*.xcworkspace` in `root`, or null -- the `next(root.glob(...), None)` equivalent. */
  private firstWorkspace(root: string): string | null {
    const matches = globAny(root, ['*.xcworkspace'], 1);
    return matches.length > 0 ? basename(matches[0]!) : null;
  }

  /** First `*.xcodeproj` in `root`, or null. */
  private firstProject(root: string): string | null {
    const matches = globAny(root, ['*.xcodeproj'], 1);
    return matches.length > 0 ? basename(matches[0]!) : null;
  }

  /** `MyApp.xcworkspace` -> `MyApp`; the `Path.stem` equivalent. */
  private static stem(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }

  /** Cached `probeSchemes()` -- at most one fork per adapter run. */
  private async schemeDetection(root: string): Promise<SchemeDetection> {
    const cached = this.schemeCache.get(root);
    if (cached !== undefined) {
      return cached;
    }
    const probed = await this.probeSchemes(root);
    this.schemeCache.set(root, probed);
    return probed;
  }

  /**
   * The scheme this adapter would build, or null when none could be chosen.
   *
   * Never throws and never blocks twice: see `schemeDetection()`.
   */
  private async detectScheme(root: string): Promise<string | null> {
    return (await this.schemeDetection(root)).scheme;
  }

  /**
   * Ask `xcodebuild -list -json` for this project's schemes.
   *
   * Every failure mode returns a populated `SchemeDetection` rather than null,
   * so `healthChecks()` can say *why* no command was emitted.
   */
  private async probeSchemes(root: string): Promise<SchemeDetection> {
    if (!this.usesXcode(root)) {
      return detection('not_xcode');
    }
    const xcodebuildPath = which('xcodebuild');
    if (xcodebuildPath === null) {
      return detection('xcodebuild_missing', {
        detail: 'No `xcodebuild` executable was found on PATH.',
      });
    }
    const workspace = this.firstWorkspace(root);
    const project = this.firstProject(root);
    const args = [xcodebuildPath, '-list', '-json'];
    if (workspace) {
      args.push('-workspace', workspace);
    } else if (project) {
      args.push('-project', project);
    } else {
      // detect() saw an .xcodeproj/.xcworkspace that is gone now.
      return detection('not_xcode');
    }

    const result = await runCommand(args, { cwd: root, timeout: SCHEME_LIST_TIMEOUT_SECONDS });
    if (result.timed_out) {
      return detection('timed_out', {
        detail:
          `\`xcodebuild -list\` did not finish within ${SCHEME_LIST_TIMEOUT_SECONDS}s ` +
          '(common on a cold DerivedData cache).',
      });
    }
    if (!result.available) {
      return detection('failed', {
        detail: `\`xcodebuild -list\` could not be executed: ${result.stderr.trim().slice(0, 200)}`,
      });
    }
    if (result.returncode !== 0) {
      const firstLine = result.stderr.trim().split('\n')[0] ?? '';
      return detection('failed', {
        detail: `\`xcodebuild -list\` exited ${result.returncode}. ${firstLine}`.trim(),
      });
    }

    const schemes = SwiftAdapter.parseSchemes(result.stdout);
    if (schemes === null) {
      return detection('failed', {
        detail: '`xcodebuild -list -json` did not return readable JSON.',
      });
    }
    if (schemes.length === 0) {
      return detection('no_schemes', {
        detail: '`xcodebuild -list -json` reported no schemes for this project.',
      });
    }
    const names = [workspace, project]
      .filter((n): n is string => n !== null)
      .map((n) => SwiftAdapter.stem(n));
    const { scheme, reason } = SwiftAdapter.selectScheme(schemes, names);
    return detection('ok', { scheme, schemes, reason });
  }

  /**
   * Scheme names from `xcodebuild -list -json`.
   *
   * Returns null when the output could not be parsed at all -- that is a
   * different (and worth reporting) outcome from "parsed fine, no schemes".
   */
  private static parseSchemes(stdout: string): string[] | null {
    let data: unknown;
    try {
      data = JSON.parse(stdout);
    } catch {
      return null;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return null;
    }
    const container = data as { project?: { schemes?: unknown }; workspace?: { schemes?: unknown } };
    // The Python original relies on an empty list being falsy, so it falls
    // through to the workspace schemes. `[]` is truthy in JS, so the
    // fall-through has to be written out, and an empty list must not
    // produce `undefined` from `schemes[0]`.
    const projectSchemes = asNonEmptyStringArray(container.project?.schemes);
    const workspaceSchemes = asNonEmptyStringArray(container.workspace?.schemes);
    return projectSchemes ?? workspaceSchemes ?? [];
  }

  private static normalize(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private static isDependencyScheme(scheme: string): boolean {
    return (
      DEPENDENCY_SCHEME_NAMES.has(scheme) ||
      DEPENDENCY_SCHEME_PREFIXES.some((prefix) => scheme.startsWith(prefix))
    );
  }

  private static isTestScheme(scheme: string): boolean {
    return TEST_SCHEME_SUFFIXES.some((suffix) => scheme.endsWith(suffix));
  }

  /**
   * Pick the scheme most likely to be the app, with the reason for the pick.
   *
   * Taking `schemes[0]` is wrong on a CocoaPods workspace, where the list
   * usually starts with a pod's own scheme: DevTwin would build a dependency,
   * report green, and never compile the app.
   */
  private static selectScheme(
    schemes: string[],
    projectNames: string[],
  ): { scheme: string; reason: string } {
    const wanted = new Set(
      projectNames.filter((n) => n.length > 0).map((n) => SwiftAdapter.normalize(n)),
    );
    for (const scheme of schemes) {
      if (wanted.has(SwiftAdapter.normalize(scheme))) {
        return { scheme, reason: 'matches the project/workspace name' };
      }
    }
    const appLike = schemes.filter(
      (s) => !SwiftAdapter.isDependencyScheme(s) && !SwiftAdapter.isTestScheme(s),
    );
    if (appLike.length > 0) {
      return {
        scheme: appLike[0]!,
        reason: 'first scheme that is neither a dependency nor a test scheme',
      };
    }
    const nonDependency = schemes.filter((s) => !SwiftAdapter.isDependencyScheme(s));
    if (nonDependency.length > 0) {
      return {
        scheme: nonDependency[0]!,
        reason: 'first scheme that is not a CocoaPods dependency scheme',
      };
    }
    return {
      scheme: schemes[0]!,
      reason: 'no app-like scheme found; fell back to the first scheme',
    };
  }

  /**
   * Return "ios"/"macos" from the project's own settings; null when unclear.
   *
   * Hardcoding the iOS simulator SDK makes every macOS Xcode project fail a
   * build DevTwin itself mis-specified, so an unknown platform means "emit no
   * SDK/destination flags" rather than "assume iOS".
   */
  private detectPlatform(root: string): string | null {
    // `root.glob("*.xcodeproj/project.pbxproj")` without the deep walk that a
    // slash-bearing pattern would trigger in globAny().
    const projects = globAny(root, ['*.xcodeproj'], 5)
      .map((p) => basename(p))
      .sort();
    for (const project of projects) {
      const text = readTextFile(join(root, project, 'project.pbxproj'));
      if (text === null) {
        continue;
      }
      const sdks = new Set<string>();
      // Fresh lastIndex per use: SDKROOT_RE is a module-level /g regex.
      SDKROOT_RE.lastIndex = 0;
      for (const match of text.matchAll(SDKROOT_RE)) {
        sdks.add(match[1]!.toLowerCase());
      }
      if ([...sdks].some((sdk) => sdk.startsWith('iphone'))) {
        return 'ios';
      }
      if ([...sdks].some((sdk) => sdk.startsWith('macosx'))) {
        return 'macos';
      }
    }
    const podfile = join(root, 'Podfile');
    if (pathExists(podfile)) {
      const text = readTextFile(podfile);
      if (text === null) {
        return null;
      }
      const match = PODFILE_PLATFORM_RE.exec(text);
      if (match) {
        const token = match[1]!.toLowerCase();
        if (token === 'ios') return 'ios';
        if (token === 'osx' || token === 'macos') return 'macos';
      }
    }
    return null;
  }

  /**
   * `-workspace X` / `-project Y`, or null when neither exists.
   *
   * Deliberately defensive: the glob can come back empty between detect() and
   * here, and a missing file must degrade instead of throwing.
   */
  private xcodeTargetArgs(root: string): string[] | null {
    const workspace = this.firstWorkspace(root);
    if (workspace) {
      return ['-workspace', workspace];
    }
    const project = this.firstProject(root);
    if (project) {
      return ['-project', project];
    }
    return null;
  }

  private buildDestinationArgs(root: string): string[] {
    const platform = this.detectPlatform(root);
    if (platform === 'macos') {
      return ['-destination', 'platform=macOS'];
    }
    if (platform === 'ios') {
      return ['-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator'];
    }
    return [];
  }

  private requiredToolsVersion(root: string): string | null {
    const f = join(root, 'Package.swift');
    if (!pathExists(f)) {
      return null;
    }
    const text = readTextFile(f);
    if (text === null) {
      return null;
    }
    const match = TOOLS_VERSION_RE.exec(text);
    return match ? match[1]! : null;
  }

  override async inspectRuntime(root: string): Promise<RuntimeInfo[]> {
    const required = this.requiredToolsVersion(root);
    const swiftPath = which('swift');
    if (swiftPath === null) {
      return [
        {
          name: 'swift',
          presence: Presence.NOT_INSTALLED,
          required_version: required,
          source: required ? 'Package.swift' : null,
        },
      ];
    }
    const result = await runCommand([swiftPath, '--version'], { timeout: 5 });
    const installed = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'swift',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        required_version: required,
        path: swiftPath,
        source: required ? 'Package.swift' : null,
      },
    ];
  }

  override async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    if (this.usesCocoapods(root)) {
      const lockfile = pathExists(join(root, 'Podfile.lock'));
      return {
        ecosystem: 'swift',
        manager: 'cocoapods',
        lockfile: lockfile ? 'Podfile.lock' : null,
        lockfile_present: lockfile,
        manifest_present: true,
        installed: Presence.UNKNOWN,
        dependency_count: null,
        dev_dependency_count: null,
        notes: [],
      };
    }
    if (this.usesSpm(root)) {
      const lockfile = pathExists(join(root, 'Package.resolved'));
      return {
        ecosystem: 'swift',
        manager: 'spm',
        lockfile: lockfile ? 'Package.resolved' : null,
        lockfile_present: lockfile,
        manifest_present: true,
        installed: Presence.UNKNOWN,
        dependency_count: null,
        dev_dependency_count: null,
        notes: [],
      };
    }
    return null;
  }

  override async inspectBuild(root: string): Promise<RuntimeInfo[]> {
    if (!this.usesXcode(root)) {
      return [];
    }
    const xcodebuildPath = which('xcodebuild');
    if (xcodebuildPath === null) {
      return [{ name: 'xcodebuild', presence: Presence.NOT_INSTALLED }];
    }
    const result = await runCommand([xcodebuildPath, '-version'], { timeout: 5 });
    const installed = result.available ? extractVersion(result.stdout) : null;
    return [
      {
        name: 'xcodebuild',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        path: xcodebuildPath,
      },
    ];
  }

  override async inspectTests(root: string): Promise<string[]> {
    const commands: string[] = [];
    if (this.usesSpm(root)) {
      commands.push('swift test');
    } else if (this.usesXcode(root)) {
      // `xcodebuild test` refuses a generic destination -- tests need a
      // concrete one. macOS is the only destination we can name without
      // probing the simulator list, so for iOS (and for an unknown
      // platform) we emit nothing: devtwin_check reporting "unknown" is
      // honest, a command xcodebuild always rejects is not.
      if (this.detectPlatform(root) !== 'macos') {
        return commands;
      }
      const scheme = await this.detectScheme(root);
      const target = this.xcodeTargetArgs(root);
      if (scheme && target) {
        commands.push(
          joinArgs(['xcodebuild', 'test', '-scheme', scheme, '-destination', 'platform=macOS', ...target]),
        );
      }
    }
    return commands;
  }

  override async inspectBuildCommands(root: string): Promise<string[]> {
    const commands: string[] = [];
    if (this.usesSpm(root)) {
      commands.push('swift build');
    } else if (this.usesXcode(root)) {
      const scheme = await this.detectScheme(root);
      const target = this.xcodeTargetArgs(root);
      if (scheme && target) {
        // joinArgs quotes every interpolated value: a scheme or project named
        // "My App" must stay one argv entry after splitCommand(), not two.
        commands.push(
          joinArgs([
            'xcodebuild',
            'build',
            '-scheme',
            scheme,
            ...this.buildDestinationArgs(root),
            ...target,
            'CODE_SIGNING_ALLOWED=NO',
          ]),
        );
      }
    }
    return commands;
  }

  override async healthChecks(root: string, runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const rt of runtimes) {
      if (rt.name === 'swift' && rt.presence === Presence.NOT_INSTALLED) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'swift.not_installed',
          title: 'Swift toolchain not found',
          message: 'No `swift` executable was found on PATH.',
          evidence: ['which swift -> not found'],
          recommendation: 'Install Xcode or the Swift toolchain from https://swift.org/install.',
          confidence: null,
        });
      }
    }
    issues.push(...(await this.xcodeSchemeIssues(root)));
    return issues;
  }

  /**
   * Report how (and whether) an Xcode scheme was chosen.
   *
   * Scheme detection decides which commands this adapter emits, so both the
   * guess and the failure to make one are reported instead of showing up as
   * an unexplained empty command list.
   */
  private async xcodeSchemeIssues(root: string): Promise<HealthIssue[]> {
    if (!this.usesXcode(root)) {
      return [];
    }
    const found = await this.schemeDetection(root); // cached: no extra fork
    const issues: HealthIssue[] = [];

    if (found.status === 'timed_out' || found.status === 'failed') {
      issues.push({
        severity: Severity.LOW,
        code: 'swift.scheme_detection_failed',
        title: 'Xcode scheme could not be detected',
        message: `${found.detail} No xcodebuild build or test command was emitted for this project.`,
        evidence: [`xcodebuild -list -json -> ${found.status}`],
        recommendation: 'Run `xcodebuild -list` in this directory to see the schemes.',
        confidence: null,
      });
      return issues;
    }
    if (found.status === 'no_schemes') {
      issues.push({
        severity: Severity.INFO,
        code: 'swift.no_schemes',
        title: 'Xcode project exposes no schemes',
        message: `${found.detail} No xcodebuild command was emitted.`,
        evidence: ['xcodebuild -list -json -> no schemes'],
        recommendation: 'Share a scheme in Xcode (Product > Scheme > Manage Schemes).',
        confidence: null,
      });
      return issues;
    }
    if (found.status !== 'ok' || !found.scheme) {
      return issues;
    }

    const platform = this.detectPlatform(root);
    issues.push({
      severity: Severity.INFO,
      code: 'swift.scheme_selected',
      title: `Xcode scheme '${found.scheme}' selected`,
      message:
        `DevTwin builds the '${found.scheme}' scheme (${found.reason}). ` +
        'Verify this is the app target if a build result looks wrong.',
      evidence: [`schemes: ${found.schemes.join(', ')}`, `platform: ${platform ?? 'unknown'}`],
      recommendation: null,
      confidence: null,
    });
    if (platform !== 'macos') {
      issues.push({
        severity: Severity.INFO,
        code: 'swift.xcode_tests_need_destination',
        title: 'No xcodebuild test command emitted',
        message:
          '`xcodebuild test` needs a concrete destination (a booted or named simulator); ' +
          'DevTwin does not pick one for you, so tests for this project are reported as ' +
          'unknown rather than failed.',
        evidence: [`platform: ${platform ?? 'unknown'}`],
        recommendation:
          "Run xcodebuild test yourself with -destination 'platform=iOS Simulator,name=<device>'.",
        confidence: null,
      });
    }
    return issues;
  }
}

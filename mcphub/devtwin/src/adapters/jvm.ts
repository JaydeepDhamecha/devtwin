/**
 * JVM ecosystem adapter: shared by Java and Kotlin (Gradle + Maven).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  Presence,
  Severity,
  type DependencyInfo,
  type EnvironmentVariableStatus,
  type HealthIssue,
  type RuntimeInfo,
} from '../core/models.js';
import { runCommand, which } from '../core/runner.js';
import { checkEnvVar, checkEnvVars } from '../system/environment.js';
import { existsAny, globAny, pathExists, readTextFile } from '../system/filesystem.js';
import { EcosystemAdapter, extractVersion } from './base.js';

const GRADLE_WRAPPER_VERSION_RE = /gradle-(\d+(?:\.\d+){1,2})-/;

/** Python's `Path.glob` is unbounded; the helper needs an explicit cap. */
const MAX_GLOB_MATCHES = 50;

/** `Path.expanduser()` equivalent -- only `~` and `~/...` are expanded. */
function expandUser(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Handles Java and Kotlin projects (Gradle and/or Maven). */
export class JvmAdapter extends EcosystemAdapter {
  readonly ecosystem = 'jvm';

  detect(root: string): boolean {
    const indicators = [
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      'gradlew',
    ];
    if (existsAny(root, indicators).length > 0) {
      return true;
    }
    return globAny(root, ['*.java'], 1).length > 0 || globAny(root, ['*.kt'], 1).length > 0;
  }

  private usesGradle(root: string): boolean {
    return (
      existsAny(root, [
        'build.gradle',
        'build.gradle.kts',
        'settings.gradle',
        'settings.gradle.kts',
      ]).length > 0
    );
  }

  private usesMaven(root: string): boolean {
    return pathExists(join(root, 'pom.xml'));
  }

  private hasKotlin(root: string): boolean {
    if (existsAny(root, ['build.gradle.kts', 'settings.gradle.kts']).length > 0) {
      return true;
    }
    return globAny(root, ['**/*.kt'], 1).length > 0;
  }

  /**
   * Overlay on top of the generic Gradle/JVM detection -- same idea as
   * `hasKotlin`. `local.properties` is gitignored by convention, so it
   * won't exist on a fresh clone; the module-level build file check is
   * what makes detection work before the project has ever been opened.
   */
  private isAndroid(root: string): boolean {
    if (pathExists(join(root, 'local.properties'))) {
      return true;
    }
    const manifestCandidates = [
      join(root, 'src', 'main', 'AndroidManifest.xml'),
      ...globAny(root, ['*/src/main/AndroidManifest.xml'], MAX_GLOB_MATCHES).map((rel) =>
        join(root, rel),
      ),
    ];
    if (manifestCandidates.some((p) => pathExists(p))) {
      return true;
    }
    const buildFiles = [
      join(root, 'build.gradle'),
      join(root, 'build.gradle.kts'),
      ...globAny(root, ['*/build.gradle', '*/build.gradle.kts'], MAX_GLOB_MATCHES).map((rel) =>
        join(root, rel),
      ),
    ];
    for (const f of buildFiles) {
      if (!pathExists(f)) {
        continue;
      }
      const text = readTextFile(f);
      if (text === null) {
        continue;
      }
      if (text.includes('com.android.application') || text.includes('com.android.library')) {
        return true;
      }
    }
    return false;
  }

  /** The `sdk.dir` value from local.properties, if declared. */
  private androidSdkDir(root: string): string | null {
    const props = join(root, 'local.properties');
    if (!pathExists(props)) {
      return null;
    }
    const text = readTextFile(props);
    if (text === null) {
      return null;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('sdk.dir=')) {
        // .properties files escape ':' and '\' (matters for Windows paths)
        return line
          .slice('sdk.dir='.length)
          .trim()
          .split('\\:')
          .join(':')
          .split('\\\\')
          .join('\\');
      }
    }
    return null;
  }

  private gradleWrapperVersion(root: string): string | null {
    const props = join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties');
    if (!pathExists(props)) {
      return null;
    }
    const text = readTextFile(props);
    if (text === null) {
      return null;
    }
    const match = GRADLE_WRAPPER_VERSION_RE.exec(text);
    return match ? match[1]! : null;
  }

  override async inspectRuntime(root: string): Promise<RuntimeInfo[]> {
    const runtimes: RuntimeInfo[] = [];

    const javaPath = which('java');
    if (javaPath === null) {
      runtimes.push({ name: 'java', presence: Presence.NOT_INSTALLED });
    } else {
      const result = await runCommand([javaPath, '-version'], { timeout: 5 });
      const output = result.stderr || result.stdout; // java -version prints to stderr
      const installed = result.available ? extractVersion(output) : null;
      runtimes.push({
        name: 'java',
        presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
        installed_version: installed,
        path: javaPath,
      });
    }

    if (this.hasKotlin(root)) {
      const kotlincPath = which('kotlinc');
      if (kotlincPath === null) {
        runtimes.push({ name: 'kotlin', presence: Presence.NOT_INSTALLED });
      } else {
        const result = await runCommand([kotlincPath, '-version'], { timeout: 15 });
        const output = result.stderr || result.stdout;
        const installed = result.available ? extractVersion(output) : null;
        runtimes.push({
          name: 'kotlin',
          presence: installed ? Presence.INSTALLED : Presence.UNKNOWN,
          installed_version: installed,
          path: kotlincPath,
        });
      }
    }

    return runtimes;
  }

  /**
   * Pick the right wrapper command for the current OS, without assuming
   * both `unixName` and `winName` were committed side by side.
   *
   * Both branches return a `./`-prefixed path, and that prefix is load-bearing:
   * the runner reads a separator-free name as a PATH lookup, so a bare
   * `gradlew.bat` would never find the wrapper committed in the workspace and
   * every JVM build on Windows would report the tool as not installed. Forward
   * slashes are fine on Windows -- `path.resolve` accepts them.
   */
  private wrapperInvocation(
    root: string,
    unixName: string,
    winName: string,
    fallback: string,
  ): string {
    if (process.platform === 'win32' && pathExists(join(root, winName))) {
      return `./${winName}`;
    }
    if (pathExists(join(root, unixName))) {
      return `./${unixName}`;
    }
    return fallback;
  }

  override async inspectBuild(root: string): Promise<RuntimeInfo[]> {
    const tools: RuntimeInfo[] = [];

    if (this.usesGradle(root)) {
      const required = this.gradleWrapperVersion(root);
      const gradlewSh = join(root, 'gradlew');
      const gradlewBat = join(root, 'gradlew.bat');
      const wrapper =
        process.platform === 'win32' && pathExists(gradlewBat) ? gradlewBat : gradlewSh;
      if (pathExists(gradlewSh) || pathExists(gradlewBat)) {
        tools.push({
          name: 'gradle-wrapper',
          presence: Presence.DETECTED,
          required_version: required,
          path: wrapper,
          source: 'gradle/wrapper/gradle-wrapper.properties',
        });
      } else {
        const gradlePath = which('gradle');
        if (gradlePath === null) {
          tools.push({
            name: 'gradle',
            presence: Presence.NOT_INSTALLED,
            required_version: required,
          });
        } else {
          const result = await runCommand([gradlePath, '--version'], { timeout: 15 });
          const installed = result.available ? extractVersion(result.stdout) : null;
          tools.push({
            name: 'gradle',
            presence: Presence.INSTALLED,
            installed_version: installed,
            required_version: required,
            path: gradlePath,
          });
        }
      }
    }

    if (this.usesMaven(root)) {
      const mvnwSh = join(root, 'mvnw');
      const mvnwCmd = join(root, 'mvnw.cmd');
      const wrapper = process.platform === 'win32' && pathExists(mvnwCmd) ? mvnwCmd : mvnwSh;
      if (pathExists(mvnwSh) || pathExists(mvnwCmd)) {
        tools.push({ name: 'maven-wrapper', presence: Presence.DETECTED, path: wrapper });
      } else {
        const mvnPath = which('mvn');
        if (mvnPath === null) {
          tools.push({ name: 'maven', presence: Presence.NOT_INSTALLED });
        } else {
          const result = await runCommand([mvnPath, '--version'], { timeout: 15 });
          const installed = result.available ? extractVersion(result.stdout) : null;
          tools.push({
            name: 'maven',
            presence: Presence.INSTALLED,
            installed_version: installed,
            path: mvnPath,
          });
        }
      }
    }

    return tools;
  }

  override async inspectDependencies(root: string): Promise<DependencyInfo | null> {
    if (this.usesGradle(root)) {
      return {
        ecosystem: 'jvm',
        manager: 'gradle',
        lockfile: null,
        lockfile_present: false,
        manifest_present: true,
        installed: Presence.UNKNOWN,
        dependency_count: null,
        dev_dependency_count: null,
        notes: [
          'Gradle does not use a single lockfile by default; dependency' +
            ' locking must be explicitly enabled per-project.',
        ],
      };
    }
    if (this.usesMaven(root)) {
      return {
        ecosystem: 'jvm',
        manager: 'maven',
        lockfile: null,
        lockfile_present: false,
        manifest_present: true,
        installed: Presence.UNKNOWN,
        dependency_count: null,
        dev_dependency_count: null,
        notes: [],
      };
    }
    return null;
  }

  override async inspectTests(root: string): Promise<string[]> {
    const commands: string[] = [];
    if (this.usesGradle(root)) {
      commands.push(`${this.wrapperInvocation(root, 'gradlew', 'gradlew.bat', 'gradle')} test`);
    }
    if (this.usesMaven(root)) {
      commands.push(`${this.wrapperInvocation(root, 'mvnw', 'mvnw.cmd', 'mvn')} test`);
    }
    return commands;
  }

  override async inspectBuildCommands(root: string): Promise<string[]> {
    const commands: string[] = [];
    if (this.usesGradle(root)) {
      commands.push(`${this.wrapperInvocation(root, 'gradlew', 'gradlew.bat', 'gradle')} build`);
    }
    if (this.usesMaven(root)) {
      commands.push(`${this.wrapperInvocation(root, 'mvnw', 'mvnw.cmd', 'mvn')} package`);
    }
    return commands;
  }

  override async inspectEnvironment(root: string): Promise<EnvironmentVariableStatus[]> {
    if (!this.isAndroid(root)) {
      return [];
    }
    return checkEnvVars(['ANDROID_HOME', 'ANDROID_SDK_ROOT']).filter((v) => v.present);
  }

  override async healthChecks(root: string, runtimes: RuntimeInfo[]): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    for (const rt of runtimes) {
      if (rt.name === 'java' && rt.presence === Presence.NOT_INSTALLED) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'jvm.java_not_installed',
          title: 'Java runtime not found',
          message: 'No `java` executable was found on PATH.',
          evidence: ['which java -> not found'],
          recommendation:
            'Install a JDK (e.g. via sdkman, your OS package manager, or Adoptium).',
        });
      }
    }

    if (this.isAndroid(root)) {
      const androidHome = checkEnvVar('ANDROID_HOME');
      const androidSdkRoot = checkEnvVar('ANDROID_SDK_ROOT');
      const sdkDir = this.androidSdkDir(root);

      if (!androidHome.present && !androidSdkRoot.present && sdkDir === null) {
        issues.push({
          severity: Severity.CRITICAL,
          code: 'android.sdk_location_unknown',
          title: 'Android SDK location cannot be determined',
          message:
            'This looks like an Android project, but neither ANDROID_HOME nor ' +
            'ANDROID_SDK_ROOT is set, and local.properties has no sdk.dir -- ' +
            'the Gradle build will fail to resolve the SDK.',
          evidence: [
            'ANDROID_HOME not set',
            'ANDROID_SDK_ROOT not set',
            'local.properties missing or has no sdk.dir',
          ],
          recommendation:
            'Set ANDROID_HOME, or open the project once in Android Studio ' +
            'to auto-generate local.properties.',
        });
      } else if (sdkDir !== null && !pathExists(expandUser(sdkDir))) {
        issues.push({
          severity: Severity.HIGH,
          code: 'android.sdk_dir_missing',
          title: "local.properties sdk.dir points to a path that doesn't exist",
          message: `local.properties declares sdk.dir=${sdkDir}, but that path was not found.`,
          evidence: [`sdk.dir=${sdkDir}`],
          recommendation:
            'Fix sdk.dir in local.properties, or delete the file and let ' +
            'Android Studio regenerate it.',
        });
      }
    }

    return issues;
  }
}

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  CodexDeckUpdateMethod,
  CodexDeckUpdateRequest,
  CodexDeckUpdateResponse,
  CodexDeckUpdateStatusResponse,
} from "./storage";

const execFileAsync = promisify(execFile);
const NPM_PACKAGE_NAME = "codex-deck";
const UPDATE_SETTINGS_FILE = "update-settings.json";
const ACTIVE_PROJECT_ROOT_FILE = "active-project-root";
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const NPM_CHECK_TIMEOUT_MS = 30 * 1000;

interface DaemonUpdateSettings {
  method: CodexDeckUpdateMethod;
  sourceRoot: string;
}

export interface DaemonUpdateCommandResult {
  stdout: string;
  stderr: string;
}

export type RunDaemonUpdateCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<DaemonUpdateCommandResult>;

export interface DaemonUpdaterOptions {
  currentVersion: string;
  managed: boolean;
  stateDir?: string;
  commandPath?: string;
  startDirectory?: string;
  npmExecutable?: string;
  pnpmExecutable?: string;
  runCommand?: RunDaemonUpdateCommand;
  scheduleRestart?: () => void;
  now?: () => Date;
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  scripts?: {
    build?: unknown;
  };
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/, "");
}

function parseVersion(value: string): {
  core: number[];
  prerelease: string[];
} | null {
  const normalized = normalizeVersion(value);
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const candidateVersion = parseVersion(candidate);
  const currentVersion = parseVersion(current);
  if (!candidateVersion || !currentVersion) {
    return normalizeVersion(candidate) !== normalizeVersion(current);
  }

  for (let index = 0; index < candidateVersion.core.length; index += 1) {
    if (candidateVersion.core[index] !== currentVersion.core[index]) {
      return candidateVersion.core[index] > currentVersion.core[index];
    }
  }

  if (candidateVersion.prerelease.length === 0) {
    return currentVersion.prerelease.length > 0;
  }
  if (currentVersion.prerelease.length === 0) {
    return false;
  }

  const length = Math.max(
    candidateVersion.prerelease.length,
    currentVersion.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const candidatePart = candidateVersion.prerelease[index];
    const currentPart = currentVersion.prerelease[index];
    if (candidatePart === undefined) {
      return false;
    }
    if (currentPart === undefined) {
      return true;
    }
    if (candidatePart === currentPart) {
      continue;
    }
    const candidateNumber = /^\d+$/.test(candidatePart)
      ? Number(candidatePart)
      : null;
    const currentNumber = /^\d+$/.test(currentPart)
      ? Number(currentPart)
      : null;
    if (candidateNumber !== null && currentNumber !== null) {
      return candidateNumber > currentNumber;
    }
    if (candidateNumber !== null) {
      return false;
    }
    if (currentNumber !== null) {
      return true;
    }
    return candidatePart.localeCompare(currentPart) > 0;
  }
  return false;
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<DaemonUpdateCommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: process.env,
      timeout: options.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const commandError = error as Error & {
      stdout?: string;
      stderr?: string;
    };
    const detail = (commandError.stderr || commandError.stdout || "").trim();
    throw new Error(
      detail
        ? `${command} failed: ${detail}`
        : `${command} failed: ${commandError.message}`,
    );
  }
}

function parseNpmVersionOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("npm did not return a codex-deck version");
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string" && parsed.trim()) {
      return normalizeVersion(parsed);
    }
    if (Array.isArray(parsed)) {
      const last = parsed.at(-1);
      if (typeof last === "string" && last.trim()) {
        return normalizeVersion(last);
      }
    }
  } catch {
    // npm may emit a plain version when a user-level config changes output.
  }
  if (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) {
    return normalizeVersion(trimmed);
  }
  throw new Error(`npm returned an invalid codex-deck version: ${trimmed}`);
}

async function readPackageManifest(
  projectRoot: string,
): Promise<PackageManifest> {
  const content = await readFile(join(projectRoot, "package.json"), "utf-8");
  return JSON.parse(content) as PackageManifest;
}

function normalizeOptionalPath(value: string | undefined): string {
  return value?.trim() ? resolve(value.trim()) : "";
}

function resolveUserPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

function legacyRunnerMatchesCurrentProcess(runnerPath: string): boolean {
  const entryPath = process.argv[1]?.trim();
  if (!entryPath || !process.argv.includes("--no-open")) {
    return false;
  }
  try {
    return readFileSync(runnerPath, "utf-8").includes(resolve(entryPath));
  } catch {
    return false;
  }
}

export function createDaemonUpdaterOptionsFromEnvironment(
  currentVersion: string,
): DaemonUpdaterOptions {
  const defaultStateDir = join(
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"),
    "codex-deck",
  );
  const defaultCommandPath = join(
    process.env.XDG_BIN_HOME?.trim() || join(homedir(), ".local", "bin"),
    "codex-deck-daemon",
  );
  const stateDir =
    normalizeOptionalPath(process.env.CODEX_DECK_DAEMON_STATE_DIR) ||
    defaultStateDir;
  const commandPath =
    normalizeOptionalPath(process.env.CODEX_DECK_DAEMON_COMMAND_PATH) ||
    defaultCommandPath;
  const startDirectory = normalizeOptionalPath(
    process.env.CODEX_DECK_DAEMON_START_DIRECTORY,
  );
  const explicitlyManaged =
    process.env.CODEX_DECK_DAEMON_MANAGED?.trim() === "1";
  const runnerPath = join(stateDir, "run-server.sh");
  const legacyDaemonDetected =
    process.env.NODE_ENV === "production" &&
    existsSync(commandPath) &&
    legacyRunnerMatchesCurrentProcess(runnerPath);
  return {
    currentVersion,
    managed: explicitlyManaged || legacyDaemonDetected,
    stateDir,
    commandPath,
    startDirectory: startDirectory || process.cwd(),
    npmExecutable: process.env.CODEX_DECK_DAEMON_NPM_BIN?.trim() || "npm",
    pnpmExecutable: process.env.CODEX_DECK_DAEMON_PNPM_BIN?.trim() || "pnpm",
  };
}

export class DaemonUpdater {
  private readonly currentVersion: string;
  private readonly managed: boolean;
  private readonly stateDir: string;
  private readonly commandPath: string;
  private readonly defaultSourceRoot: string;
  private readonly npmExecutable: string;
  private readonly pnpmExecutable: string;
  private readonly runCommand: RunDaemonUpdateCommand;
  private readonly scheduleRestart: () => void;
  private readonly now: () => Date;
  private readonly daemonStartedAt: string;
  private updateInProgress = false;
  private latestNpmVersion: string | null = null;
  private npmCheckedAt: string | null = null;

  constructor(options: DaemonUpdaterOptions) {
    this.currentVersion = normalizeVersion(options.currentVersion || "0.0.0");
    this.managed = options.managed;
    this.stateDir = normalizeOptionalPath(options.stateDir);
    this.commandPath = normalizeOptionalPath(options.commandPath);
    this.defaultSourceRoot =
      normalizeOptionalPath(options.startDirectory) || process.cwd();
    this.npmExecutable = options.npmExecutable?.trim() || "npm";
    this.pnpmExecutable = options.pnpmExecutable?.trim() || "pnpm";
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.now = options.now ?? (() => new Date());
    this.daemonStartedAt = this.now().toISOString();
    this.scheduleRestart =
      options.scheduleRestart ??
      (() => {
        const timer = setTimeout(() => {
          const child = spawn(this.commandPath, ["restart-after-update"], {
            cwd: this.defaultSourceRoot,
            env: process.env,
            detached: true,
            stdio: "ignore",
          });
          child.on("error", () => {});
          child.unref();
        }, 1_000);
        timer.unref?.();
      });
  }

  private unavailableReason(): string | null {
    if (!this.managed) {
      return "Live updates are available only when codex-deck is running through codex-deck-daemon.";
    }
    if (!this.stateDir || !this.commandPath) {
      return "The daemon update environment is incomplete. Reinstall the daemon from this codex-deck version.";
    }
    return null;
  }

  private async readSettings(): Promise<DaemonUpdateSettings> {
    const fallback: DaemonUpdateSettings = {
      method: "source",
      sourceRoot: this.defaultSourceRoot,
    };
    if (!this.stateDir) {
      return fallback;
    }
    try {
      const content = await readFile(
        join(this.stateDir, UPDATE_SETTINGS_FILE),
        "utf-8",
      );
      const parsed = JSON.parse(content) as Partial<DaemonUpdateSettings>;
      return {
        method: parsed.method === "npm" ? "npm" : "source",
        sourceRoot:
          typeof parsed.sourceRoot === "string" && parsed.sourceRoot.trim()
            ? resolve(parsed.sourceRoot.trim())
            : fallback.sourceRoot,
      };
    } catch {
      return fallback;
    }
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, content, { encoding: "utf-8", mode: 0o600 });
    await rename(temporaryPath, path);
  }

  private async writeSettings(settings: DaemonUpdateSettings): Promise<void> {
    await this.writeAtomic(
      join(this.stateDir, UPDATE_SETTINGS_FILE),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
  }

  private async activateProjectRoot(projectRoot: string): Promise<void> {
    if (projectRoot.includes("\n") || projectRoot.includes("\r")) {
      throw new Error("The project root must not contain line breaks");
    }
    await access(join(projectRoot, "dist", "index.js"));
    await this.writeAtomic(
      join(this.stateDir, ACTIVE_PROJECT_ROOT_FILE),
      `${projectRoot}\n`,
    );
  }

  async getStatus(): Promise<CodexDeckUpdateStatusResponse> {
    const settings = await this.readSettings();
    const unavailableReason = this.unavailableReason();
    return {
      daemonManaged: this.managed,
      restartSupported: unavailableReason === null,
      unavailableReason,
      currentVersion: this.currentVersion,
      updateMethod: settings.method,
      sourceRoot: settings.sourceRoot,
      defaultSourceRoot: this.defaultSourceRoot,
      daemonStartedAt: this.daemonStartedAt,
      updateInProgress: this.updateInProgress,
      npm: {
        checked: this.latestNpmVersion !== null,
        latestVersion: this.latestNpmVersion,
        updateAvailable: this.latestNpmVersion
          ? isVersionNewer(this.latestNpmVersion, this.currentVersion)
          : null,
        checkedAt: this.npmCheckedAt,
      },
    };
  }

  async checkNpm(): Promise<CodexDeckUpdateStatusResponse> {
    const result = await this.runCommand(
      this.npmExecutable,
      ["view", `${NPM_PACKAGE_NAME}@latest`, "version", "--json"],
      { timeoutMs: NPM_CHECK_TIMEOUT_MS },
    );
    this.latestNpmVersion = parseNpmVersionOutput(result.stdout);
    this.npmCheckedAt = this.now().toISOString();
    return await this.getStatus();
  }

  private assertCanUpdate(): void {
    const unavailableReason = this.unavailableReason();
    if (unavailableReason) {
      throw new Error(unavailableReason);
    }
    if (this.updateInProgress) {
      throw new Error("A daemon update is already in progress");
    }
  }

  private async updateFromNpm(
    settings: DaemonUpdateSettings,
  ): Promise<{ installedVersion: string; sourceRoot: null }> {
    const checked = await this.checkNpm();
    const latestVersion = checked.npm.latestVersion;
    if (!latestVersion) {
      throw new Error("npm did not return a codex-deck version");
    }

    const releasesRoot = join(this.stateDir, "releases");
    await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
    const safeVersion = latestVersion.replace(/[^0-9A-Za-z._-]/g, "-");
    const releaseRoot = join(
      releasesRoot,
      `npm-${safeVersion}-${randomUUID()}`,
    );
    await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
    try {
      await this.runCommand(
        this.npmExecutable,
        [
          "install",
          "--prefix",
          releaseRoot,
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          `${NPM_PACKAGE_NAME}@${latestVersion}`,
        ],
        { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS },
      );
      const packageRoot = join(releaseRoot, "node_modules", NPM_PACKAGE_NAME);
      const manifest = await readPackageManifest(packageRoot);
      if (
        manifest.name !== NPM_PACKAGE_NAME ||
        normalizeVersion(String(manifest.version ?? "")) !== latestVersion
      ) {
        throw new Error(
          "The npm release did not contain the expected codex-deck package",
        );
      }
      await this.writeSettings({ ...settings, method: "npm" });
      try {
        await this.activateProjectRoot(packageRoot);
      } catch (error) {
        await this.writeSettings(settings).catch(() => {});
        throw error;
      }
      return { installedVersion: latestVersion, sourceRoot: null };
    } catch (error) {
      await rm(releaseRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async updateFromSource(
    sourceRootInput: string | undefined,
  ): Promise<{ installedVersion: string; sourceRoot: string }> {
    if (!sourceRootInput?.trim()) {
      throw new Error("sourceRoot is required for a source update");
    }
    const sourceRoot = await realpath(resolveUserPath(sourceRootInput)).catch(
      () => {
        throw new Error(
          `Source project root does not exist: ${sourceRootInput.trim()}`,
        );
      },
    );
    if (sourceRoot.includes("\n") || sourceRoot.includes("\r")) {
      throw new Error("The source project root must not contain line breaks");
    }
    const manifest = await readPackageManifest(sourceRoot).catch((error) => {
      if (error instanceof SyntaxError) {
        throw new Error(
          `Invalid package.json in source project root: ${sourceRoot}`,
        );
      }
      throw new Error(
        `package.json was not found in source project root: ${sourceRoot}`,
      );
    });
    if (manifest.name !== NPM_PACKAGE_NAME) {
      throw new Error(
        `Source project package must be named ${NPM_PACKAGE_NAME}: ${sourceRoot}`,
      );
    }
    if (manifest.scripts?.build === undefined) {
      throw new Error(
        `Source project does not define a build script: ${sourceRoot}`,
      );
    }

    await this.runCommand(
      this.pnpmExecutable,
      ["--dir", sourceRoot, "install", "--frozen-lockfile"],
      { cwd: sourceRoot, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS },
    );
    await this.runCommand(this.pnpmExecutable, ["--dir", sourceRoot, "build"], {
      cwd: sourceRoot,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    });
    const previousSettings = await this.readSettings();
    await this.writeSettings({ method: "source", sourceRoot });
    try {
      await this.activateProjectRoot(sourceRoot);
    } catch (error) {
      await this.writeSettings(previousSettings).catch(() => {});
      throw error;
    }
    return {
      installedVersion: normalizeVersion(String(manifest.version ?? "0.0.0")),
      sourceRoot,
    };
  }

  async update(
    request: CodexDeckUpdateRequest,
  ): Promise<CodexDeckUpdateResponse> {
    this.assertCanUpdate();
    this.updateInProgress = true;
    try {
      const settings = await this.readSettings();
      const result =
        request.method === "npm"
          ? await this.updateFromNpm(settings)
          : await this.updateFromSource(request.sourceRoot);
      this.scheduleRestart();
      return {
        ok: true,
        method: request.method,
        installedVersion: result.installedVersion,
        sourceRoot: result.sourceRoot,
        restartScheduled: true,
        daemonStartedAt: this.daemonStartedAt,
        message:
          request.method === "npm"
            ? `Installed codex-deck ${result.installedVersion} from npm.`
            : `Built codex-deck from ${result.sourceRoot}.`,
      };
    } finally {
      this.updateInProgress = false;
    }
  }
}

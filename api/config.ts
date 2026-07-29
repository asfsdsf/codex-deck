import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDefaultCodexHome } from "./codex-home";

export interface CodexDeckRemoteConfig {
  serverUrl?: string;
  username?: string;
  password?: string;
  setupToken?: string;
  machineId?: string;
  pinnedRealmId?: string;
  pinnedOpaqueServerKey?: string;
}

export interface CodexDeckConfig {
  port?: number;
  dir?: string;
  dev?: boolean;
  open?: boolean;
  translationCommand?: string;
  remote?: CodexDeckRemoteConfig;
}

export interface LoadedCodexDeckConfig {
  /** Config files that were loaded, highest priority first. */
  paths: string[];
  config: CodexDeckConfig;
}

/** CLI option values that were explicitly passed on the command line. */
export interface CodexDeckCliOptions {
  port?: string;
  dir?: string;
  dev?: boolean;
  open?: boolean;
  remoteServerUrl?: string;
  remoteUsername?: string;
  remotePassword?: string;
  remoteSetupToken?: string;
  remoteMachineId?: string;
  remotePinnedRealmId?: string;
  remotePinnedOpaqueServerKey?: string;
}

export interface ResolvedCodexDeckOptions {
  port: number;
  dir: string;
  dev: boolean;
  open: boolean;
  remoteServerUrl?: string;
  remoteUsername?: string;
  remotePassword?: string;
  remoteSetupToken?: string;
  remoteMachineId?: string;
  remotePinnedRealmId?: string;
  remotePinnedOpaqueServerKey?: string;
  translationCommand?: string;
}

const DEFAULT_PORT = 12001;

const REMOTE_KEY_MAP: Record<string, keyof CodexDeckRemoteConfig> = {
  server_url: "serverUrl",
  username: "username",
  password: "password",
  setup_token: "setupToken",
  machine_id: "machineId",
  pinned_realm_id: "pinnedRealmId",
  pinned_opaque_server_key: "pinnedOpaqueServerKey",
};

/**
 * Parses the small TOML subset supported by codex-deck config files:
 * comments, `[remote]` table, double-quoted strings, integers, booleans.
 * Unknown keys, unknown tables, and malformed lines are ignored.
 */
export function parseConfigToml(content: string): CodexDeckConfig {
  const config: CodexDeckConfig = {};
  let table = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const tableMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (tableMatch && tableMatch[1]) {
      table = tableMatch[1].trim();
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kvMatch || !kvMatch[1]) {
      continue;
    }
    const key = kvMatch[1];
    const rawValue = kvMatch[2] ?? "";
    if (table === "") {
      assignTopLevel(config, key, rawValue);
    } else if (table === "remote") {
      const mapped = REMOTE_KEY_MAP[key];
      if (!mapped) {
        continue;
      }
      const value = parseTomlString(rawValue);
      if (value !== undefined) {
        (config.remote ??= {})[mapped] = value;
      }
    }
  }
  return config;
}

function assignTopLevel(
  config: CodexDeckConfig,
  key: string,
  rawValue: string,
): void {
  switch (key) {
    case "port": {
      const value = parseTomlInteger(rawValue);
      if (value !== undefined && value > 0 && value <= 65535) {
        config.port = value;
      }
      break;
    }
    case "dir": {
      const value = parseTomlString(rawValue);
      if (value?.trim()) {
        config.dir = value;
      }
      break;
    }
    case "dev": {
      const value = parseTomlBoolean(rawValue);
      if (value !== undefined) {
        config.dev = value;
      }
      break;
    }
    case "open": {
      const value = parseTomlBoolean(rawValue);
      if (value !== undefined) {
        config.open = value;
      }
      break;
    }
    case "translation_command": {
      const value = parseTomlString(rawValue);
      if (value?.trim()) {
        config.translationCommand = value;
      }
      break;
    }
    default:
      break;
  }
}

function parseTomlString(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('"')) {
    return undefined;
  }
  let result = "";
  let escaped = false;
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escaped) {
      result += ch === "n" ? "\n" : ch === "t" ? "\t" : ch === "r" ? "\r" : ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      return result;
    }
    result += ch;
  }
  return undefined;
}

function parseTomlInteger(rawValue: string): number | undefined {
  const match = /^[+-]?\d+/.exec(rawValue.trim());
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[0], 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseTomlBoolean(rawValue: string): boolean | undefined {
  const trimmed = rawValue.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return undefined;
}

/**
 * Returns existing config files in priority order:
 * `./config.toml` (cwd) first, then `$CODEX_HOME/codex-deck/config.toml`.
 */
export function findConfigFiles(cwd: string, codexHome: string): string[] {
  const paths: string[] = [];
  const localPath = join(cwd, "config.toml");
  if (existsSync(localPath)) {
    paths.push(localPath);
  }
  const homePath = join(codexHome, "codex-deck", "config.toml");
  if (existsSync(homePath)) {
    paths.push(homePath);
  }
  return paths;
}

/**
 * Merges two parsed configs per key: values from `high` win, keys only
 * present in `low` still apply. The `[remote]` table merges per key too.
 */
export function mergeCodexDeckConfigs(
  high: CodexDeckConfig,
  low: CodexDeckConfig,
): CodexDeckConfig {
  const merged: CodexDeckConfig = {};
  const port = high.port ?? low.port;
  if (port !== undefined) {
    merged.port = port;
  }
  const dir = high.dir ?? low.dir;
  if (dir !== undefined) {
    merged.dir = dir;
  }
  const dev = high.dev ?? low.dev;
  if (dev !== undefined) {
    merged.dev = dev;
  }
  const open = high.open ?? low.open;
  if (open !== undefined) {
    merged.open = open;
  }
  const translationCommand = high.translationCommand ?? low.translationCommand;
  if (translationCommand !== undefined) {
    merged.translationCommand = translationCommand;
  }
  if (high.remote || low.remote) {
    const remote: CodexDeckRemoteConfig = {};
    for (const key of Object.values(REMOTE_KEY_MAP)) {
      const value = high.remote?.[key] ?? low.remote?.[key];
      if (value !== undefined) {
        remote[key] = value;
      }
    }
    merged.remote = remote;
  }
  return merged;
}

export function loadCodexDeckConfig(
  cwd = process.cwd(),
  codexHome = resolveDefaultCodexHome(),
): LoadedCodexDeckConfig {
  const paths: string[] = [];
  let config: CodexDeckConfig = {};
  for (const path of findConfigFiles(cwd, codexHome)) {
    try {
      config = mergeCodexDeckConfigs(
        config,
        parseConfigToml(readFileSync(path, "utf-8")),
      );
      paths.push(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to read config file ${path}: ${message}`);
    }
  }
  return { paths, config };
}

/**
 * Merges option sources in priority order:
 * CLI arguments > environment variables > config file > built-in defaults.
 */
export function resolveCodexDeckOptions(
  cli: CodexDeckCliOptions,
  config: CodexDeckConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCodexDeckOptions {
  const portRaw =
    cli.port ?? (config.port !== undefined ? String(config.port) : "12001");
  const parsedPort = Number.parseInt(portRaw, 10);
  const port =
    Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_PORT;

  return {
    port,
    dir: cli.dir ?? config.dir ?? resolveDefaultCodexHome(env.CODEX_HOME),
    dev: cli.dev ?? config.dev ?? false,
    open: cli.open ?? config.open ?? true,
    remoteServerUrl:
      cli.remoteServerUrl ??
      env.CODEXDECK_REMOTE_SERVER_URL ??
      config.remote?.serverUrl,
    remoteUsername:
      cli.remoteUsername ??
      env.CODEXDECK_REMOTE_USERNAME ??
      config.remote?.username,
    remotePassword:
      cli.remotePassword ??
      env.CODEXDECK_REMOTE_PASSWORD ??
      config.remote?.password,
    remoteSetupToken:
      cli.remoteSetupToken ??
      env.CODEXDECK_REMOTE_SETUP_TOKEN ??
      config.remote?.setupToken,
    remoteMachineId:
      cli.remoteMachineId ??
      env.CODEXDECK_REMOTE_MACHINE_ID ??
      config.remote?.machineId,
    remotePinnedRealmId:
      cli.remotePinnedRealmId ??
      env.CODEXDECK_REMOTE_PINNED_REALM_ID ??
      config.remote?.pinnedRealmId,
    remotePinnedOpaqueServerKey:
      cli.remotePinnedOpaqueServerKey ??
      env.CODEXDECK_REMOTE_PINNED_OPAQUE_SERVER_KEY ??
      config.remote?.pinnedOpaqueServerKey,
    translationCommand: config.translationCommand,
  };
}

import { randomUUID } from "node:crypto";
import {
  nativePages,
  nativeRecord,
  readExperimentalFeatures,
} from "./codex-native";
import type { ExtensionRpc } from "./codex-extensions";
import { CodexInputError } from "./codex-input-error";

/**
 * Native apps (connectors), plugins, and marketplaces for `/apps` and
 * `/plugins`, following upstream codex-rs/tui/src/chatwidget/connectors.rs,
 * plugins.rs, and plugin_catalog.rs. Install targets and identities are always
 * re-derived from the server's own catalog rather than trusted from browsers.
 */

const HIDDEN_MARKETPLACES = new Set(["openai-bundled"]);
const LONG_TIMEOUT_MS = 5 * 60_000;
const HTTP_URL = /^https?:\/\//i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function httpUrl(value: unknown): string | null {
  const url = text(value);
  return url && HTTP_URL.test(url) ? url : null;
}

export interface CodexAppView {
  id: string;
  name: string;
  description: string | null;
  developer: string | null;
  category: string | null;
  installUrl: string | null;
  isAccessible: boolean;
  isEnabled: boolean;
  pluginDisplayNames: string[];
  statusLabel: string;
}
export interface CodexAppsSnapshot {
  enabled: boolean;
  disabledReason: string | null;
  apps: CodexAppView[];
}
export interface CodexPluginView {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  developer: string | null;
  category: string | null;
  marketplaceName: string;
  installed: boolean;
  enabled: boolean;
  statusLabel: string;
  authPolicy: string | null;
  featured: boolean;
  canToggle: boolean;
  canInstall: boolean;
  installBlockedReason: string | null;
  canUninstall: boolean;
  uninstallBlockedReason: string | null;
  sourceSummary: string;
  keywords: string[];
}
export interface CodexMarketplaceView {
  name: string;
  displayName: string;
  path: string | null;
  removable: boolean;
  upgradable: boolean;
  plugins: CodexPluginView[];
}
export interface CodexPluginsSnapshot {
  enabled: boolean;
  disabledReason: string | null;
  marketplaces: CodexMarketplaceView[];
  loadErrors: { marketplacePath: string; message: string }[];
}
export interface CodexPluginDetailView {
  plugin: CodexPluginView;
  description: string | null;
  skills: string[];
  apps: {
    id: string;
    name: string;
    description: string | null;
    installUrl: string | null;
  }[];
  mcpServers: string[];
  hooks: string[];
  websiteUrl: string | null;
  privacyPolicyUrl: string | null;
  termsOfServiceUrl: string | null;
}
export interface CodexPluginInstallResult {
  snapshot: CodexPluginsSnapshot;
  authPolicy: string | null;
  appsNeedingAuth: CodexPluginDetailView["apps"];
}

/** Mirrors upstream `connector_status_label`. */
export function appStatusLabel(app: {
  isAccessible: boolean;
  isEnabled: boolean;
}): string {
  if (!app.isAccessible) return "Can be installed";
  return app.isEnabled ? "Installed" : "Installed · Disabled";
}

function parseApp(value: unknown): CodexAppView | null {
  const app = record(value);
  if (!app || typeof app.id !== "string" || typeof app.name !== "string")
    return null;
  const branding = record(app.branding);
  const metadata = record(app.appMetadata);
  const view = {
    id: app.id,
    name: app.name,
    description: text(app.description),
    developer: text(branding?.developer) ?? text(metadata?.developer),
    category: text(branding?.category),
    installUrl: httpUrl(app.installUrl),
    isAccessible: app.isAccessible === true,
    isEnabled: app.isEnabled !== false,
    pluginDisplayNames: Array.isArray(app.pluginDisplayNames)
      ? app.pluginDisplayNames.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
  };
  return { ...view, statusLabel: appStatusLabel(view) };
}

interface RawPlugin {
  summary: Record<string, unknown>;
  marketplace: Record<string, unknown>;
}

function remoteIdentity(summary: Record<string, unknown>): string | null {
  return (
    text(record(summary.shareContext)?.remotePluginId) ??
    text(summary.remotePluginId)
  );
}
function isRemote(summary: Record<string, unknown>): boolean {
  return record(summary.source)?.type === "remote";
}
/** Upstream `plugin_status_label`. */
function pluginStatusLabel(summary: Record<string, unknown>): string {
  const policy = summary.installPolicy;
  if (policy === "INSTALLED_BY_DEFAULT")
    return summary.installed === true
      ? "Installed by admin"
      : "Enabled by Admin";
  if (summary.installed === true)
    return summary.enabled === true ? "Installed" : "Disabled";
  return policy === "NOT_AVAILABLE" ? "Not installable" : "Can be installed";
}
function sourceSummary(summary: Record<string, unknown>): string {
  const source = record(summary.source);
  switch (source?.type) {
    case "local":
      return `Local · ${text(source.path) ?? ""}`;
    case "git":
      return `Git · ${text(source.url) ?? ""}${text(source.refName) ? `@${text(source.refName)}` : ""}`;
    case "npm":
      return `npm · ${text(source.package) ?? ""}${text(source.version) ? `@${text(source.version)}` : ""}`;
    case "remote":
      return "Remote catalog";
    default:
      return "Unknown source";
  }
}

function pluginView(raw: RawPlugin, featured: Set<string>): CodexPluginView {
  const { summary, marketplace } = raw;
  const ui = record(summary.interface);
  const name = String(summary.name ?? "");
  const id = String(summary.id ?? name);
  const installed = summary.installed === true;
  const adminManaged = summary.installPolicy === "INSTALLED_BY_DEFAULT";
  const disabledByAdmin = summary.availability === "DISABLED_BY_ADMIN";
  const location = pluginLocation(raw);
  const uninstallId = isRemote(summary) ? remoteIdentity(summary) : id;
  const installBlockedReason = installed
    ? "Already installed"
    : disabledByAdmin
      ? "This plugin is disabled by your workspace admin"
      : summary.installPolicy === "NOT_AVAILABLE"
        ? "This plugin is not installable from this marketplace"
        : !location
          ? "This plugin did not provide an install location"
          : null;
  const uninstallBlockedReason = !installed
    ? "Not installed"
    : adminManaged
      ? "This plugin is installed by your workspace admin"
      : !uninstallId
        ? "This remote plugin did not provide an uninstall identity"
        : null;
  return {
    id,
    name,
    displayName: text(ui?.displayName) ?? name,
    description: text(ui?.shortDescription) ?? text(ui?.longDescription),
    developer: text(ui?.developerName),
    category: text(ui?.category),
    marketplaceName: String(marketplace.name ?? ""),
    installed,
    enabled: summary.enabled === true,
    statusLabel: pluginStatusLabel(summary),
    authPolicy: text(summary.authPolicy),
    featured: featured.has(id),
    canToggle: installed && !adminManaged && !disabledByAdmin,
    canInstall: installBlockedReason === null,
    installBlockedReason,
    canUninstall: uninstallBlockedReason === null,
    uninstallBlockedReason,
    sourceSummary: sourceSummary(summary),
    keywords: Array.isArray(summary.keywords)
      ? summary.keywords.filter(
          (keyword): keyword is string => typeof keyword === "string",
        )
      : [],
  };
}

/** Upstream `plugin_detail_location` + `plugin_request_name`. */
function pluginLocation(raw: RawPlugin): Record<string, unknown> | null {
  const { summary, marketplace } = raw;
  const pluginName =
    isRemote(summary) && remoteIdentity(summary)
      ? remoteIdentity(summary)!
      : String(summary.name ?? "");
  const marketplacePath = text(marketplace.path);
  if (marketplacePath) return { marketplacePath, pluginName };
  if (remoteIdentity(summary))
    return {
      remoteMarketplaceName: String(marketplace.name ?? ""),
      pluginName,
    };
  return null;
}

async function featureEnabled(
  rpc: ExtensionRpc,
  name: string,
  threadId?: string | null,
): Promise<boolean> {
  try {
    const features = await readExperimentalFeatures(
      (method, params) => rpc(method, params, { threadId }),
      threadId,
    );
    return features.find((feature) => feature.name === name)?.enabled ?? true;
  } catch {
    return true;
  }
}

export class CodexPluginsManager {
  private inFlight = new Set<string>();

  constructor(
    private readonly rpc: ExtensionRpc,
    private readonly changed: () => void,
  ) {}

  observe(method: string): boolean {
    if (method !== "app/list/updated") return false;
    this.changed();
    return true;
  }

  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.inFlight.has(key))
      throw new CodexInputError("This change is already in progress.");
    this.inFlight.add(key);
    try {
      return await work();
    } finally {
      this.inFlight.delete(key);
    }
  }

  // ----- Apps -----

  async listApps(
    threadId?: string | null,
    forceRefetch = false,
  ): Promise<CodexAppsSnapshot> {
    const id = threadId || null;
    if (!(await featureEnabled(this.rpc, "apps", id)))
      return {
        enabled: false,
        disabledReason:
          "Apps are disabled. Enable the apps feature to use /apps.",
        apps: [],
      };
    const account = record(
      await this.rpc("account/read", {}).catch(() => null),
    );
    if (record(account?.account)?.type !== "chatgpt")
      return {
        enabled: false,
        disabledReason: "Apps require signing in to Codex with ChatGPT.",
        apps: [],
      };
    const apps = await nativePages<unknown>(
      (method, params) => this.rpc(method, params, { threadId: id }),
      "app/list",
      {
        ...(id ? { threadId: id } : {}),
        ...(forceRefetch ? { forceRefetch } : {}),
      },
    );
    return {
      enabled: true,
      disabledReason: null,
      apps: apps
        .map(parseApp)
        .filter((app): app is CodexAppView => Boolean(app)),
    };
  }

  /** Upstream `SetAppEnabled`: disabling records `disabled_reason = "user"`. */
  async setAppEnabled(appId: unknown, enabled: unknown): Promise<void> {
    const id = text(appId);
    if (!id) throw new CodexInputError("App ID is required.");
    if (typeof enabled !== "boolean")
      throw new CodexInputError("Expected an enabled boolean.");
    const path = (key: string) => `apps.${JSON.stringify(id)}.${key}`;
    await this.exclusive(`app:${id}`, async () => {
      await this.rpc("config/batchWrite", {
        edits: enabled
          ? [
              {
                keyPath: path("enabled"),
                value: null,
                mergeStrategy: "replace",
              },
              {
                keyPath: path("disabled_reason"),
                value: null,
                mergeStrategy: "replace",
              },
            ]
          : [
              {
                keyPath: path("enabled"),
                value: false,
                mergeStrategy: "replace",
              },
              {
                keyPath: path("disabled_reason"),
                value: "user",
                mergeStrategy: "replace",
              },
            ],
        reloadUserConfig: true,
      });
    });
    this.changed();
  }

  // ----- Plugins -----

  private async rawPlugins(cwd: string | null, forceRefetch = false) {
    const response = nativeRecord(
      await this.rpc("plugin/list", {
        cwds: cwd ? [cwd] : null,
        ...(forceRefetch ? { forceRefetch } : {}),
      }),
    );
    if (!Array.isArray(response.marketplaces))
      throw new Error("Invalid plugin/list response");
    const featured = new Set(
      (Array.isArray(response.featuredPluginIds)
        ? response.featuredPluginIds
        : []
      ).filter((id): id is string => typeof id === "string"),
    );
    const marketplaces = response.marketplaces
      .map(record)
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && !HIDDEN_MARKETPLACES.has(String(entry!.name)),
      );
    const loadErrors = (
      Array.isArray(response.marketplaceLoadErrors)
        ? response.marketplaceLoadErrors
        : []
    )
      .map(record)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => ({
        marketplacePath: String(entry.marketplacePath ?? ""),
        message: String(entry.message ?? ""),
      }));
    return { marketplaces, featured, loadErrors };
  }

  /** `[marketplaces]` entries from the active user config layer. */
  private async userMarketplaces(): Promise<Map<string, unknown>> {
    try {
      const result = nativeRecord(
        await this.rpc("config/read", { includeLayers: true }),
      );
      const layer = (Array.isArray(result.layers) ? result.layers : [])
        .map(record)
        .find((entry) => record(entry?.name)?.type === "user");
      return new Map(
        Object.entries(record(record(layer?.config)?.marketplaces) ?? {}),
      );
    } catch {
      return new Map();
    }
  }

  private async findPlugin(
    cwd: string | null,
    pluginId: unknown,
    marketplaceName: unknown,
  ): Promise<{ raw: RawPlugin; view: CodexPluginView }> {
    const id = text(pluginId);
    if (!id) throw new CodexInputError("Plugin ID is required.");
    const { marketplaces, featured } = await this.rawPlugins(cwd);
    for (const marketplace of marketplaces) {
      if (marketplaceName && marketplace.name !== marketplaceName) continue;
      for (const summary of Array.isArray(marketplace.plugins)
        ? marketplace.plugins
        : []) {
        const entry = record(summary);
        if (entry && (entry.id === id || entry.name === id)) {
          const raw = { summary: entry, marketplace };
          return { raw, view: pluginView(raw, featured) };
        }
      }
    }
    throw new CodexInputError(
      "That plugin is no longer available. Refresh the plugin list.",
    );
  }

  async listPlugins(
    cwd: string | null,
    forceRefetch = false,
  ): Promise<CodexPluginsSnapshot> {
    if (!(await featureEnabled(this.rpc, "plugins")))
      return {
        enabled: false,
        disabledReason:
          "Plugins are disabled. Enable the plugins feature to use /plugins.",
        marketplaces: [],
        loadErrors: [],
      };
    const [{ marketplaces, featured, loadErrors }, configured] =
      await Promise.all([
        this.rawPlugins(cwd, forceRefetch),
        this.userMarketplaces(),
      ]);
    return {
      enabled: true,
      disabledReason: null,
      marketplaces: marketplaces.map((marketplace) => ({
        name: String(marketplace.name ?? ""),
        displayName:
          text(record(marketplace.interface)?.displayName) ??
          String(marketplace.name ?? ""),
        path: text(marketplace.path),
        // Upstream only removes/upgrades marketplaces from the user config.
        removable: configured.has(String(marketplace.name)),
        upgradable:
          record(configured.get(String(marketplace.name)))?.source_type ===
          "git",
        plugins: (Array.isArray(marketplace.plugins) ? marketplace.plugins : [])
          .map(record)
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .map((summary) => pluginView({ summary, marketplace }, featured)),
      })),
      loadErrors,
    };
  }

  async readPlugin(
    cwd: string | null,
    pluginId: unknown,
    marketplaceName: unknown,
  ): Promise<CodexPluginDetailView> {
    const { raw, view } = await this.findPlugin(cwd, pluginId, marketplaceName);
    const location = pluginLocation(raw);
    if (!location) throw new CodexInputError("Plugin details are unavailable.");
    const detail = record(
      nativeRecord(await this.rpc("plugin/read", location)).plugin,
    );
    if (!detail) throw new Error("Invalid plugin/read response");
    const ui = record(record(detail.summary)?.interface);
    const names = (value: unknown, key: string) =>
      (Array.isArray(value) ? value : [])
        .map((entry) =>
          typeof entry === "string" ? entry : text(record(entry)?.[key]),
        )
        .filter((name): name is string => Boolean(name));
    return {
      plugin: view,
      description: text(detail.description) ?? text(ui?.longDescription),
      skills: names(detail.skills, "name"),
      apps: parseAppSummaries(detail.apps),
      mcpServers: names(detail.mcpServers, "name"),
      hooks: names(detail.hooks, "key"),
      websiteUrl: httpUrl(ui?.websiteUrl),
      privacyPolicyUrl: httpUrl(ui?.privacyPolicyUrl),
      termsOfServiceUrl: httpUrl(ui?.termsOfServiceUrl),
    };
  }

  async installPlugin(
    cwd: string | null,
    pluginId: unknown,
    marketplaceName: unknown,
  ): Promise<CodexPluginInstallResult> {
    const { raw, view } = await this.findPlugin(cwd, pluginId, marketplaceName);
    if (!view.canInstall)
      throw new CodexInputError(view.installBlockedReason ?? "Cannot install.");
    const location = pluginLocation(raw)!;
    const result = await this.exclusive(`plugin:${view.id}`, async () =>
      record(
        await this.rpc(
          "plugin/install",
          { ...location, installAttemptId: randomUUID() },
          { timeoutMs: LONG_TIMEOUT_MS },
        ),
      ),
    );
    this.changed();
    return {
      snapshot: await this.listPlugins(cwd),
      authPolicy: text(result?.authPolicy),
      appsNeedingAuth: parseAppSummaries(result?.appsNeedingAuth),
    };
  }

  async uninstallPlugin(
    cwd: string | null,
    pluginId: unknown,
    marketplaceName: unknown,
  ): Promise<CodexPluginsSnapshot> {
    const { raw, view } = await this.findPlugin(cwd, pluginId, marketplaceName);
    if (!view.canUninstall)
      throw new CodexInputError(
        view.uninstallBlockedReason ?? "Cannot uninstall.",
      );
    const uninstallId = isRemote(raw.summary)
      ? remoteIdentity(raw.summary)!
      : view.id;
    await this.exclusive(`plugin:${view.id}`, () =>
      this.rpc(
        "plugin/uninstall",
        { pluginId: uninstallId },
        { timeoutMs: LONG_TIMEOUT_MS },
      ),
    );
    this.changed();
    return this.listPlugins(cwd);
  }

  /** Upstream `write_plugin_enabled`: upsert `plugins.<id>.enabled`. */
  async setPluginEnabled(
    cwd: string | null,
    pluginId: unknown,
    marketplaceName: unknown,
    enabled: unknown,
  ): Promise<CodexPluginsSnapshot> {
    if (typeof enabled !== "boolean")
      throw new CodexInputError("Expected an enabled boolean.");
    const { view } = await this.findPlugin(cwd, pluginId, marketplaceName);
    if (!view.canToggle)
      throw new CodexInputError("This plugin cannot be enabled or disabled.");
    await this.exclusive(`plugin:${view.id}`, () =>
      this.rpc("config/value/write", {
        keyPath: `plugins.${JSON.stringify(view.id)}`,
        value: { enabled },
        mergeStrategy: "upsert",
      }),
    );
    this.changed();
    return this.listPlugins(cwd);
  }

  async addMarketplace(
    cwd: string | null,
    source: unknown,
    refName: unknown,
  ): Promise<{
    snapshot: CodexPluginsSnapshot;
    marketplaceName: string;
    alreadyAdded: boolean;
  }> {
    const value = text(source);
    if (!value || value.length > 2048)
      throw new CodexInputError("Enter a marketplace source.");
    const ref = text(refName);
    const result = await this.exclusive(`marketplace:${value}`, async () =>
      nativeRecord(
        await this.rpc(
          "marketplace/add",
          { source: value, ...(ref ? { refName: ref } : {}) },
          { timeoutMs: LONG_TIMEOUT_MS },
        ),
      ),
    );
    this.changed();
    return {
      snapshot: await this.listPlugins(cwd),
      marketplaceName: String(result.marketplaceName ?? value),
      alreadyAdded: result.alreadyAdded === true,
    };
  }

  async removeMarketplace(
    cwd: string | null,
    marketplaceName: unknown,
  ): Promise<CodexPluginsSnapshot> {
    const name = text(marketplaceName);
    if (!name) throw new CodexInputError("Marketplace name is required.");
    if (!(await this.userMarketplaces()).has(name))
      throw new CodexInputError(
        "Only marketplaces added to your user config can be removed.",
      );
    await this.exclusive(`marketplace:${name}`, () =>
      this.rpc(
        "marketplace/remove",
        { marketplaceName: name },
        { timeoutMs: LONG_TIMEOUT_MS },
      ),
    );
    this.changed();
    return this.listPlugins(cwd);
  }

  async upgradeMarketplaces(
    cwd: string | null,
    marketplaceName: unknown,
  ): Promise<{
    snapshot: CodexPluginsSnapshot;
    upgraded: string[];
    errors: { marketplaceName: string; message: string }[];
  }> {
    const name = text(marketplaceName);
    const result = await this.exclusive(
      `marketplace:${name ?? "*"}`,
      async () =>
        nativeRecord(
          await this.rpc(
            "marketplace/upgrade",
            name ? { marketplaceName: name } : {},
            { timeoutMs: LONG_TIMEOUT_MS },
          ),
        ),
    );
    this.changed();
    return {
      snapshot: await this.listPlugins(cwd),
      upgraded: (Array.isArray(result.selectedMarketplaces)
        ? result.selectedMarketplaces
        : []
      ).filter((entry): entry is string => typeof entry === "string"),
      errors: (Array.isArray(result.errors) ? result.errors : [])
        .map(record)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((entry) => ({
          marketplaceName: String(entry.marketplaceName ?? ""),
          message: String(entry.message ?? ""),
        })),
    };
  }

  async searchPlugins(
    cwd: string | null,
    term: unknown,
  ): Promise<{ results: { pluginId: string; marketplaceName: string }[] }> {
    const searchTerm = text(term);
    if (!searchTerm) return { results: [] };
    const response = nativeRecord(
      await this.rpc("plugin/search", {
        searchTerm,
        cwds: cwd ? [cwd] : null,
        limit: 50,
      }),
    );
    return {
      results: (Array.isArray(response.data) ? response.data : [])
        .map(record)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((entry) => ({
          pluginId: String(record(entry.plugin)?.id ?? ""),
          marketplaceName: String(entry.marketplaceName ?? ""),
        }))
        .filter((entry) => entry.pluginId),
    };
  }
}

function parseAppSummaries(value: unknown): CodexPluginDetailView["apps"] {
  return (Array.isArray(value) ? value : [])
    .map(record)
    .filter(
      (app): app is Record<string, unknown> =>
        Boolean(app) && typeof app!.id === "string",
    )
    .map((app) => ({
      id: String(app.id),
      name: text(app.name) ?? String(app.id),
      description: text(app.description),
      installUrl: httpUrl(app.installUrl),
    }));
}

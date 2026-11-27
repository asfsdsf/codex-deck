export const DECK_PLUGIN_PACKAGE_MAX_BYTES = 8 * 1024 * 1024;
export const DECK_PLUGIN_PACKAGE_MAX_FILES = 256;
export const DECK_PLUGIN_MANIFEST_MAX_BYTES = 128 * 1024;
export const DECK_PLUGIN_STATE_MAX_BYTES = 64 * 1024;

export const DECK_PLUGIN_CAPABILITIES = [
  "context.read",
  "state.read",
  "state.write",
  "backend.execute",
  "sessions.read",
  "sessions.events",
  "sessions.submit",
  "sessions.transform",
  "codex.homes.read",
  "codex.sessions.manage",
  "data.read",
  "data.write",
  "secrets.read",
  "secrets.write",
  "status.write",
  "worker.request",
  "http.request",
  "services.call",
  "services.provide",
] as const;

export type DeckPluginCapability = (typeof DECK_PLUGIN_CAPABILITIES)[number];
export type DeckPluginState = Record<string, unknown>;

export interface DeckPluginView {
  id: string;
  title: string;
  description?: string;
  slot:
    | "dialog"
    | "settings"
    | "session.toolbar"
    | "session.footer"
    | "app.sidebar"
    | "layout.left"
    | "layout.right"
    | "pane.left"
    | "pane.right"
    | "memory.settings";
  /** Installed views use sandboxed package HTML; bundled views register React components. */
  entrypoint?: string;
  order?: number;
  /** Preferred height of an embedded sandboxed view, in CSS pixels. */
  height?: number;
}

export interface DeckPluginCommand {
  id: string;
  title: string;
  description: string;
  supportsInlineArgs?: boolean;
  requiresSession?: boolean;
  action: { view: string } | { method: string };
}

export interface DeckPluginBeforeFirstMessageHook {
  method: string;
  waitingLabel?: string;
  order?: number;
}

export interface DeckPluginContributions {
  settings?: { title: string };
  sessionToggle?: { label: string };
  sessionTip?: boolean;
  beforeFirstMessage?: DeckPluginBeforeFirstMessageHook;
  views?: DeckPluginView[];
  commands?: DeckPluginCommand[];
}

export interface DeckPluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  capabilities: DeckPluginCapability[];
  entrypoints: { panel?: string; settings?: string; backend?: string };
  contributions?: DeckPluginContributions;
  services?: { provides?: string[]; uses?: string[] };
  /** Required services; consumers are suspended when a provider goes away. */
  requires?: string[];
}

export interface DeckPluginRuntimeResponse {
  plugin: { id: string; name: string; version: string };
  manifest: DeckPluginManifest;
  state: DeckPluginState;
  source?: DeckPluginSummary["source"];
}

export interface DeckPluginSourceFile {
  path: string;
  size: number;
  content: string | null;
}

export interface DeckPluginSourceResponse {
  plugin: { id: string; name: string; version: string };
  manifest: DeckPluginManifest;
  files: DeckPluginSourceFile[];
}

export interface DeckPluginFileUpload {
  path: string;
  contentBase64: string;
}

export interface DeckPluginSummary extends DeckPluginManifest {
  source: "package" | "legacy" | "builtin";
  canDisable?: boolean;
  installed: boolean;
  enabled: boolean;
  hasExecutableUi: boolean;
}

export interface DeckPluginsSnapshot {
  plugins: DeckPluginSummary[];
}

export type DeckPluginInstallInput = {
  files: DeckPluginFileUpload[];
  replaceVersion?: string;
};

export class DeckPluginManifestError extends Error {}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeckPluginManifestError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new DeckPluginManifestError(
      `${field} must be nonempty text of at most ${maxLength} characters.`,
    );
  }
  return value.trim();
}

function readId(value: unknown, field: string): string {
  const id = readText(value, field, 80);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) {
    throw new DeckPluginManifestError(
      `${field} must start with a lowercase letter and use lowercase letters, digits, dots, or hyphens.`,
    );
  }
  return id;
}

export function parseDeckPluginPath(value: unknown, field = "path"): string {
  const filePath = readText(value, field, 512);
  const segments = filePath.split("/");
  if (
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[\u0000-\u001f\u007f]/.test(segment),
    )
  ) {
    throw new DeckPluginManifestError(
      `${field} must be a relative package file path.`,
    );
  }
  return filePath;
}

export function parseDeckPluginManifest(
  value: unknown,
  options: { builtin?: boolean } = {},
): DeckPluginManifest {
  const source = readObject(value, "Plugin manifest");
  if (source.schemaVersion !== 1) {
    throw new DeckPluginManifestError("This plugin requires schemaVersion 1.");
  }
  const version = readText(source.version, "version", 40);
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(version)) {
    throw new DeckPluginManifestError(
      "version must look like 1.0.0 or 1.0.0-beta.",
    );
  }

  const capabilitiesValue = source.capabilities ?? [];
  if (
    !Array.isArray(capabilitiesValue) ||
    capabilitiesValue.some(
      (capability) =>
        typeof capability !== "string" ||
        !(DECK_PLUGIN_CAPABILITIES as readonly string[]).includes(capability),
    ) ||
    new Set(capabilitiesValue).size !== capabilitiesValue.length
  ) {
    throw new DeckPluginManifestError(
      `capabilities must be unique supported values: ${DECK_PLUGIN_CAPABILITIES.join(", ")}.`,
    );
  }

  const entrypoints = readObject(source.entrypoints, "entrypoints");
  const entries: DeckPluginManifest["entrypoints"] = {};
  for (const key of ["panel", "settings", "backend"] as const) {
    if (entrypoints[key] === undefined) continue;
    const path = parseDeckPluginPath(entrypoints[key], `entrypoints.${key}`);
    if (
      key === "backend"
        ? !/\.(mjs|cjs|js)$/i.test(path)
        : !/\.html?$/i.test(path)
    ) {
      throw new DeckPluginManifestError(`Invalid ${key} entrypoint extension.`);
    }
    entries[key] = path;
  }
  if (entries.backend && !capabilitiesValue.includes("backend.execute")) {
    throw new DeckPluginManifestError(
      "Backend workers require backend.execute permission.",
    );
  }
  const contributions: NonNullable<DeckPluginManifest["contributions"]> = {};
  if (source.contributions !== undefined) {
    const input = readObject(source.contributions, "contributions");
    if (input.settings !== undefined) {
      contributions.settings = {
        title: readText(
          readObject(input.settings, "settings").title,
          "settings.title",
          80,
        ),
      };
    }
    if (input.sessionToggle !== undefined) {
      contributions.sessionToggle = {
        label: readText(
          readObject(input.sessionToggle, "sessionToggle").label,
          "sessionToggle.label",
          80,
        ),
      };
    }
    if (input.sessionTip !== undefined) {
      if (typeof input.sessionTip !== "boolean")
        throw new DeckPluginManifestError("sessionTip must be a boolean.");
      contributions.sessionTip = input.sessionTip;
    }
    if (input.beforeFirstMessage !== undefined) {
      const hook = readObject(
        input.beforeFirstMessage,
        "contributions.beforeFirstMessage",
      );
      if (
        !entries.backend ||
        !capabilitiesValue.includes("sessions.transform")
      ) {
        throw new DeckPluginManifestError(
          "beforeFirstMessage hooks require a backend and sessions.transform.",
        );
      }
      if (
        hook.order !== undefined &&
        (typeof hook.order !== "number" || !Number.isFinite(hook.order))
      ) {
        throw new DeckPluginManifestError(
          "beforeFirstMessage.order must be finite.",
        );
      }
      contributions.beforeFirstMessage = {
        method: readText(hook.method, "beforeFirstMessage.method", 80),
        ...(hook.waitingLabel === undefined
          ? {}
          : {
              waitingLabel: readText(
                hook.waitingLabel,
                "beforeFirstMessage.waitingLabel",
                120,
              ),
            }),
        ...(hook.order === undefined ? {} : { order: hook.order as number }),
      };
    }
    if (input.views !== undefined) {
      if (!Array.isArray(input.views) || input.views.length > 32)
        throw new DeckPluginManifestError("Declare at most 32 views.");
      contributions.views = input.views.map((value) => {
        const view = readObject(value, "view");
        const slot = readText(
          view.slot,
          "view.slot",
          80,
        ) as DeckPluginView["slot"];
        if (
          ![
            "dialog",
            "settings",
            "session.toolbar",
            "session.footer",
            "app.sidebar",
            "layout.left",
            "layout.right",
            "pane.left",
            "pane.right",
            "memory.settings",
          ].includes(slot)
        )
          throw new DeckPluginManifestError("Unsupported view slot.");
        if (
          view.order !== undefined &&
          (typeof view.order !== "number" || !Number.isFinite(view.order))
        )
          throw new DeckPluginManifestError("view.order must be finite.");
        if (
          view.height !== undefined &&
          (typeof view.height !== "number" ||
            !Number.isFinite(view.height) ||
            view.height < 32 ||
            view.height > 1200)
        )
          throw new DeckPluginManifestError(
            "view.height must be between 32 and 1200 pixels.",
          );
        const entrypoint =
          options.builtin && view.entrypoint === undefined
            ? undefined
            : parseDeckPluginPath(view.entrypoint, "view.entrypoint");
        if (entrypoint && !/\.html?$/i.test(entrypoint))
          throw new DeckPluginManifestError(
            "Views require an HTML entrypoint.",
          );
        if (!entrypoint && !options.builtin)
          throw new DeckPluginManifestError(
            "Views require an HTML entrypoint.",
          );
        return {
          id: readId(view.id, "view.id"),
          title: readText(view.title, "view.title", 80),
          ...(view.description === undefined
            ? {}
            : {
                description: readText(
                  view.description,
                  "view.description",
                  240,
                ),
              }),
          slot,
          ...(entrypoint ? { entrypoint } : {}),
          ...(view.order === undefined ? {} : { order: view.order as number }),
          ...(view.height === undefined
            ? {}
            : { height: view.height as number }),
        };
      });
      if (
        new Set(contributions.views.map((v) => v.id)).size !==
        contributions.views.length
      )
        throw new DeckPluginManifestError("View IDs must be unique.");
    }
    if (input.commands !== undefined) {
      if (!Array.isArray(input.commands) || input.commands.length > 32)
        throw new DeckPluginManifestError("Declare at most 32 commands.");
      contributions.commands = input.commands.map((value) => {
        const command = readObject(value, "command");
        const action = readObject(command.action, "command.action");
        if ((action.view === undefined) === (action.method === undefined))
          throw new DeckPluginManifestError(
            "Commands must open a view or invoke a worker method.",
          );
        if (
          action.view !== undefined &&
          !contributions.views?.some((v) => v.id === action.view)
        )
          throw new DeckPluginManifestError(
            "Command view must be declared by this plugin.",
          );
        if (
          action.method !== undefined &&
          (!entries.backend || !capabilitiesValue.includes("worker.request"))
        )
          throw new DeckPluginManifestError(
            "Worker commands require a backend and worker.request.",
          );
        for (const field of ["supportsInlineArgs", "requiresSession"])
          if (
            command[field] !== undefined &&
            typeof command[field] !== "boolean"
          )
            throw new DeckPluginManifestError(`${field} must be boolean.`);
        return {
          id: readId(command.id, "command.id"),
          title: readText(command.title, "command.title", 80),
          description: readText(
            command.description,
            "command.description",
            400,
          ),
          supportsInlineArgs: command.supportsInlineArgs === true,
          requiresSession: command.requiresSession === true,
          action:
            action.view !== undefined
              ? { view: readId(action.view, "command.action.view") }
              : {
                  method: readText(action.method, "command.action.method", 80),
                },
        };
      });
      if (
        new Set(contributions.commands.map((v) => v.id)).size !==
        contributions.commands.length
      )
        throw new DeckPluginManifestError("Command IDs must be unique.");
    }
  }

  if (
    contributions.settings &&
    !entries.settings &&
    !contributions.views?.some((view) => view.slot === "settings") &&
    !options.builtin
  )
    throw new DeckPluginManifestError(
      "Settings contribution requires a settings entrypoint or settings view.",
    );

  if (
    !options.builtin &&
    !Object.keys(entries).length &&
    !contributions.views?.length
  )
    throw new DeckPluginManifestError(
      "Declare at least one entrypoint or view.",
    );

  const id = readId(source.id, "id");
  const names = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || value.length > 64)
      throw new DeckPluginManifestError(
        `${field} must be a list of service names.`,
      );
    const result = value.map((name) => readId(name, field));
    if (new Set(result).size !== result.length)
      throw new DeckPluginManifestError(`${field} must be unique.`);
    return result;
  };
  let services: DeckPluginManifest["services"];
  if (source.services !== undefined) {
    const input = readObject(source.services, "services");
    services = {
      provides: names(input.provides ?? [], "services.provides"),
      uses: names(input.uses ?? [], "services.uses"),
    };
    if (
      services.provides!.some(
        (name) => name !== id && !name.startsWith(`${id}.`),
      )
    )
      throw new DeckPluginManifestError(
        "Provided services must use the plugin ID namespace.",
      );
    if (
      services.provides!.length &&
      !options.builtin &&
      (!entries.backend || !capabilitiesValue.includes("services.provide"))
    )
      throw new DeckPluginManifestError(
        "Service providers require a backend and services.provide.",
      );
    if (
      !options.builtin &&
      services.uses!.length &&
      !capabilitiesValue.includes("services.call")
    )
      throw new DeckPluginManifestError(
        "Service consumers require services.call.",
      );
  }
  const requires =
    source.requires === undefined
      ? undefined
      : names(source.requires, "requires");
  if (
    !options.builtin &&
    requires?.some((name) => !services?.uses?.includes(name))
  )
    throw new DeckPluginManifestError(
      "Required services must be declared in services.uses.",
    );

  return {
    schemaVersion: 1,
    id,
    name: readText(source.name, "name", 80),
    version,
    description: readText(source.description, "description", 400),
    ...(source.author === undefined
      ? {}
      : { author: readText(source.author, "author", 80) }),
    capabilities: capabilitiesValue as DeckPluginCapability[],
    entrypoints: entries,
    ...(Object.keys(contributions).length ? { contributions } : {}),
    ...(services ? { services } : {}),
    ...(requires ? { requires } : {}),
  };
}

export function summarizeDeckPlugin(
  manifest: DeckPluginManifest,
  source: DeckPluginSummary["source"],
  enabled: boolean,
): DeckPluginSummary {
  return {
    ...manifest,
    source,
    installed: true,
    enabled,
    canDisable: true,
    hasExecutableUi: !!(
      manifest.entrypoints.panel ||
      manifest.entrypoints.settings ||
      manifest.contributions?.views?.length
    ),
  };
}

export interface DeckPluginSession {
  threadId: string;
  cwd?: string | null;
  path?: string | null;
  codexHome?: string;
  interactive: boolean;
  activeTurnId: string | null;
  pendingInteraction: boolean;
  queuedMessages: boolean;
  revision: string;
  manualActionAt?: number;
  turns: Array<{
    id: string;
    status: "inProgress" | "completed" | "failed" | "interrupted" | null;
    error: { message: string; additionalDetails: string | null } | null;
    userText: string;
    assistantText?: string;
    completedAt: number | null;
  }>;
}

export interface DeckPluginStatus {
  phase: string;
  reason: string;
  nextAt?: number | null;
  deadline?: number | null;
  actions?: Array<{ id: string; label: string }>;
  updatedAt: number;
}

export interface DeckPluginContributionsSnapshot {
  serverTime: number;
  plugins: Array<{
    id: string;
    name: string;
    source?: DeckPluginSummary["source"];
    contributions: NonNullable<DeckPluginManifest["contributions"]>;
    sessions: Record<string, boolean>;
    statuses: Record<string, DeckPluginStatus>;
    workerError?: string;
  }>;
}

export interface DeckPluginAppliedPromptSummary {
  id: string;
  name: string;
  mode: string;
  reason?: string;
}

export interface DeckPluginBeforeFirstMessagePluginResult {
  pluginId: string;
  pluginName: string;
  changed: boolean;
  skipped?: boolean;
  summary?: string;
  appliedItems?: DeckPluginAppliedPromptSummary[];
  error?: string;
}

export interface DeckPluginBeforeFirstMessageJobStatus {
  jobId: string | null;
  done: boolean;
  canceled?: boolean;
  plugins: Array<{ id: string; name: string; waitingLabel: string }>;
  activePlugin: { id: string; name: string; waitingLabel: string } | null;
  phase: string;
  detail?: string;
  startedAt: number;
  completedPlugins: DeckPluginBeforeFirstMessagePluginResult[];
  text?: string;
  originalText?: string;
  changed?: boolean;
  error?: string;
}

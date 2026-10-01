import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CodexDeckConfigWriteResponse,
  CodexDeckUpdateMethod,
  CodexDeckUpdateOutputResponse,
  CodexDeckUpdateResponse,
  CodexDeckUpdateStatusResponse,
} from "@codex-deck/api";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Download,
  Eye,
  EyeOff,
  FolderCog,
  GitBranch,
  Languages,
  Loader2,
  Network,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ServerCog,
  Trash2,
  X,
} from "lucide-react";
import {
  applyCodexDeckConfig,
  checkCodexDeckNpmUpdate,
  getCodexDeckConfig,
  getCodexDeckUpdateOutput,
  getCodexDeckUpdateStatus,
  subscribeCodexDeckUpdateOutput,
  updateCodexDeckDaemon,
} from "../api";
import {
  createEmptyCodexDeckConfig,
  parseCodexDeckConfigContent,
  updateCodexDeckConfigContent,
  type EditableCodexDeckConfig,
  type EditableRemoteConfig,
} from "../codex-deck-config";
import { usePageVisibility } from "../hooks/use-page-visibility";
import {
  CONVERSATION_HOVER_FIELDS,
  DEFAULT_CONVERSATION_HOVER_SETTINGS,
} from "../../api/conversation-hover-settings";

interface ConfigModalProps {
  open: boolean;
  onClose: () => void;
  onApplied: (response: CodexDeckConfigWriteResponse) => void;
}

type ConfigSection =
  | "general"
  | "hover"
  | "translation"
  | "homes"
  | "remote"
  | "updates"
  | "advanced";

interface ConfigValidation {
  port: string | null;
  homes: Record<number, string[]>;
  count: number;
}

const INPUT_CLASS =
  "h-9 w-full rounded border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-60";

const SECTIONS: Array<{
  id: ConfigSection;
  label: string;
  icon: typeof ServerCog;
}> = [
  { id: "general", label: "General", icon: ServerCog },
  { id: "hover", label: "Floating tip", icon: Eye },
  { id: "translation", label: "Translation", icon: Languages },
  { id: "homes", label: "Codex homes", icon: FolderCog },
  { id: "remote", label: "Remote", icon: Network },
  { id: "updates", label: "Updates", icon: Download },
  { id: "advanced", label: "Advanced", icon: Code2 },
];

function StatusBadge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "live" | "restart";
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${
        tone === "live"
          ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
          : "border-amber-500/35 bg-amber-500/10 text-amber-300"
      }`}
    >
      {children}
    </span>
  );
}

function SectionHeader({
  title,
  badge,
  action,
}: {
  title: string;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 border-b border-zinc-800 pb-3">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="truncate text-sm font-semibold text-zinc-100">
          {title}
        </h2>
        {badge}
      </div>
      {action}
    </div>
  );
}

function Field({
  label,
  badge,
  error,
  children,
}: {
  label: string;
  badge?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-300">
        <span>{label}</span>
        {badge}
      </span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-[11px] text-red-300" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

function OptionalBooleanControl({
  value,
  disabled,
  onChange,
  label,
}: {
  value: boolean | null;
  disabled: boolean;
  onChange: (value: boolean | null) => void;
  label: string;
}) {
  const options: Array<{ value: boolean | null; label: string }> = [
    { value: null, label: "Default" },
    { value: true, label: "On" },
    { value: false, label: "Off" },
  ];
  return (
    <div
      className="grid h-9 grid-cols-3 rounded border border-zinc-700 bg-zinc-950 p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.label}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={disabled}
            aria-pressed={selected}
            className={`rounded-sm px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? "bg-zinc-700 text-zinc-100 shadow-sm"
                : "text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-300"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SecretInput({
  value,
  disabled,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        className={`${INPUT_CLASS} pr-10 font-mono text-xs`}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        disabled={disabled}
        className="absolute right-1 top-1 h-7 w-7 rounded-sm text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
        title={`${visible ? "Hide" : "Show"} ${label}`}
        aria-label={`${visible ? "Hide" : "Show"} ${label}`}
      >
        {visible ? (
          <EyeOff className="mx-auto h-3.5 w-3.5" />
        ) : (
          <Eye className="mx-auto h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function validateConfig(config: EditableCodexDeckConfig): ConfigValidation {
  let port: string | null = null;
  const normalizedPort = config.port.trim();
  if (normalizedPort) {
    const parsedPort = Number(normalizedPort);
    if (!/^\d+$/.test(normalizedPort) || parsedPort < 1 || parsedPort > 65535) {
      port = "Port must be an integer from 1 to 65535.";
    }
  }

  const homes: Record<number, string[]> = {};
  const ids = new Map<string, number[]>();
  config.codexHomes.forEach((home, index) => {
    const errors: string[] = [];
    const id = home.id.trim();
    if (!id) {
      errors.push("Home ID is required.");
    } else if (id === "main") {
      errors.push('The ID "main" is reserved.');
    } else if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      errors.push("Use only letters, numbers, underscores, and hyphens.");
    }
    if (!home.path.trim()) {
      errors.push("Directory path is required.");
    }
    if (id) {
      const indexes = ids.get(id) ?? [];
      indexes.push(index);
      ids.set(id, indexes);
    }
    if (errors.length > 0) {
      homes[index] = errors;
    }
  });
  for (const indexes of ids.values()) {
    if (indexes.length < 2) {
      continue;
    }
    for (const index of indexes) {
      homes[index] = [...(homes[index] ?? []), "Home IDs must be unique."];
    }
  }

  return {
    port,
    homes,
    count: (port ? 1 : 0) + Object.keys(homes).length,
  };
}

export default function ConfigModal(props: ConfigModalProps) {
  const { open, onClose, onApplied } = props;
  const [activeSection, setActiveSection] = useState<ConfigSection>("general");
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [loadedContent, setLoadedContent] = useState("");
  const [revision, setRevision] = useState("");
  const [config, setConfig] = useState<EditableCodexDeckConfig>(() =>
    createEmptyCodexDeckConfig(),
  );
  const [loading, setLoading] = useState(false);
  const [effectiveHoverSettings, setEffectiveHoverSettings] = useState(
    DEFAULT_CONVERSATION_HOVER_SETTINGS,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CodexDeckConfigWriteResponse | null>(
    null,
  );
  const [updateStatus, setUpdateStatus] =
    useState<CodexDeckUpdateStatusResponse | null>(null);
  const [updateMethod, setUpdateMethod] =
    useState<CodexDeckUpdateMethod>("source");
  const [sourceRoot, setSourceRoot] = useState("");
  const [loadingUpdateStatus, setLoadingUpdateStatus] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [updateOutput, setUpdateOutput] =
    useState<CodexDeckUpdateOutputResponse | null>(null);
  const [updateRestartOutput, setUpdateRestartOutput] = useState("");
  const updateOutputRef = useRef<HTMLTextAreaElement>(null);
  const followUpdateOutputRef = useRef(true);
  const ignoredUpdateIdRef = useRef<string | null>(null);
  const receivedUpdateIdRef = useRef<string | null>(null);
  const isPageVisible = usePageVisibility();

  const validation = useMemo(() => validateConfig(config), [config]);
  const disabled = loading || saving || applyingUpdate;
  const isDirty = content !== loadedContent;
  const hasBlockingValidation =
    activeSection !== "advanced" && validation.count > 0;
  const updateBusy = Boolean(
    loadingUpdateStatus ||
    checkingUpdate ||
    disabled ||
    updateStatus?.updateInProgress ||
    updateOutput?.updateInProgress,
  );

  const receiveUpdateOutput = (response: CodexDeckUpdateOutputResponse) => {
    // A freshly restarted daemon has no build output. Keep the completed log.
    if (!response.updateId) {
      setUpdateOutput((output) =>
        output?.updateInProgress
          ? { ...output, updateInProgress: false }
          : output,
      );
      setUpdateStatus((status) =>
        status?.updateInProgress
          ? { ...status, updateInProgress: false }
          : status,
      );
      return;
    }
    if (response.updateId === ignoredUpdateIdRef.current) {
      return;
    }
    if (response.updateId !== receivedUpdateIdRef.current) {
      receivedUpdateIdRef.current = response.updateId;
      setUpdateRestartOutput("");
      followUpdateOutputRef.current = true;
    }
    setUpdateOutput(response);
    setUpdateStatus((status) =>
      status
        ? { ...status, updateInProgress: response.updateInProgress }
        : status,
    );
  };

  useEffect(() => {
    if (!open || activeSection !== "updates" || !isPageVisible) {
      return;
    }
    return subscribeCodexDeckUpdateOutput({ onOutput: receiveUpdateOutput });
  }, [activeSection, isPageVisible, open]);

  useEffect(() => {
    const textarea = updateOutputRef.current;
    if (textarea && followUpdateOutputRef.current) {
      textarea.scrollTop = textarea.scrollHeight;
    }
  }, [activeSection, updateOutput, updateRestartOutput]);

  useEffect(() => {
    if (applyingUpdate) {
      updateOutputRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [applyingUpdate]);

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await getCodexDeckConfig();
      setPath(response.path);
      setContent(response.content);
      setLoadedContent(response.content);
      setRevision(response.revision);
      setConfig(parseCodexDeckConfigContent(response.content));
      setEffectiveHoverSettings(
        response.hoverSettings ?? DEFAULT_CONVERSATION_HOVER_SETTINGS,
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    setActiveSection("general");
    setUpdateStatus(null);
    setUpdateError(null);
    setUpdateResult(null);
    void loadConfig();
  }, [open]);

  useEffect(() => {
    if (!open || activeSection !== "updates" || updateStatus) {
      return;
    }
    let cancelled = false;
    setLoadingUpdateStatus(true);
    setUpdateError(null);
    void getCodexDeckUpdateStatus()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setUpdateStatus(response);
        setUpdateMethod(response.updateMethod);
        setSourceRoot(response.sourceRoot || response.defaultSourceRoot);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setUpdateError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingUpdateStatus(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeSection, open, updateStatus]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving || applyingUpdate) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [applyingUpdate, onClose, open, saving]);

  const updateStructuredConfig = (nextConfig: EditableCodexDeckConfig) => {
    setConfig(nextConfig);
    setContent(updateCodexDeckConfigContent(content, nextConfig));
    setResult(null);
    setError(null);
  };

  const updateRemote = (
    property: keyof EditableRemoteConfig,
    value: string,
  ) => {
    updateStructuredConfig({
      ...config,
      remote: { ...config.remote, [property]: value },
    });
  };

  const handleApply = async () => {
    if (loading || saving || !revision || !isDirty || hasBlockingValidation) {
      return;
    }
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const response = await applyCodexDeckConfig({ content, revision });
      setPath(response.path);
      setContent(response.content);
      setLoadedContent(response.content);
      setRevision(response.revision);
      setConfig(parseCodexDeckConfigContent(response.content));
      setEffectiveHoverSettings(
        response.hoverSettings ?? DEFAULT_CONVERSATION_HOVER_SETTINGS,
      );
      setResult(response);
      onApplied(response);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCheckNpmUpdate = async () => {
    if (checkingUpdate || applyingUpdate) {
      return;
    }
    setCheckingUpdate(true);
    setUpdateError(null);
    setUpdateResult(null);
    try {
      setUpdateStatus(await checkCodexDeckNpmUpdate());
    } catch (checkError) {
      setUpdateError(
        checkError instanceof Error ? checkError.message : String(checkError),
      );
    } finally {
      setCheckingUpdate(false);
    }
  };

  const waitForDaemonRestart = async (
    response: CodexDeckUpdateResponse,
  ): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      try {
        const nextStatus = await getCodexDeckUpdateStatus();
        setUpdateStatus(nextStatus);
        if (nextStatus.daemonStartedAt !== response.daemonStartedAt) {
          setUpdateMethod(nextStatus.updateMethod);
          setSourceRoot(nextStatus.sourceRoot || nextStatus.defaultSourceRoot);
          setUpdateResult(
            `${response.message} The restarted daemon is online. Reload the page to use its updated web assets.`,
          );
          setUpdateRestartOutput("The restarted daemon is online.\n");
          return;
        }
      } catch {
        // A connection failure is expected while the service manager restarts.
      }
    }
    setUpdateResult(
      `${response.message} Restart was scheduled, but the Web UI could not confirm that the daemon came back online.`,
    );
    setUpdateRestartOutput(
      "Restart was scheduled, but the Web UI could not confirm that the daemon came back online within 60 seconds.\n",
    );
  };

  const handleDaemonUpdate = async () => {
    if (
      updateBusy ||
      !updateStatus?.restartSupported ||
      (updateMethod === "source" && !sourceRoot.trim())
    ) {
      return;
    }
    setApplyingUpdate(true);
    setUpdateError(null);
    setUpdateResult(null);
    ignoredUpdateIdRef.current = updateOutput?.updateId ?? null;
    setUpdateOutput(null);
    setUpdateRestartOutput("");
    followUpdateOutputRef.current = true;
    try {
      const response = await updateCodexDeckDaemon({
        method: updateMethod,
        sourceRoot: updateMethod === "source" ? sourceRoot.trim() : undefined,
      });
      await getCodexDeckUpdateOutput()
        .then(receiveUpdateOutput)
        .catch(() => {});
      setUpdateResult(`${response.message} Restarting the daemon.`);
      setUpdateRestartOutput("Waiting for the daemon to restart…\n");
      await waitForDaemonRestart(response);
    } catch (applyError) {
      const message =
        applyError instanceof Error ? applyError.message : String(applyError);
      const output = await getCodexDeckUpdateOutput().catch(() => null);
      if (output) {
        receiveUpdateOutput(output);
      }
      setUpdateError(message);
      setUpdateRestartOutput(
        output?.updateId && output.updateId !== ignoredUpdateIdRef.current
          ? ""
          : `Update failed: ${message}\n`,
      );
    } finally {
      setApplyingUpdate(false);
    }
  };

  const npmActionAvailable = Boolean(
    updateStatus?.npm.checked &&
    (updateStatus.npm.updateAvailable || updateStatus.updateMethod !== "npm"),
  );

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 sm:items-center sm:p-4"
      onClick={(event) => {
        if (
          event.target === event.currentTarget &&
          !saving &&
          !applyingUpdate
        ) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-deck-config-title"
        className="flex h-[100dvh] w-full flex-col overflow-hidden border-zinc-700 bg-zinc-950 shadow-2xl sm:h-[min(48rem,calc(100dvh-2rem))] sm:max-w-5xl sm:rounded-lg sm:border"
      >
        <header className="flex min-h-[64px] items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/70 px-4">
          <div className="min-w-0">
            <div
              id="codex-deck-config-title"
              className="text-sm font-semibold text-zinc-100"
            >
              Settings
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-zinc-500">
              {path || "Main Codex home"}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void loadConfig()}
              disabled={disabled}
              className="h-8 w-8 rounded border border-zinc-700 bg-zinc-900 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
              title="Reload settings"
              aria-label="Reload settings"
            >
              {loading ? (
                <Loader2 className="mx-auto h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mx-auto h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={saving || applyingUpdate}
              className="h-8 w-8 rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
              title="Close settings"
              aria-label="Close settings"
            >
              <X className="mx-auto h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900/40 p-2 sm:w-48 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-3"
            aria-label="Settings sections"
          >
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const selected = activeSection === section.id;
              const sectionHasError =
                (section.id === "general" && Boolean(validation.port)) ||
                (section.id === "homes" &&
                  Object.keys(validation.homes).length > 0);
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  aria-current={selected ? "page" : undefined}
                  className={`flex h-9 shrink-0 items-center gap-2 rounded px-2.5 text-left text-xs font-medium transition-colors sm:w-full ${
                    selected
                      ? "bg-cyan-500/12 text-cyan-200 ring-1 ring-inset ring-cyan-500/25"
                      : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{section.label}</span>
                  {sectionHasError ? (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-red-400" />
                  ) : null}
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex h-full min-h-64 items-center justify-center text-sm text-zinc-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading settings
              </div>
            ) : (
              <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
                {activeSection === "general" ? (
                  <div>
                    <SectionHeader
                      title="Server"
                      badge={<StatusBadge tone="restart">Restart</StatusBadge>}
                    />
                    <div className="grid gap-5 py-5 sm:grid-cols-2">
                      <Field
                        label="Port"
                        error={validation.port}
                        badge={
                          <StatusBadge tone="restart">Restart</StatusBadge>
                        }
                      >
                        <input
                          type="number"
                          min={1}
                          max={65535}
                          inputMode="numeric"
                          value={config.port}
                          onChange={(event) =>
                            updateStructuredConfig({
                              ...config,
                              port: event.target.value,
                            })
                          }
                          disabled={disabled}
                          placeholder="12001"
                          className={INPUT_CLASS}
                        />
                      </Field>
                      <Field
                        label="Main Codex home"
                        badge={
                          <StatusBadge tone="restart">Restart</StatusBadge>
                        }
                      >
                        <input
                          type="text"
                          value={config.dir}
                          onChange={(event) =>
                            updateStructuredConfig({
                              ...config,
                              dir: event.target.value,
                            })
                          }
                          disabled={disabled}
                          placeholder="$CODEX_HOME or ~/.codex"
                          spellCheck={false}
                          className={`${INPUT_CLASS} font-mono text-xs`}
                        />
                      </Field>
                    </div>
                    <div className="divide-y divide-zinc-800 border-y border-zinc-800">
                      <div className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-center">
                        <div className="flex items-center gap-2 text-sm text-zinc-200">
                          Development CORS
                          <StatusBadge tone="restart">Restart</StatusBadge>
                        </div>
                        <OptionalBooleanControl
                          label="Development CORS"
                          value={config.dev}
                          disabled={disabled}
                          onChange={(value) =>
                            updateStructuredConfig({ ...config, dev: value })
                          }
                        />
                      </div>
                      <div className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-center">
                        <div className="flex items-center gap-2 text-sm text-zinc-200">
                          Open browser on startup
                          <StatusBadge tone="restart">Restart</StatusBadge>
                        </div>
                        <OptionalBooleanControl
                          label="Open browser on startup"
                          value={config.open}
                          disabled={disabled}
                          onChange={(value) =>
                            updateStructuredConfig({ ...config, open: value })
                          }
                        />
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeSection === "hover" ? (
                  <div>
                    <SectionHeader
                      title="Floating tip"
                      badge={<StatusBadge tone="live">Applies now</StatusBadge>}
                      action={
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            updateStructuredConfig({
                              ...config,
                              conversationHover: {
                                ...DEFAULT_CONVERSATION_HOVER_SETTINGS,
                              },
                            })
                          }
                          className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
                        >
                          Reset defaults
                        </button>
                      }
                    />
                    <p className="py-4 text-xs leading-5 text-zinc-500">
                      Choose the details shown when hovering over a message.
                      Only available values appear. Changes apply to all
                      connected tabs and devices.
                    </p>
                    <label className="flex items-center gap-3 border-b border-zinc-800 pb-4 text-sm text-zinc-200">
                      <input
                        type="checkbox"
                        checked={
                          config.conversationHover.enabled ??
                          effectiveHoverSettings.enabled
                        }
                        disabled={disabled}
                        onChange={(event) =>
                          updateStructuredConfig({
                            ...config,
                            conversationHover: {
                              ...config.conversationHover,
                              enabled: event.target.checked,
                            },
                          })
                        }
                        className="h-4 w-4 accent-cyan-600"
                      />
                      Show floating tip
                    </label>
                    {[
                      ...new Set(
                        CONVERSATION_HOVER_FIELDS.map((field) => field.group),
                      ),
                    ].map((group) => (
                      <fieldset
                        key={group}
                        className="py-4"
                        disabled={
                          disabled ||
                          !(
                            config.conversationHover.enabled ??
                            effectiveHoverSettings.enabled
                          )
                        }
                      >
                        <legend className="pt-4 text-xs font-semibold text-zinc-300">
                          {group}
                        </legend>
                        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                          {CONVERSATION_HOVER_FIELDS.filter(
                            (field) => field.group === group,
                          ).map((field) => (
                            <label
                              key={field.key}
                              className="flex items-center gap-3 text-xs text-zinc-300 has-disabled:opacity-50"
                            >
                              <input
                                type="checkbox"
                                checked={
                                  config.conversationHover[field.key] ??
                                  effectiveHoverSettings[field.key]
                                }
                                onChange={(event) =>
                                  updateStructuredConfig({
                                    ...config,
                                    conversationHover: {
                                      ...config.conversationHover,
                                      [field.key]: event.target.checked,
                                    },
                                  })
                                }
                                className="h-4 w-4 shrink-0 accent-cyan-600"
                              />
                              {field.label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}
                  </div>
                ) : null}

                {activeSection === "translation" ? (
                  <div>
                    <SectionHeader
                      title="Translation"
                      badge={<StatusBadge tone="live">Applies now</StatusBadge>}
                    />
                    <div className="py-5">
                      <Field
                        label="Translation command"
                        badge={
                          <StatusBadge tone="live">Applies now</StatusBadge>
                        }
                      >
                        <textarea
                          value={config.translationCommand}
                          onChange={(event) =>
                            updateStructuredConfig({
                              ...config,
                              translationCommand: event.target.value,
                            })
                          }
                          disabled={disabled}
                          placeholder="translate-command $PROMPT"
                          rows={5}
                          spellCheck={false}
                          className="w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-3 py-2.5 font-mono text-xs leading-5 text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </Field>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {["$PROMPT", "$INPUT_LANG", "$OUTPUT_LANG"].map(
                          (variable) => (
                            <code
                              key={variable}
                              className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-[10px] text-zinc-400"
                            >
                              {variable}
                            </code>
                          ),
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeSection === "homes" ? (
                  <div>
                    <SectionHeader
                      title="Additional Codex homes"
                      badge={<StatusBadge tone="live">Applies now</StatusBadge>}
                      action={
                        <button
                          type="button"
                          onClick={() =>
                            updateStructuredConfig({
                              ...config,
                              codexHomes: [
                                ...config.codexHomes,
                                { id: "", label: "", path: "" },
                              ],
                            })
                          }
                          disabled={disabled}
                          className="inline-flex h-8 items-center gap-1.5 rounded border border-cyan-600/60 bg-cyan-500/10 px-2.5 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add home
                        </button>
                      }
                    />
                    <div className="space-y-3 py-5">
                      {config.codexHomes.length === 0 ? (
                        <div className="flex min-h-40 flex-col items-center justify-center border-y border-dashed border-zinc-800 text-zinc-500">
                          <FolderCog className="h-6 w-6" />
                          <div className="mt-2 text-xs">
                            No additional homes
                          </div>
                        </div>
                      ) : (
                        config.codexHomes.map((home, index) => {
                          const homeErrors = validation.homes[index] ?? [];
                          return (
                            <div
                              key={`${index}:${home.id}`}
                              className={`rounded-md border bg-zinc-900/45 p-3 ${
                                homeErrors.length > 0
                                  ? "border-red-500/45"
                                  : "border-zinc-800"
                              }`}
                            >
                              <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_2rem]">
                                <Field label="Home ID">
                                  <input
                                    type="text"
                                    value={home.id}
                                    onChange={(event) => {
                                      const codexHomes = [...config.codexHomes];
                                      codexHomes[index] = {
                                        ...home,
                                        id: event.target.value,
                                      };
                                      updateStructuredConfig({
                                        ...config,
                                        codexHomes,
                                      });
                                    }}
                                    disabled={disabled}
                                    placeholder="work"
                                    spellCheck={false}
                                    className={`${INPUT_CLASS} font-mono text-xs`}
                                  />
                                </Field>
                                <Field label="Label">
                                  <input
                                    type="text"
                                    value={home.label}
                                    onChange={(event) => {
                                      const codexHomes = [...config.codexHomes];
                                      codexHomes[index] = {
                                        ...home,
                                        label: event.target.value,
                                      };
                                      updateStructuredConfig({
                                        ...config,
                                        codexHomes,
                                      });
                                    }}
                                    disabled={disabled}
                                    placeholder="Work"
                                    className={INPUT_CLASS}
                                  />
                                </Field>
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateStructuredConfig({
                                      ...config,
                                      codexHomes: config.codexHomes.filter(
                                        (_, candidateIndex) =>
                                          candidateIndex !== index,
                                      ),
                                    })
                                  }
                                  disabled={disabled}
                                  className="mt-[22px] h-9 w-8 rounded text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                                  title="Remove Codex home"
                                  aria-label="Remove Codex home"
                                >
                                  <Trash2 className="mx-auto h-4 w-4" />
                                </button>
                              </div>
                              <div className="mt-3">
                                <Field label="Directory path">
                                  <input
                                    type="text"
                                    value={home.path}
                                    onChange={(event) => {
                                      const codexHomes = [...config.codexHomes];
                                      codexHomes[index] = {
                                        ...home,
                                        path: event.target.value,
                                      };
                                      updateStructuredConfig({
                                        ...config,
                                        codexHomes,
                                      });
                                    }}
                                    disabled={disabled}
                                    placeholder="/path/to/codex-home"
                                    spellCheck={false}
                                    className={`${INPUT_CLASS} font-mono text-xs`}
                                  />
                                </Field>
                              </div>
                              {homeErrors.length > 0 ? (
                                <div
                                  className="mt-2 text-[11px] text-red-300"
                                  role="alert"
                                >
                                  {homeErrors.join(" ")}
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : null}

                {activeSection === "remote" ? (
                  <div>
                    <SectionHeader
                      title="Remote connection"
                      badge={<StatusBadge tone="restart">Restart</StatusBadge>}
                    />
                    <div className="grid gap-5 py-5 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <Field label="Server URL">
                          <input
                            type="url"
                            value={config.remote.serverUrl}
                            onChange={(event) =>
                              updateRemote("serverUrl", event.target.value)
                            }
                            disabled={disabled}
                            placeholder="https://your-server-host"
                            spellCheck={false}
                            className={INPUT_CLASS}
                          />
                        </Field>
                      </div>
                      <Field label="Username">
                        <input
                          type="text"
                          value={config.remote.username}
                          onChange={(event) =>
                            updateRemote("username", event.target.value)
                          }
                          disabled={disabled}
                          autoComplete="off"
                          className={INPUT_CLASS}
                        />
                      </Field>
                      <Field label="Password">
                        <SecretInput
                          label="password"
                          value={config.remote.password}
                          onChange={(value) => updateRemote("password", value)}
                          disabled={disabled}
                        />
                      </Field>
                      <Field label="Setup token">
                        <SecretInput
                          label="setup token"
                          value={config.remote.setupToken}
                          onChange={(value) =>
                            updateRemote("setupToken", value)
                          }
                          disabled={disabled}
                        />
                      </Field>
                      <Field label="Machine ID">
                        <input
                          type="text"
                          value={config.remote.machineId}
                          onChange={(event) =>
                            updateRemote("machineId", event.target.value)
                          }
                          disabled={disabled}
                          spellCheck={false}
                          className={`${INPUT_CLASS} font-mono text-xs`}
                        />
                      </Field>
                      <Field label="Pinned realm ID">
                        <input
                          type="text"
                          value={config.remote.pinnedRealmId}
                          onChange={(event) =>
                            updateRemote("pinnedRealmId", event.target.value)
                          }
                          disabled={disabled}
                          spellCheck={false}
                          className={`${INPUT_CLASS} font-mono text-xs`}
                        />
                      </Field>
                      <Field label="Pinned OPAQUE server key">
                        <SecretInput
                          label="OPAQUE server key"
                          value={config.remote.pinnedOpaqueServerKey}
                          onChange={(value) =>
                            updateRemote("pinnedOpaqueServerKey", value)
                          }
                          disabled={disabled}
                        />
                      </Field>
                    </div>
                  </div>
                ) : null}

                {activeSection === "updates" ? (
                  <div>
                    <SectionHeader
                      title="Daemon updates"
                      badge={
                        <StatusBadge tone="live">Live restart</StatusBadge>
                      }
                      action={
                        <button
                          type="button"
                          onClick={() => {
                            setUpdateStatus(null);
                            setUpdateError(null);
                            setUpdateResult(null);
                          }}
                          disabled={updateBusy}
                          className="inline-flex h-8 items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Refresh
                        </button>
                      }
                    />

                    {loadingUpdateStatus ? (
                      <div className="flex min-h-64 items-center justify-center text-sm text-zinc-500">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading daemon update status
                      </div>
                    ) : updateStatus ? (
                      <div className="space-y-4 py-5">
                        {!updateStatus.daemonManaged ? (
                          <div className="flex gap-2 rounded border border-amber-500/35 bg-amber-500/10 p-3 text-xs leading-5 text-amber-200">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{updateStatus.unavailableReason}</span>
                          </div>
                        ) : null}

                        <div className="grid gap-3 sm:grid-cols-2">
                          <button
                            type="button"
                            onClick={() => setUpdateMethod("npm")}
                            disabled={updateBusy}
                            aria-pressed={updateMethod === "npm"}
                            className={`rounded-md border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                              updateMethod === "npm"
                                ? "border-cyan-500/55 bg-cyan-500/10 ring-1 ring-inset ring-cyan-500/20"
                                : "border-zinc-800 bg-zinc-900/45 hover:border-zinc-700"
                            }`}
                          >
                            <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                              <Package className="h-4 w-4 text-cyan-300" />
                              npm release
                            </span>
                            <span className="mt-2 block text-xs leading-5 text-zinc-500">
                              Check the npm latest tag, install that release in
                              the daemon state directory, then restart.
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setUpdateMethod("source")}
                            disabled={updateBusy}
                            aria-pressed={updateMethod === "source"}
                            className={`rounded-md border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                              updateMethod === "source"
                                ? "border-cyan-500/55 bg-cyan-500/10 ring-1 ring-inset ring-cyan-500/20"
                                : "border-zinc-800 bg-zinc-900/45 hover:border-zinc-700"
                            }`}
                          >
                            <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                              <GitBranch className="h-4 w-4 text-cyan-300" />
                              Source project
                            </span>
                            <span className="mt-2 block text-xs leading-5 text-zinc-500">
                              Build the source currently on disk and restart; no
                              version check is required.
                            </span>
                          </button>
                        </div>

                        {updateMethod === "npm" ? (
                          <div className="rounded-md border border-zinc-800 bg-zinc-900/35 p-4">
                            <div className="grid gap-3 text-xs sm:grid-cols-2">
                              <div>
                                <div className="text-zinc-500">
                                  Running version
                                </div>
                                <div className="mt-1 font-mono text-zinc-200">
                                  {updateStatus.currentVersion}
                                </div>
                              </div>
                              <div>
                                <div className="text-zinc-500">
                                  Latest npm version
                                </div>
                                <div className="mt-1 font-mono text-zinc-200">
                                  {updateStatus.npm.latestVersion ??
                                    "Not checked"}
                                </div>
                              </div>
                            </div>
                            {updateStatus.npm.checked ? (
                              <div className="mt-3 text-xs text-zinc-400">
                                {updateStatus.npm.updateAvailable
                                  ? "A newer npm release is available."
                                  : updateStatus.updateMethod === "npm"
                                    ? "This daemon is using the latest npm release."
                                    : "The npm release is current; you can still switch this source-managed daemon to it."}
                              </div>
                            ) : null}
                            <div className="mt-4 flex flex-wrap justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => void handleCheckNpmUpdate()}
                                disabled={updateBusy}
                                className="inline-flex h-8 items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {checkingUpdate ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3.5 w-3.5" />
                                )}
                                {checkingUpdate
                                  ? "Checking"
                                  : "Check for updates"}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDaemonUpdate()}
                                disabled={
                                  updateBusy ||
                                  !updateStatus.restartSupported ||
                                  !npmActionAvailable
                                }
                                className="inline-flex h-8 items-center gap-1.5 rounded border border-cyan-600/70 bg-cyan-600/25 px-3 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-600/35 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {applyingUpdate ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Download className="h-3.5 w-3.5" />
                                )}
                                {applyingUpdate
                                  ? "Updating and restarting"
                                  : updateStatus.updateMethod === "npm"
                                    ? "Update and restart"
                                    : "Switch to npm and restart"}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-md border border-zinc-800 bg-zinc-900/35 p-4">
                            <Field label="Source project root">
                              <input
                                type="text"
                                value={sourceRoot}
                                onChange={(event) => {
                                  setSourceRoot(event.target.value);
                                  setUpdateError(null);
                                  setUpdateResult(null);
                                }}
                                disabled={updateBusy}
                                placeholder={updateStatus.defaultSourceRoot}
                                spellCheck={false}
                                className={`${INPUT_CLASS} font-mono text-xs`}
                              />
                            </Field>
                            <div className="mt-2 text-[11px] leading-4 text-zinc-500">
                              Defaulted from the directory where
                              <code className="mx-1 text-zinc-400">
                                codex-deck-daemon start
                              </code>
                              was run. The update runs a frozen pnpm install and
                              the project build before switching the daemon to
                              this root.
                            </div>
                            <div className="mt-4 flex justify-end">
                              <button
                                type="button"
                                onClick={() => void handleDaemonUpdate()}
                                disabled={
                                  updateBusy ||
                                  !updateStatus.restartSupported ||
                                  !sourceRoot.trim()
                                }
                                className="inline-flex h-8 items-center gap-1.5 rounded border border-cyan-600/70 bg-cyan-600/25 px-3 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-600/35 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {applyingUpdate ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <GitBranch className="h-3.5 w-3.5" />
                                )}
                                {applyingUpdate
                                  ? "Building and restarting"
                                  : "Build source and restart"}
                              </button>
                            </div>
                          </div>
                        )}

                        {applyingUpdate ||
                        updateOutput ||
                        updateRestartOutput ? (
                          <Field label="Build and restart output">
                            <textarea
                              ref={updateOutputRef}
                              readOnly
                              value={
                                (updateOutput
                                  ? `${updateOutput.truncated ? "[Earlier output omitted]\n" : ""}${updateOutput.output}`
                                  : applyingUpdate
                                    ? "Starting update…\n"
                                    : "") + updateRestartOutput
                              }
                              aria-label="Build and restart output"
                              spellCheck={false}
                              onScroll={(event) => {
                                const textarea = event.currentTarget;
                                followUpdateOutputRef.current =
                                  textarea.scrollHeight -
                                    textarea.scrollTop -
                                    textarea.clientHeight <
                                  32;
                              }}
                              className="h-64 min-h-40 w-full resize-y rounded border border-zinc-700 bg-zinc-900/35 px-3 py-2.5 font-mono text-xs leading-5 text-zinc-200 outline-none focus:border-cyan-500"
                            />
                          </Field>
                        ) : null}

                        {updateError ? (
                          <div
                            className="rounded border border-red-500/35 bg-red-500/10 px-3 py-2.5 text-xs text-red-300"
                            role="alert"
                          >
                            {updateError}
                          </div>
                        ) : null}
                        {updateResult ? (
                          <div className="flex gap-2 rounded border border-emerald-500/35 bg-emerald-500/10 px-3 py-2.5 text-xs leading-5 text-emerald-300">
                            {applyingUpdate ? (
                              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                            ) : (
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                            )}
                            <span>{updateResult}</span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {activeSection === "advanced" ? (
                  <div>
                    <SectionHeader title="TOML" />
                    <div className="py-5">
                      <label className="block">
                        <span className="sr-only">Config TOML</span>
                        <textarea
                          value={content}
                          onChange={(event) => {
                            const nextContent = event.target.value;
                            setContent(nextContent);
                            setConfig(parseCodexDeckConfigContent(nextContent));
                            setResult(null);
                            setError(null);
                          }}
                          disabled={disabled}
                          spellCheck={false}
                          autoCapitalize="off"
                          autoCorrect="off"
                          className="h-[min(55vh,31rem)] min-h-80 w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-3 py-3 font-mono text-xs leading-5 text-zinc-100 outline-none transition-colors focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </label>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {(error || result) && (
          <div className="border-t border-zinc-800 px-4 py-2.5 text-xs sm:px-5">
            {error ? (
              <div className="text-red-300" role="alert">
                {error}
              </div>
            ) : result ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-400">
                <span className="inline-flex items-center gap-1.5 text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Settings applied
                </span>
                {result.appliedKeys.length > 0 ? (
                  <span>Applied now: {result.appliedKeys.join(", ")}</span>
                ) : null}
                {result.restartRequiredKeys.length > 0 ? (
                  <span className="text-amber-300">
                    Restart: {result.restartRequiredKeys.join(", ")}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <footer className="flex min-h-[58px] items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-900/70 px-4">
          <div className="min-w-0 text-[11px] text-zinc-500">
            {hasBlockingValidation
              ? `${validation.count} setting${validation.count === 1 ? "" : "s"} need attention`
              : isDirty
                ? "Unsaved changes"
                : "No changes"}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving || applyingUpdate}
              className="h-8 rounded border border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={
                disabled || !revision || !isDirty || hasBlockingValidation
              }
              className="inline-flex h-8 items-center gap-1.5 rounded border border-cyan-600/70 bg-cyan-600/25 px-3 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-600/35 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {saving ? "Applying" : "Apply changes"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

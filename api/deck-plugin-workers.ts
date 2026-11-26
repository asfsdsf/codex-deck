import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { CodexDeckProxyConfig } from "./config";
import { codexProxyEnvironment } from "./codex-proxy";
import { DeckPluginBackendStorage } from "./deck-plugin-backend-storage";
import { DeckPluginCodexSessions } from "./deck-plugin-codex-sessions";
import type { ResolvedCodexHome } from "./codex-home-registry";
import { pluginHttpRequest } from "./deck-plugin-http";
import type {
  DeckPluginCapability,
  DeckPluginContributionsSnapshot,
  DeckPluginSession,
  DeckPluginStatus,
  DeckPluginSummary,
} from "./deck-plugin-manifest";
import { DeckPluginError, DeckPluginStore } from "./deck-plugin-store";
import { DeckPluginServices } from "./deck-plugin-services";

type UiState = {
  sessions: Record<string, boolean>;
  statuses: Record<string, DeckPluginStatus>;
};
type Intent = {
  requestId: string;
  threadId: string;
  expectedTurnId: string;
  turnId?: string | null;
  phase: "intent" | "accepted" | "ambiguous";
};
type Worker = {
  child: ChildProcess;
  plugin: DeckPluginSummary;
  abort: AbortController;
  pending: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  ready: boolean;
  stopping: boolean;
};
export interface DeckPluginWorkerHost {
  readSession: (id: string) => Promise<DeckPluginSession>;
  watchSession?: (id: string) => Promise<void>;
  sendMessage: (
    id: string,
    text: string,
    validate: () => void,
  ) => Promise<{ turnId: string | null }>;
  changed: () => void;
  proxy?: CodexDeckProxyConfig;
  codexHomes?: () => ResolvedCodexHome[];
  services?: DeckPluginServices;
  builtinError?: (id: string) => string | undefined;
}
const emptyUi = (): UiState => ({ sessions: {}, statuses: {} });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    throw new Error("Expected a nonempty identifier.");
  return value;
};

/** One manager per Codex home. UI connections never own worker lifetime. */
export class DeckPluginWorkers {
  readonly services: DeckPluginServices;
  private workers = new Map<string, Worker>();
  private errors = new Map<string, string>();
  private storage: DeckPluginBackendStorage;
  private codexSessions: DeckPluginCodexSessions;
  private epochs = new Map<string, number>();
  private locks = new Map<string, Promise<unknown>>();
  private identity = randomUUID();
  private active = false;
  private unsubscribeServices?: () => void;
  private reconciliation: Promise<unknown> = Promise.resolve();
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopping = new Map<string, Promise<void>>();
  private jobs = new Map<
    string,
    {
      pluginId: string;
      expiresAt: number;
      done: boolean;
      result?: unknown;
      error?: string;
    }
  >();
  private serviceCalls = new Map<string, Set<AbortController>>();

  constructor(
    private readonly store: DeckPluginStore,
    private readonly host: DeckPluginWorkerHost,
  ) {
    this.services = host.services ?? new DeckPluginServices();
    this.storage = new DeckPluginBackendStorage(store.backendRoot);
    this.codexSessions = new DeckPluginCodexSessions(
      this.storage,
      () => this.host.codexHomes?.() ?? [],
    );
    store.beforePackageChange = (id) => this.stopPlugin(id);
  }

  revision(id: string): string {
    return `${this.identity}:${this.epochs.get(id) ?? 0}`;
  }
  manualAction(id: string, kind: string): Promise<void> {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    const timestamp = Date.now();
    this.event({ type: "manual_action", threadId: id, kind, timestamp });
    if (kind === "plugin_toggle") return Promise.resolve();
    return this.storage
      .change<Record<string, Record<string, unknown>>>(
        "codex-deck.lifecycle",
        "events",
        {},
        (records) => {
          records[id] = { ...records[id], manualActionAt: timestamp };
          return records;
        },
      )
      .then(() => {});
  }
  withSessionLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    this.locks.set(id, next);
    void next
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      })
      .catch(() => {});
    return next;
  }
  async start(): Promise<void> {
    this.active = true;
    this.unsubscribeServices?.();
    this.unsubscribeServices = this.services.subscribe(() => {
      for (const [id, worker] of this.workers)
        if (
          !worker.stopping &&
          worker.plugin.requires?.some((name) => !this.services.has(name))
        )
          void this.stopPlugin(id).catch(() => {});
      void this.reconcile().catch(() => {});
    });
    await this.reconcile();
    this.restartTimer = setInterval(() => {
      void this.reconcile().catch(() => {});
    }, 5000);
    this.restartTimer.unref();
  }
  reconcile(): Promise<void> {
    const next = this.reconciliation
      .catch(() => {})
      .then(async () => {
        if (!this.active) return;
        const { plugins } = await this.store.list();
        const enabled = plugins.filter(
          (p) =>
            p.enabled &&
            p.source !== "builtin" &&
            p.entrypoints.backend &&
            !p.requires?.some((name) => !this.services.has(name)),
        );
        for (const [id, worker] of this.workers) {
          if (
            !enabled.some(
              (p) => p.id === id && p.version === worker.plugin.version,
            )
          )
            await this.stopPlugin(id);
        }
        for (const plugin of enabled) {
          if (!this.active) return;
          if (!this.workers.has(plugin.id))
            await this.launch(plugin).catch(() => {
              this.errors.set(
                plugin.id,
                "Backend worker could not start. Check its package and Node installation.",
              );
              this.host.changed();
            });
        }
      });
    this.reconciliation = next;
    return next;
  }
  private async launch(plugin: DeckPluginSummary): Promise<void> {
    const path = await this.store.workerPath(plugin.id);
    if (!this.active) return;
    const child = spawn(process.execPath, [path], {
      cwd: dirname(path),
      env: { ...process.env, ...codexProxyEnvironment(this.host.proxy) },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    const worker: Worker = {
      child,
      plugin,
      abort: new AbortController(),
      pending: new Map(),
      ready: false,
      stopping: false,
    };
    this.workers.set(plugin.id, worker);
    this.errors.delete(plugin.id);
    child.on("message", (message: unknown) => {
      void this.message(worker, message);
    });
    child.on("error", () => this.failed(worker));
    child.on("exit", () => this.failed(worker));
    child.on("spawn", () =>
      this.send(worker, {
        type: "initialize",
        plugin: { id: plugin.id, version: plugin.version },
      }),
    );
    const ui = await this.storage.read(plugin.id, "ui", emptyUi());
    for (const [id, enabled] of Object.entries(ui.sessions)) {
      if (enabled) void this.host.watchSession?.(id).catch(() => {});
    }
  }
  private failed(worker: Worker): void {
    if (this.workers.get(worker.plugin.id) !== worker) return;
    this.workers.delete(worker.plugin.id);
    this.services.unload(worker.plugin.id);
    worker.abort.abort();
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Backend worker stopped."));
    }
    worker.pending.clear();
    this.errors.set(
      worker.plugin.id,
      "Backend worker stopped; restarting automatically.",
    );
    this.host.changed();
  }
  async stopPlugin(id: string, cancel = true): Promise<void> {
    for (const controller of this.serviceCalls.get(id) ?? [])
      controller.abort(new Error("Plugin was disabled or unloaded."));
    this.serviceCalls.delete(id);
    const current = this.stopping.get(id);
    if (current) return current;
    const worker = this.workers.get(id);
    if (!worker) return;
    if (worker.stopping) return;
    worker.stopping = true;
    this.services.unload(id);
    worker.abort.abort();
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Backend worker stopped."));
    }
    worker.pending.clear();
    // Remove public tips when disabled; persisted episodes remain private to the plugin.
    const work = (async () => {
      // Let the worker persist cancellation while submission permission is revoked.
      if (worker.ready && worker.child.connected)
        await new Promise<void>((resolve) => {
          const requestId = randomUUID();
          const timer = setTimeout(() => {
            worker.pending.delete(requestId);
            resolve();
          }, 1000);
          worker.pending.set(requestId, {
            timer,
            resolve: () => resolve(),
            reject: () => resolve(),
          });
          this.send(worker, {
            type: "request",
            requestId,
            method: "host.shutdown",
            params: { cancel },
          });
        });
      this.workers.delete(id);
      if (cancel) await this.codexSessions.cancel(id);
      await this.storage.change(id, "ui", emptyUi(), (ui) => ({
        ...ui,
        statuses: {},
      }));
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            worker.child.kill("SIGKILL");
          }, 1500);
          worker.child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          worker.child.kill("SIGTERM");
        });
      }
      this.host.changed();
    })();
    this.stopping.set(id, work);
    try {
      await work;
    } finally {
      this.stopping.delete(id);
    }
  }
  async stop(): Promise<void> {
    this.active = false;
    this.unsubscribeServices?.();
    clearInterval(this.restartTimer);
    await this.reconciliation.catch(() => {});
    await Promise.all(
      [...this.workers.keys()].map((id) => this.stopPlugin(id, false)),
    );
    await this.codexSessions.close();
  }
  event(event: unknown): void {
    const item = event as {
      type?: string;
      threadId?: string;
      status?: string;
      pending?: boolean;
      scope?: string;
    };
    if (
      item.threadId &&
      ((item.type === "thread_status" && item.status === "active") ||
        item.pending === true ||
        (item.type === "native_state_changed" && item.scope === "queue"))
    ) {
      this.epochs.set(item.threadId, (this.epochs.get(item.threadId) ?? 0) + 1);
    }
    const terminal = event as {
      type?: string;
      threadId?: string;
      turnId?: string;
      terminalStatus?: string;
      error?: unknown;
      timestamp?: number;
    };
    if (
      terminal.type === "thread_status" &&
      terminal.threadId &&
      terminal.turnId &&
      terminal.terminalStatus
    ) {
      void this.storage
        .change<Record<string, Record<string, unknown>>>(
          "codex-deck.lifecycle",
          "events",
          {},
          (records) => {
            records[terminal.threadId!] = {
              ...records[terminal.threadId!],
              turnId: terminal.turnId,
              status: terminal.terminalStatus,
              error: terminal.error ?? null,
              timestamp:
                records[terminal.threadId!]?.turnId === terminal.turnId
                  ? records[terminal.threadId!].timestamp
                  : (terminal.timestamp ?? Date.now()),
            };
            return records;
          },
        )
        .catch(() => {});
    }
    for (const worker of this.workers.values()) {
      if (worker.plugin.capabilities.includes("sessions.events"))
        this.send(worker, { type: "event", event });
    }
  }
  private send(worker: Worker, message: unknown): void {
    if (worker.child.connected)
      worker.child.send(
        message as Parameters<ChildProcess["send"]>[0],
        () => {},
      );
  }
  private allowed(worker: Worker, capability: DeckPluginCapability): void {
    if (
      this.workers.get(worker.plugin.id) !== worker ||
      (worker.stopping &&
        !["data.read", "data.write", "status.write"].includes(capability))
    )
      throw new Error("Backend worker is no longer enabled.");
    if (!worker.plugin.capabilities.includes(capability))
      throw new Error(`${capability} is not granted.`);
  }
  private async message(worker: Worker, value: unknown): Promise<void> {
    try {
      const msg = object(value);
      if (msg.type === "ready") {
        if (
          worker.stopping ||
          this.workers.get(worker.plugin.id) !== worker ||
          worker.ready
        )
          return;
        try {
          for (const name of worker.plugin.services?.provides ?? []) {
            this.allowed(worker, "services.provide");
            this.services.register(
              worker.plugin.id,
              name,
              (method, params, call) =>
                this.requestWorker(worker, "service.call", {
                  service: name,
                  method,
                  params,
                  caller: call.caller,
                }),
            );
          }
          worker.ready = true;
        } catch (error) {
          this.errors.set(
            worker.plugin.id,
            error instanceof Error
              ? error.message
              : "Service registration failed.",
          );
          await this.stopPlugin(worker.plugin.id, false);
          this.host.changed();
          return;
        }
        this.host.changed();
        return;
      }
      if (msg.type === "response" && typeof msg.requestId === "string") {
        const pending = worker.pending.get(msg.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        worker.pending.delete(msg.requestId);
        if (msg.error) pending.reject(new Error(String(msg.error)));
        else pending.resolve(msg.result);
        return;
      }
      if (
        msg.type !== "request" ||
        typeof msg.requestId !== "string" ||
        msg.requestId.length > 128 ||
        typeof msg.method !== "string"
      )
        return;
      if (Buffer.byteLength(JSON.stringify(msg)) > 5 * 1024 * 1024)
        throw new Error("Worker request too large.");
      try {
        const result = await this.rpc(
          worker,
          msg.method,
          object(msg.params ?? {}),
        );
        this.send(worker, {
          type: "response",
          requestId: msg.requestId,
          result,
        });
      } catch (error) {
        this.send(worker, {
          type: "response",
          requestId: msg.requestId,
          error:
            error instanceof Error ? error.message : "Worker request failed.",
        });
      }
    } catch {
      /* Invalid worker IPC is ignored. */
    }
  }
  private async session(id: string): Promise<DeckPluginSession> {
    const revision = this.revision(id);
    const state = await this.host.readSession(id);
    if (revision !== this.revision(id))
      throw new Error("Session changed while reading state.");
    const record = (
      await this.storage.read<Record<string, Record<string, unknown>>>(
        "codex-deck.lifecycle",
        "events",
        {},
      )
    )[id];
    const latest = state.turns.at(-1);
    if (
      latest &&
      record?.turnId === latest.id &&
      record.status === latest.status
    ) {
      latest.completedAt ??=
        typeof record.timestamp === "number" ? record.timestamp : null;
      latest.error ??=
        record.error as DeckPluginSession["turns"][number]["error"];
    }
    return {
      ...state,
      revision,
      manualActionAt:
        typeof record?.manualActionAt === "number" ? record.manualActionAt : 0,
    };
  }
  private async rpc(
    worker: Worker,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = worker.plugin.id;
    const cap: Record<string, DeckPluginCapability> = {
      "data.get": "data.read",
      "data.set": "data.write",
      "secrets.get": "secrets.read",
      "secrets.set": "secrets.write",
      "sessions.get": "sessions.read",
      "sessions.list": "sessions.read",
      "sessions.submit": "sessions.submit",
      "sessions.submission": "sessions.read",
      "status.set": "status.write",
      "http.request": "http.request",
      "codex.homes.list": "codex.homes.read",
      "codex.sessions.ensure": "codex.sessions.manage",
      "codex.sessions.get": "codex.sessions.manage",
      "codex.sessions.submit": "codex.sessions.manage",
      "codex.sessions.interrupt": "codex.sessions.manage",
      "services.list": "services.call",
      "services.call": "services.call",
    };
    if (!cap[method]) throw new Error("Unsupported backend RPC.");
    this.allowed(worker, cap[method]);
    if (method === "services.list")
      return this.services
        .list()
        .filter((entry) => worker.plugin.services?.uses?.includes(entry.name));
    if (method === "services.call")
      return this.services.call(
        worker.plugin,
        text(params.service),
        text(params.method),
        params.params ?? {},
        worker.abort.signal,
      );
    const validate = () => this.allowed(worker, "codex.sessions.manage");
    if (method === "codex.homes.list") return this.codexSessions.listHomes();
    if (method === "codex.sessions.ensure")
      return this.codexSessions.ensure(id, params, validate);
    if (method === "codex.sessions.get")
      return this.codexSessions.get(id, params);
    if (method === "codex.sessions.submit")
      return this.codexSessions.submit(id, params, validate);
    if (method === "codex.sessions.interrupt")
      return this.codexSessions.interrupt(id, params);
    if (method === "data.get") return this.storage.read(id, "data", {});
    if (method === "data.set")
      return this.storage.change(id, "data", {}, () => object(params.data));
    if (method === "secrets.get") return this.storage.read(id, "secrets", {});
    if (method === "secrets.set")
      return this.setSecrets(id, object(params.secrets));
    if (method === "http.request")
      return pluginHttpRequest(params, this.host.proxy, worker.abort.signal);
    if (method === "sessions.get") return this.session(text(params.threadId));
    if (method === "sessions.list")
      return (await this.storage.read(id, "ui", emptyUi())).sessions;
    if (method === "status.set") {
      const threadId = text(params.threadId);
      const input = params.status === null ? null : object(params.status);
      const actions: NonNullable<DeckPluginStatus["actions"]> = [];
      if (input?.actions !== undefined) {
        if (!Array.isArray(input.actions) || input.actions.length > 4)
          throw new Error("Status supports at most four actions.");
        if (
          input.actions.length &&
          !worker.plugin.capabilities.includes("worker.request")
        )
          throw new Error("Status actions require worker.request.");
        for (const value of input.actions) {
          const action = object(value);
          const id = text(action.id);
          const label = text(action.label).trim();
          if (label.length > 80 || actions.some((item) => item.id === id))
            throw new Error(
              "Status action labels must be short and IDs unique.",
            );
          actions.push({ id, label });
        }
      }
      const status: DeckPluginStatus | null = input
        ? {
            phase: text(input.phase).slice(0, 80),
            reason:
              typeof input.reason === "string"
                ? input.reason.slice(0, 2000)
                : "",
            nextAt:
              typeof input.nextAt === "number" && Number.isFinite(input.nextAt)
                ? input.nextAt
                : null,
            deadline:
              typeof input.deadline === "number" &&
              Number.isFinite(input.deadline)
                ? input.deadline
                : null,
            actions,
            updatedAt: Date.now(),
          }
        : null;
      await this.storage.change(id, "ui", emptyUi(), (ui) => {
        if (status) ui.statuses[threadId] = status;
        else delete ui.statuses[threadId];
        return ui;
      });
      this.host.changed();
      return { ok: true };
    }
    if (method === "sessions.submission")
      return this.reconcileIntent(id, text(params.requestId));
    return this.withSessionLock(text(params.threadId), () =>
      this.submit(worker, params),
    );
  }
  private async reconcileIntent(
    id: string,
    requestId: string,
  ): Promise<Intent | null> {
    const intents = await this.storage.read<Record<string, Intent>>(
      id,
      "submissions",
      {},
    );
    const intent = intents[requestId];
    if (!intent || intent.phase === "accepted") return intent ?? null;
    const state = await this.session(intent.threadId);
    const index = state.turns.findIndex(
      (turn) => turn.id === intent.expectedTurnId,
    );
    const next = index >= 0 ? state.turns[index + 1] : undefined;
    if (next?.userText === "continue") {
      intent.turnId = next.id;
      intent.phase = "accepted";
      await this.storage.change<Record<string, Intent>>(
        id,
        "submissions",
        {},
        (data) => ({ ...data, [requestId]: intent }),
      );
    }
    return intent;
  }
  private async submit(
    worker: Worker,
    params: Record<string, unknown>,
  ): Promise<Intent> {
    const id = worker.plugin.id;
    const threadId = text(params.threadId);
    const requestId = text(params.requestId);
    const expectedTurnId = text(params.expectedTurnId);
    const existing = await this.storage.read<Record<string, Intent>>(
      id,
      "submissions",
      {},
    );
    const duplicate = Object.values(existing).find(
      (value) =>
        value.threadId === threadId && value.expectedTurnId === expectedTurnId,
    );
    const previous = await this.reconcileIntent(
      id,
      duplicate?.requestId ?? requestId,
    );
    if (previous) return previous;
    if (params.text !== "continue")
      throw new Error("Guarded submissions currently accept exactly continue.");
    const state = await this.session(threadId);
    const ui = await this.storage.read(id, "ui", emptyUi());
    const last = state.turns.at(-1);
    if (
      !ui.sessions[threadId] ||
      !state.interactive ||
      state.activeTurnId ||
      state.pendingInteraction ||
      state.queuedMessages ||
      last?.id !== expectedTurnId ||
      last.status !== "failed" ||
      params.revision !== state.revision
    )
      throw new Error("Session no longer permits this submission.");
    const expiresAt = params.expiresAt;
    if (
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw new Error("Submission deadline has passed.");
    const validate = () => {
      if (Date.now() >= expiresAt)
        throw new Error("Submission deadline has passed.");
      this.allowed(worker, "sessions.submit");
      if (this.revision(threadId) !== state.revision)
        throw new Error("A newer action superseded this submission.");
    };
    validate();
    const intent: Intent = {
      requestId,
      threadId,
      expectedTurnId,
      phase: "intent",
    };
    await this.storage.change<Record<string, Intent>>(
      id,
      "submissions",
      {},
      (data) => ({ ...data, [requestId]: intent }),
    );
    try {
      validate();
      const result = await this.host.sendMessage(
        threadId,
        "continue",
        validate,
      );
      intent.phase = "accepted";
      intent.turnId = result.turnId;
    } catch {
      // Unknown acceptance must survive restarts. A new request ID cannot bypass this intent.
      intent.phase = "ambiguous";
    }
    await this.storage.change<Record<string, Intent>>(
      id,
      "submissions",
      {},
      (data) => ({ ...data, [requestId]: intent }),
    );
    return intent;
  }
  async snapshot(): Promise<DeckPluginContributionsSnapshot> {
    const { plugins } = await this.store.list();
    return {
      serverTime: Date.now(),
      plugins: await Promise.all(
        plugins
          .filter((p) => p.enabled)
          .map(async (p) => ({
            id: p.id,
            name: p.name,
            source: p.source,
            contributions: p.contributions ?? {},
            ...(await this.storage.read(p.id, "ui", emptyUi())),
            ...(p.requires?.some((name) => !this.services.has(name)) ||
            this.errors.has(p.id) ||
            this.host.builtinError?.(p.id)
              ? {
                  workerError: p.requires?.some(
                    (name) => !this.services.has(name),
                  )
                    ? `Waiting for services: ${p.requires.filter((name) => !this.services.has(name)).join(", ")}`
                    : (this.errors.get(p.id) ?? this.host.builtinError?.(p.id)),
                }
              : {}),
          })),
      ),
    };
  }
  async setSessionEnabled(
    id: string,
    threadId: string,
    enabled: boolean,
  ): Promise<DeckPluginContributionsSnapshot> {
    const plugin = (await this.store.list()).plugins.find(
      (p) => p.id === id && p.enabled,
    );
    if (!plugin?.contributions?.sessionToggle)
      throw new DeckPluginError("Plugin has no enabled session toggle.", 404);
    await this.manualAction(threadId, "plugin_toggle");
    await this.storage.change(id, "ui", emptyUi(), (ui) => {
      ui.sessions[threadId] = enabled;
      if (!enabled) delete ui.statuses[threadId];
      return ui;
    });
    if (enabled) void this.host.watchSession?.(threadId).catch(() => {});
    this.event({
      type: "session_toggle",
      pluginId: id,
      threadId,
      enabled,
      timestamp: Date.now(),
    });
    this.host.changed();
    return this.snapshot();
  }
  async secretStatus(id: string): Promise<Record<string, boolean>> {
    const runtime = await this.store.getRuntime(id);
    if (!runtime.manifest.capabilities.includes("secrets.read"))
      throw new DeckPluginError("secrets.read is not granted.", 400);
    const secrets = await this.storage.read<Record<string, string>>(
      id,
      "secrets",
      {},
    );
    return Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, !!value]),
    );
  }
  async setSecrets(
    id: string,
    changes: Record<string, unknown>,
  ): Promise<Record<string, boolean>> {
    const runtime = await this.store.getRuntime(id);
    if (!runtime.manifest.capabilities.includes("secrets.write"))
      throw new DeckPluginError("secrets.write is not granted.", 400);
    for (const [key, value] of Object.entries(changes)) {
      if (
        !/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) ||
        (value !== null && (typeof value !== "string" || value.length > 8192))
      )
        throw new DeckPluginError("Invalid secret value.", 400);
    }
    await this.storage.change<Record<string, string>>(
      id,
      "secrets",
      {},
      (values) => {
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === "") delete values[key];
          else values[key] = value as string;
        }
        return values;
      },
    );
    this.sendTo(id, { type: "settings_changed" });
    return this.secretStatus(id);
  }
  private sendTo(id: string, event: unknown): void {
    const worker = this.workers.get(id);
    if (worker) this.send(worker, { type: "event", event });
  }
  async beginRequest(
    id: string,
    method: string,
    params: unknown,
    serviceCall = false,
  ): Promise<{ requestId: string }> {
    const runtime = await this.store.getRuntime(id);
    const capability = serviceCall ? "services.call" : "worker.request";
    if (!runtime.manifest.capabilities.includes(capability))
      throw new DeckPluginError(`${capability} is not granted.`, 400);
    for (const [key, job] of this.jobs)
      if (job.expiresAt < Date.now()) this.jobs.delete(key);
    if (this.jobs.size >= 256)
      throw new DeckPluginError("Too many pending plugin requests.", 409);
    const requestId = randomUUID();
    const job = {
      pluginId: id,
      expiresAt: Date.now() + 300_000,
      done: false,
    } as {
      pluginId: string;
      expiresAt: number;
      done: boolean;
      result?: unknown;
      error?: string;
    };
    this.jobs.set(requestId, job);
    const input = serviceCall ? object(params) : null;
    const controller = serviceCall ? new AbortController() : null;
    if (controller) {
      const calls = this.serviceCalls.get(id) ?? new Set<AbortController>();
      calls.add(controller);
      this.serviceCalls.set(id, calls);
    }
    const operation = serviceCall
      ? this.services.call(
          runtime.manifest,
          text(input!.service),
          method,
          input!.params ?? {},
          controller!.signal,
        )
      : this.request(id, method, params);
    void operation
      .then(
        (result) => {
          job.result = result;
          job.done = true;
        },
        (error: unknown) => {
          job.error =
            error instanceof Error ? error.message : "Plugin request failed.";
          job.done = true;
        },
      )
      .finally(() => {
        if (controller) this.serviceCalls.get(id)?.delete(controller);
      });
    return { requestId };
  }

  async readRequest(
    id: string,
    requestId: string,
  ): Promise<{ done: boolean; result?: unknown; error?: string }> {
    await this.store.getRuntime(id);
    const job = this.jobs.get(requestId);
    if (!job || job.pluginId !== id || job.expiresAt < Date.now())
      throw new DeckPluginError(
        "Plugin request expired or was not found.",
        404,
      );
    return {
      done: job.done,
      ...(job.done && job.error
        ? { error: job.error }
        : job.done
          ? { result: job.result ?? null }
          : {}),
    };
  }

  async request(id: string, method: string, params: unknown): Promise<unknown> {
    const runtime = await this.store.getRuntime(id);
    if (!runtime.manifest.capabilities.includes("worker.request"))
      throw new DeckPluginError("worker.request is not granted.", 400);
    const worker = this.workers.get(id);
    if (worker && !worker.ready)
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const check = () => {
          if (worker.ready || worker.stopping || Date.now() - start >= 5000)
            resolve();
          else setTimeout(check, 25);
        };
        check();
      });
    if (!worker?.ready || worker.stopping)
      throw new DeckPluginError(
        "Backend worker is starting or unavailable.",
        409,
      );
    return this.requestWorker(worker, method, params);
  }
  private requestWorker(
    worker: Worker,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (
      !worker.ready ||
      worker.stopping ||
      this.workers.get(worker.plugin.id) !== worker
    )
      return Promise.reject(new Error("Backend worker is unavailable."));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(requestId);
        reject(new Error("Plugin request timed out."));
      }, 125_000);
      worker.pending.set(requestId, { resolve, reject, timer });
      this.send(worker, { type: "request", requestId, method, params });
    });
  }
}

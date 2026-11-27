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
  DeckPluginAppliedPromptSummary,
  DeckPluginBeforeFirstMessageJobStatus,
  DeckPluginBeforeFirstMessagePluginResult,
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
  private hookJobs = new Map<
    string,
    {
      jobId: string;
      threadId: string;
      startedAt: number;
      expiresAt: number;
      done: boolean;
      canceled: boolean;
      abort: AbortController;
      plugins: Array<{ id: string; name: string; waitingLabel: string }>;
      activePlugin: { id: string; name: string; waitingLabel: string } | null;
      phase: string;
      completedPlugins: DeckPluginBeforeFirstMessagePluginResult[];
      originalText: string;
      text: string;
      changed: boolean;
      /** Developer context by plugin ID, held server-side until claimed. */
      contexts: Record<string, string>;
      /** Replacement system prompt; the last hook that sets it wins. */
      baseInstructions: string | null;
      contextClaimed: boolean;
      error?: string;
    }
  >();

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
    for (const job of this.hookJobs.values()) {
      if (!job.done && job.activePlugin?.id === id) {
        job.error = `${job.activePlugin.name} was disabled or unloaded.`;
        job.phase = "error";
        job.activePlugin = null;
        job.done = true;
        job.abort.abort(new Error(job.error));
      }
    }
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
    for (const job of this.hookJobs.values()) {
      if (!job.done) {
        job.canceled = true;
        job.done = true;
        job.phase = "canceled";
        job.activePlugin = null;
        job.abort.abort(new Error("Daemon stopped."));
      }
    }
    this.hookJobs.clear();
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

  async beginBeforeFirstMessageHook(
    rawParams: Record<string, unknown>,
  ): Promise<DeckPluginBeforeFirstMessageJobStatus> {
    const threadId = text(rawParams.threadId);
    if (
      typeof rawParams.text !== "string" ||
      !rawParams.text.trim() ||
      Buffer.byteLength(rawParams.text, "utf8") > 256 * 1024
    ) {
      throw new DeckPluginError(
        "text is required and must be at most 256 KiB.",
        400,
      );
    }
    const originalText = rawParams.text;
    const cwd =
      typeof rawParams.cwd === "string" && rawParams.cwd.trim()
        ? rawParams.cwd.trim().slice(0, 4096)
        : null;
    const model =
      typeof rawParams.model === "string" && rawParams.model.trim()
        ? rawParams.model.trim().slice(0, 200)
        : null;
    const effort =
      typeof rawParams.effort === "string" && rawParams.effort.trim()
        ? rawParams.effort.trim().slice(0, 64)
        : null;
    const mode =
      typeof rawParams.mode === "string" && rawParams.mode.trim()
        ? rawParams.mode.trim().slice(0, 64)
        : null;
    const imageCount =
      typeof rawParams.imageCount === "number" &&
      Number.isInteger(rawParams.imageCount) &&
      rawParams.imageCount >= 0
        ? rawParams.imageCount
        : 0;
    const audioCount =
      typeof rawParams.audioCount === "number" &&
      Number.isInteger(rawParams.audioCount) &&
      rawParams.audioCount >= 0
        ? rawParams.audioCount
        : 0;

    const { plugins } = await this.store.list();
    const matching = plugins
      .filter(
        (plugin) =>
          plugin.enabled &&
          plugin.source !== "builtin" &&
          Boolean(plugin.entrypoints.backend) &&
          plugin.capabilities.includes("sessions.transform") &&
          Boolean(plugin.contributions?.beforeFirstMessage) &&
          !plugin.requires?.some((name) => !this.services.has(name)),
      )
      .sort(
        (left, right) =>
          (left.contributions?.beforeFirstMessage?.order ?? 0) -
            (right.contributions?.beforeFirstMessage?.order ?? 0) ||
          left.id.localeCompare(right.id),
      );

    const startedAt = Date.now();
    if (matching.length === 0) {
      return {
        jobId: null,
        done: true,
        plugins: [],
        activePlugin: null,
        phase: "done",
        startedAt,
        completedPlugins: [],
        text: originalText,
        originalText,
        changed: false,
      };
    }

    for (const [key, existing] of this.hookJobs) {
      if (existing.expiresAt < startedAt) this.hookJobs.delete(key);
    }
    if (this.hookJobs.size >= 128) {
      throw new DeckPluginError("Too many pending plugin hook jobs.", 409);
    }

    const pluginEntries = matching.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      waitingLabel:
        plugin.contributions?.beforeFirstMessage?.waitingLabel ??
        `Waiting for ${plugin.name}…`,
    }));
    const jobId = randomUUID();
    const job = {
      jobId,
      threadId,
      startedAt,
      expiresAt: startedAt + 300_000,
      done: false,
      canceled: false,
      abort: new AbortController(),
      plugins: pluginEntries,
      activePlugin: (pluginEntries[0] ?? null) as {
        id: string;
        name: string;
        waitingLabel: string;
      } | null,
      phase: "running",
      completedPlugins: [] as DeckPluginBeforeFirstMessagePluginResult[],
      originalText,
      text: originalText,
      changed: false,
      contexts: {} as Record<string, string>,
      baseInstructions: null as string | null,
      contextClaimed: false,
      error: undefined as string | undefined,
    };
    this.hookJobs.set(jobId, job);

    void (async () => {
      let currentText = originalText;
      try {
        for (let index = 0; index < matching.length; index++) {
          if (job.abort.signal.aborted) return;
          const plugin = matching[index];
          const meta = pluginEntries[index];
          const hook = plugin.contributions!.beforeFirstMessage!;
          job.activePlugin = meta;
          job.phase = "running";

          const worker = await this.waitForReadyWorker(
            plugin.id,
            job.abort.signal,
          );
          if (job.abort.signal.aborted) return;
          if (!worker) {
            throw new Error(
              `${plugin.name} worker is starting or unavailable.`,
            );
          }

          const rawResult = await this.requestWorker(
            worker,
            hook.method,
            {
              hookJobId: jobId,
              threadId,
              cwd,
              text: currentText,
              originalText,
              model,
              effort,
              mode,
              imageCount,
              audioCount,
              // Hooks may return `context` (developer-level instructions)
              // and `baseInstructions` (a replacement system prompt).
              contextSupported: true,
              systemPromptSupported: true,
            },
            job.abort.signal,
          );
          if (job.abort.signal.aborted) return;

          const parsed = this.parseBeforeFirstMessageResult(
            rawResult,
            currentText,
          );
          currentText = parsed.text;
          if (parsed.context) job.contexts[plugin.id] = parsed.context;
          else delete job.contexts[plugin.id];
          if (parsed.baseInstructions)
            job.baseInstructions = parsed.baseInstructions;
          job.completedPlugins.push({
            pluginId: plugin.id,
            pluginName: plugin.name,
            changed: parsed.changed,
            ...(parsed.context ? { contextChars: parsed.context.length } : {}),
            ...(parsed.baseInstructions ? { systemPromptChanged: true } : {}),
            ...(parsed.skipped ? { skipped: true } : {}),
            ...(parsed.summary ? { summary: parsed.summary } : {}),
            ...(parsed.appliedItems?.length
              ? { appliedItems: parsed.appliedItems }
              : {}),
          });
        }

        if (job.abort.signal.aborted) return;
        job.text = currentText;
        job.changed = currentText !== originalText;
        job.activePlugin = null;
        job.phase = "done";
        job.done = true;
      } catch (error) {
        if (job.canceled || job.abort.signal.aborted) {
          job.activePlugin = null;
          job.done = true;
          return;
        }
        const message =
          error instanceof Error ? error.message : "Plugin hook failed.";
        if (job.activePlugin) {
          job.completedPlugins.push({
            pluginId: job.activePlugin.id,
            pluginName: job.activePlugin.name,
            changed: false,
            error: message,
          });
        }
        job.contexts = {};
        job.baseInstructions = null;
        job.error = job.activePlugin
          ? `${job.activePlugin.name}: ${message}`
          : message;
        job.activePlugin = null;
        job.phase = "error";
        job.done = true;
      }
    })();

    return this.formatBeforeFirstMessageJob(job);
  }

  async readBeforeFirstMessageHook(
    jobId: string,
  ): Promise<DeckPluginBeforeFirstMessageJobStatus> {
    const job = this.hookJobs.get(jobId);
    if (!job || job.expiresAt < Date.now()) {
      throw new DeckPluginError(
        "Plugin hook job expired or was not found.",
        404,
      );
    }
    return this.formatBeforeFirstMessageJob(job);
  }

  /**
   * Hand a finished job's developer context and system prompt to the send
   * route, once. The browser only names the job, so it cannot supply either.
   */
  claimBeforeFirstMessageResult(
    jobId: string,
    threadId: string,
  ): {
    context: Record<string, string> | null;
    baseInstructions: string | null;
  } | null {
    const job = this.hookJobs.get(jobId);
    if (
      !job ||
      job.expiresAt < Date.now() ||
      !job.done ||
      job.canceled ||
      job.error ||
      job.threadId !== threadId ||
      job.contextClaimed
    ) {
      return null;
    }
    job.contextClaimed = true;
    const context = Object.keys(job.contexts).length
      ? { ...job.contexts }
      : null;
    if (!context && job.baseInstructions === null) return null;
    return { context, baseInstructions: job.baseInstructions };
  }

  async cancelBeforeFirstMessageHook(
    jobId: string,
  ): Promise<DeckPluginBeforeFirstMessageJobStatus> {
    const job = this.hookJobs.get(jobId);
    if (!job || job.expiresAt < Date.now()) {
      return {
        jobId,
        done: true,
        canceled: true,
        plugins: [],
        activePlugin: null,
        phase: "canceled",
        startedAt: Date.now(),
        completedPlugins: [],
      };
    }
    if (!job.done) {
      const activeId = job.activePlugin?.id;
      job.canceled = true;
      job.done = true;
      job.phase = "canceled";
      job.activePlugin = null;
      job.contexts = {};
      job.baseInstructions = null;
      if (activeId) {
        this.sendTo(activeId, {
          type: "hook_canceled",
          hookJobId: job.jobId,
          threadId: job.threadId,
        });
      }
      job.abort.abort(new Error("Plugin hook canceled."));
    }
    return this.formatBeforeFirstMessageJob(job);
  }

  private async formatBeforeFirstMessageJob(job: {
    jobId: string;
    threadId: string;
    startedAt: number;
    done: boolean;
    canceled: boolean;
    plugins: Array<{ id: string; name: string; waitingLabel: string }>;
    activePlugin: { id: string; name: string; waitingLabel: string } | null;
    phase: string;
    completedPlugins: DeckPluginBeforeFirstMessagePluginResult[];
    originalText: string;
    text: string;
    changed: boolean;
    contexts: Record<string, string>;
    baseInstructions: string | null;
    error?: string;
  }): Promise<DeckPluginBeforeFirstMessageJobStatus> {
    let phase = job.phase;
    let detail: string | undefined;
    if (!job.done && job.activePlugin) {
      const ui = await this.storage
        .read(job.activePlugin.id, "ui", emptyUi())
        .catch(() => emptyUi());
      const status = ui.statuses[job.threadId];
      if (status && status.updatedAt >= job.startedAt - 2000) {
        if (status.phase) phase = status.phase;
        if (status.reason) detail = status.reason;
      }
    }
    return {
      jobId: job.jobId,
      done: job.done,
      ...(job.canceled ? { canceled: true } : {}),
      plugins: job.plugins,
      activePlugin: job.activePlugin,
      phase,
      ...(detail ? { detail } : {}),
      startedAt: job.startedAt,
      completedPlugins: job.completedPlugins,
      ...(job.done
        ? {
            text: job.text,
            originalText: job.originalText,
            changed: job.changed,
            hasContext: Object.keys(job.contexts).length > 0,
            hasSystemPrompt: job.baseInstructions !== null,
            ...(job.error ? { error: job.error } : {}),
          }
        : {}),
    };
  }

  private parseBeforeFirstMessageResult(
    value: unknown,
    fallbackText: string,
  ): {
    text: string;
    changed: boolean;
    skipped: boolean;
    context?: string;
    baseInstructions?: string;
    summary?: string;
    appliedItems?: DeckPluginAppliedPromptSummary[];
  } {
    if (value === null || value === undefined) {
      return { text: fallbackText, changed: false, skipped: true };
    }
    const record = object(value);
    let context: string | undefined;
    if (record.context !== undefined && record.context !== null) {
      if (
        typeof record.context !== "string" ||
        Buffer.byteLength(record.context, "utf8") > 64 * 1024
      ) {
        throw new Error(
          "Plugin returned invalid developer context (a string of at most 64 KiB).",
        );
      }
      context = record.context.trim() || undefined;
    }
    let baseInstructions: string | undefined;
    if (
      record.baseInstructions !== undefined &&
      record.baseInstructions !== null
    ) {
      if (
        typeof record.baseInstructions !== "string" ||
        !record.baseInstructions.trim() ||
        Buffer.byteLength(record.baseInstructions, "utf8") > 512 * 1024
      ) {
        throw new Error(
          "Plugin returned an invalid system prompt (a nonempty string of at most 512 KiB).",
        );
      }
      baseInstructions = record.baseInstructions;
    }
    let nextText = fallbackText;
    if (record.text !== undefined) {
      if (
        typeof record.text !== "string" ||
        !record.text.trim() ||
        Buffer.byteLength(record.text, "utf8") > 512 * 1024
      ) {
        throw new Error("Plugin returned invalid transformed message text.");
      }
      nextText = record.text;
    }
    const summary =
      typeof record.summary === "string" && record.summary.trim()
        ? record.summary.trim().slice(0, 400)
        : undefined;
    let appliedItems: DeckPluginAppliedPromptSummary[] | undefined;
    if (Array.isArray(record.appliedItems)) {
      appliedItems = record.appliedItems
        .slice(0, 32)
        .flatMap((entry): DeckPluginAppliedPromptSummary[] => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return [];
          }
          const item = entry as Record<string, unknown>;
          const itemId =
            typeof item.id === "string" ? item.id.trim().slice(0, 120) : "";
          const name =
            typeof item.name === "string" ? item.name.trim().slice(0, 120) : "";
          const mode =
            typeof item.mode === "string" ? item.mode.trim().slice(0, 40) : "";
          if (!itemId || !name || !mode) return [];
          const reason =
            typeof item.reason === "string" && item.reason.trim()
              ? item.reason.trim().slice(0, 400)
              : undefined;
          return [{ id: itemId, name, mode, ...(reason ? { reason } : {}) }];
        });
    }
    return {
      text: nextText,
      changed:
        typeof record.changed === "boolean"
          ? record.changed
          : nextText !== fallbackText,
      skipped: record.skipped === true,
      ...(context ? { context } : {}),
      ...(baseInstructions ? { baseInstructions } : {}),
      ...(summary ? { summary } : {}),
      ...(appliedItems?.length ? { appliedItems } : {}),
    };
  }

  private async waitForReadyWorker(
    id: string,
    signal?: AbortSignal,
  ): Promise<Worker | null> {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (signal?.aborted) return null;
      const worker = this.workers.get(id);
      if (worker?.ready && !worker.stopping) return worker;
      if (worker?.stopping) return null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    const worker = this.workers.get(id);
    return worker?.ready && !worker.stopping ? worker : null;
  }

  async request(id: string, method: string, params: unknown): Promise<unknown> {
    const runtime = await this.store.getRuntime(id);
    if (!runtime.manifest.capabilities.includes("worker.request"))
      throw new DeckPluginError("worker.request is not granted.", 400);
    const worker = await this.waitForReadyWorker(id);
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      !worker.ready ||
      worker.stopping ||
      this.workers.get(worker.plugin.id) !== worker
    )
      return Promise.reject(new Error("Backend worker is unavailable."));
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Plugin request canceled."),
      );
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (!worker.pending.delete(requestId)) return;
        cleanup();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Plugin request canceled."),
        );
      };
      const timer = setTimeout(() => {
        if (!worker.pending.delete(requestId)) return;
        cleanup();
        reject(new Error("Plugin request timed out."));
      }, 125_000);
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.pending.set(requestId, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
      });
      this.send(worker, { type: "request", requestId, method, params });
    });
  }
}

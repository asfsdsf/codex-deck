import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { CodexAppServerClient } from "./codex-app-server";
import type { ResolvedCodexHome } from "./codex-home-registry";
import { codexProxyEnvironment } from "./codex-proxy";
import { parseOutputSchemaInput } from "./codex-output-schema";
import { DeckPluginBackendStorage } from "./deck-plugin-backend-storage";
import type { DeckPluginSession } from "./deck-plugin-manifest";

type Client = Pick<
  CodexAppServerClient,
  | "createThread"
  | "readPluginSession"
  | "sendMessage"
  | "interruptThread"
  | "close"
>;
type Submission = {
  requestId: string;
  previousTurnId: string | null;
  textHash: string;
  phase: "intent" | "accepted" | "ambiguous";
  turnId: string | null;
};
type ManagedSession = {
  sessionId: string;
  key: string;
  homeId: string;
  homePath: string;
  threadId: string;
  requests: Record<string, Submission>;
};
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    throw new Error("Expected a nonempty identifier.");
  return value;
};
const hash = (value: string) =>
  createHash("sha256").update(value.trim()).digest("hex");
const reference = (record: ManagedSession) => ({
  sessionId: record.sessionId,
  threadId: record.threadId,
  homeId: record.homeId,
  homePath: record.homePath,
});

/** Persistent, plugin-owned sessions. This API cannot send arbitrary text to existing user threads. */
export class DeckPluginCodexSessions {
  private clients = new Map<string, Client>();
  private locks = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(
    private readonly storage: DeckPluginBackendStorage,
    private readonly homes: () => ResolvedCodexHome[],
    private readonly createClient: (home: ResolvedCodexHome) => Client = (
      home,
    ) =>
      new CodexAppServerClient({
        cwd: home.path,
        readOnly: true,
        env: { CODEX_HOME: home.path, ...codexProxyEnvironment(home.proxy) },
      }),
  ) {}

  listHomes() {
    return this.homes().map(
      ({ id, label, path, available, unavailableReason }) => ({
        id,
        label,
        path,
        available,
        unavailableReason,
      }),
    );
  }
  private home(id: string, path?: string) {
    const home = this.homes().find(
      (home) => home.id === id && (!path || home.path === path),
    );
    if (!home?.available)
      throw new Error(
        "Selected Codex home is unavailable or its path changed. Choose an available home in settings.",
      );
    return home;
  }
  private client(home: ResolvedCodexHome): Client {
    if (this.closed) throw new Error("Plugin Codex sessions are stopped.");
    const key = JSON.stringify([home.path, home.proxy]);
    let client = this.clients.get(key);
    if (!client) {
      client = this.createClient(home);
      this.clients.set(key, client);
    }
    return client;
  }
  private lock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    this.locks.set(key, next);
    void next
      .finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      })
      .catch(() => {});
    return next;
  }
  private records(id: string) {
    return this.storage.read<Record<string, ManagedSession>>(
      id,
      "codexsessions",
      {},
    );
  }
  private persist(id: string, record: ManagedSession) {
    return this.storage.change<Record<string, ManagedSession>>(
      id,
      "codexsessions",
      {},
      (data) => ({ ...data, [record.sessionId]: record }),
    );
  }
  private async owned(id: string, sessionId: string) {
    const record = (await this.records(id))[sessionId];
    if (!record) throw new Error("Plugin-owned Codex session was not found.");
    return record;
  }
  async ensure(
    id: string,
    params: Record<string, unknown>,
    validate: () => void,
  ) {
    const key = identifier(params.key),
      home = this.home(identifier(params.homeId));
    return this.lock(JSON.stringify([id, home.path, key]), async () => {
      validate();
      const existing = Object.values(await this.records(id)).find(
        (record) => record.key === key && record.homePath === home.path,
      );
      if (existing) return reference(existing);
      const cwd = identifier(params.cwd);
      if (!isAbsolute(cwd))
        throw new Error("Session working directory must be absolute.");
      validate();
      const threadId = await this.client(home).createThread({
        cwd,
        readOnly: true,
      });
      validate();
      const record: ManagedSession = {
        sessionId: randomUUID(),
        key,
        homeId: home.id,
        homePath: home.path,
        threadId,
        requests: {},
      };
      await this.persist(id, record);
      return reference(record);
    });
  }
  private async reconcile(
    id: string,
    record: ManagedSession,
    state: DeckPluginSession,
    requestId: string,
  ) {
    const submission = record.requests[requestId];
    if (!submission || submission.phase === "accepted")
      return submission ?? null;
    const index =
      submission.previousTurnId === null
        ? -1
        : state.turns.findIndex(
            (turn) => turn.id === submission.previousTurnId,
          );
    const next =
      submission.previousTurnId === null || index >= 0
        ? state.turns[index + 1]
        : undefined;
    if (next && hash(next.userText) === submission.textHash) {
      submission.phase = "accepted";
      submission.turnId = next.id;
      await this.persist(id, record);
    }
    return submission;
  }
  async get(id: string, params: Record<string, unknown>) {
    const sessionId = identifier(params.sessionId);
    return this.lock(JSON.stringify([id, sessionId]), async () => {
      const record = await this.owned(id, sessionId);
      const state = await this.client(
        this.home(record.homeId, record.homePath),
      ).readPluginSession(record.threadId);
      const submission = params.requestId
        ? await this.reconcile(id, record, state, identifier(params.requestId))
        : null;
      return { ...reference(record), session: state, submission };
    });
  }
  async submit(
    id: string,
    params: Record<string, unknown>,
    validate: () => void,
  ) {
    const sessionId = identifier(params.sessionId),
      requestId = identifier(params.requestId);
    if (
      typeof params.text !== "string" ||
      !params.text.trim() ||
      params.text.length > 128_000
    )
      throw new Error("Invalid Codex session message.");
    const message = params.text;
    const schema = parseOutputSchemaInput(params.outputSchema);
    if (!schema.ok) throw new Error(schema.error);
    return this.lock(JSON.stringify([id, sessionId]), async () => {
      validate();
      const record = await this.owned(id, sessionId);
      const client = this.client(this.home(record.homeId, record.homePath));
      const state = await client.readPluginSession(record.threadId);
      const existing = record.requests[requestId];
      if (existing) {
        if (existing.textHash !== hash(message))
          throw new Error("Request ID already belongs to a different message.");
        return this.reconcile(id, record, state, requestId);
      }
      if (
        Object.values(record.requests).some(
          (request) => request.phase !== "accepted",
        )
      )
        throw new Error(
          "A previous Codex submission is ambiguous; reconcile it before submitting again.",
        );
      if (
        !state.interactive ||
        state.activeTurnId ||
        state.pendingInteraction ||
        state.queuedMessages
      )
        throw new Error(
          "Plugin Codex session is busy or needs user interaction.",
        );
      const submission: Submission = {
        requestId,
        previousTurnId: state.turns.at(-1)?.id ?? null,
        textHash: hash(message),
        phase: "intent",
        turnId: null,
      };
      record.requests[requestId] = submission;
      validate();
      await this.persist(id, record);
      try {
        validate();
        const result = await client.sendMessage({
          threadId: record.threadId,
          text: message,
          outputSchema: schema.value,
          readOnly: true,
          beforeSubmit: validate,
        });
        submission.turnId = result.turnId;
        submission.phase = result.turnId ? "accepted" : "ambiguous";
      } catch {
        submission.phase = "ambiguous";
      }
      await this.persist(id, record);
      return submission;
    });
  }
  async interrupt(id: string, params: Record<string, unknown>) {
    const { session, submission, ...ref } = await this.get(id, params);
    if (submission?.turnId && session.activeTurnId === submission.turnId) {
      const record = await this.owned(id, ref.sessionId);
      await this.client(
        this.home(record.homeId, record.homePath),
      ).interruptThread(record.threadId, submission.turnId);
    }
    return { ok: true };
  }
  async cancel(id: string) {
    await Promise.allSettled(
      [...this.locks]
        .filter(([key]) => JSON.parse(key)[0] === id)
        .map(([, work]) => work),
    );
    for (const record of Object.values(await this.records(id))) {
      const request = Object.values(record.requests).at(-1);
      if (request)
        await this.interrupt(id, {
          sessionId: record.sessionId,
          requestId: request.requestId,
        }).catch(() => {});
    }
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...this.clients.values()].map((client) => client.close()),
    );
    await Promise.allSettled([...this.locks.values()]);
    this.clients.clear();
  }
}

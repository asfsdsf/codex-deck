import { nativeRecord, type NativeRpc } from "./codex-native";

// Upstream execution environments (`environment/*`). The app-server has no
// list API, so Deck remembers the environments it registered for this
// process. Bearer tokens are forwarded once and never stored or returned.

export const LOCAL_ENVIRONMENT_ID = "local";

export type EnvironmentStatusKind =
  | "ready"
  | "pending"
  | "disconnected"
  | "unknown";

export interface EnvironmentRegistration {
  environmentId: string;
  execServerUrl: string;
  hasAuthToken: boolean;
  connectTimeoutMs: number | null;
  requiredSkills: string[];
  registeredAt: number;
}

export interface EnvironmentEntry {
  environmentId: string;
  builtIn: boolean;
  registration: EnvironmentRegistration | null;
  status: EnvironmentStatusKind | null;
  statusError: string | null;
  shell: { name: string; path: string } | null;
  cwd: string | null;
}

export interface TurnEnvironmentSelection {
  environmentId: string;
  cwd: string;
  runtimeWorkspaceRoots?: string[];
}

export interface EnvironmentConnectionEvent {
  threadId: string;
  environmentId: string;
  connected: boolean;
  at: number;
}

export interface ThreadEnvironmentSnapshot {
  threadId: string;
  /** Null when the thread is not loaded or the server does not report it. */
  environments: TurnEnvironmentSelection[] | null;
  /** Applied to the next turn this Deck starts for the thread. */
  pendingSelection: TurnEnvironmentSelection[] | null;
  events: EnvironmentConnectionEvent[];
}

export interface EnvironmentsSnapshot {
  available: boolean;
  unavailableReason: string | null;
  environments: EnvironmentEntry[];
  thread: ThreadEnvironmentSnapshot | null;
}

export interface EnvironmentAddInput {
  environmentId: string;
  execServerUrl: string;
  authBearerToken?: string | null;
  connectTimeoutMs?: number | null;
  requiredSkills?: string[] | null;
}

const STATUSES = new Set(["ready", "pending", "disconnected", "unknown"]);
const MAX_EVENTS = 200;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function isEnvironmentApiUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === -32601 ||
    /unknown variant|method not found|requires experimentalApi/i.test(
      message(error),
    )
  );
}

/** Converts the `file://` cwd reported by `environment/info` to a path. */
export function environmentCwdFromUri(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (!value.startsWith("file:")) return value;
  try {
    const path = decodeURIComponent(new URL(value).pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

export function parseThreadEnvironments(
  value: unknown,
): TurnEnvironmentSelection[] | null {
  if (!Array.isArray(value)) return null;
  const result: TurnEnvironmentSelection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.environmentId !== "string" ||
      typeof record.cwd !== "string"
    )
      continue;
    result.push({
      environmentId: record.environmentId,
      cwd: record.cwd,
      ...(Array.isArray(record.runtimeWorkspaceRoots)
        ? {
            runtimeWorkspaceRoots: record.runtimeWorkspaceRoots.filter(
              (root): root is string => typeof root === "string",
            ),
          }
        : {}),
    });
  }
  return result;
}

export class EnvironmentService {
  private readonly registrations = new Map<string, EnvironmentRegistration>();
  private readonly pending = new Map<string, TurnEnvironmentSelection[]>();
  private events: EnvironmentConnectionEvent[] = [];

  public constructor(
    private readonly rpc: NativeRpc,
    private readonly notify: (threadId: string | null) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private async readEntry(
    environmentId: string,
  ): Promise<{ entry: EnvironmentEntry; unsupported: string | null }> {
    const entry: EnvironmentEntry = {
      environmentId,
      builtIn: environmentId === LOCAL_ENVIRONMENT_ID,
      registration: this.registrations.get(environmentId) ?? null,
      status: null,
      statusError: null,
      shell: null,
      cwd: null,
    };
    try {
      const result = nativeRecord(
        await this.rpc("environment/status", { environmentId }),
      );
      if (typeof result.status !== "string" || !STATUSES.has(result.status))
        throw new Error("Invalid environment status");
      entry.status = result.status as EnvironmentStatusKind;
      entry.statusError =
        typeof result.error === "string" ? result.error : null;
    } catch (error) {
      if (isEnvironmentApiUnsupported(error))
        return { entry, unsupported: message(error) };
      entry.statusError = message(error);
      return { entry, unsupported: null };
    }
    // Info may connect to the executor, so only read it once ready.
    if (entry.status === "ready") {
      try {
        const info = nativeRecord(
          await this.rpc("environment/info", { environmentId }),
        );
        const shell = info.shell as Record<string, unknown> | undefined;
        if (
          shell &&
          typeof shell.name === "string" &&
          typeof shell.path === "string"
        )
          entry.shell = { name: shell.name, path: shell.path };
        entry.cwd = environmentCwdFromUri(info.cwd);
      } catch (error) {
        entry.statusError = message(error);
      }
    }
    return { entry, unsupported: null };
  }

  private async readThread(
    threadId: string,
  ): Promise<ThreadEnvironmentSnapshot> {
    let environments: TurnEnvironmentSelection[] | null = null;
    try {
      const thread = nativeRecord(
        nativeRecord(
          await this.rpc("thread/read", { threadId, includeTurns: false }),
        ).thread,
      );
      environments = parseThreadEnvironments(thread.environments);
    } catch {
      // An unloaded or new thread has no reported selection yet.
    }
    return {
      threadId,
      environments,
      pendingSelection: this.pending.get(threadId) ?? null,
      events: this.events.filter((event) => event.threadId === threadId),
    };
  }

  public async snapshot(
    threadId?: string | null,
  ): Promise<EnvironmentsSnapshot> {
    const ids = [LOCAL_ENVIRONMENT_ID, ...this.registrations.keys()].filter(
      (id, index, all) => all.indexOf(id) === index,
    );
    const entries = await Promise.all(ids.map((id) => this.readEntry(id)));
    const unsupported = entries.find((result) => result.unsupported);
    if (unsupported)
      return {
        available: false,
        unavailableReason: unsupported.unsupported,
        environments: [],
        thread: null,
      };
    return {
      available: true,
      unavailableReason: null,
      environments: entries.map((result) => result.entry),
      thread: threadId ? await this.readThread(threadId) : null,
    };
  }

  public async add(
    input: EnvironmentAddInput,
  ): Promise<EnvironmentRegistration> {
    const requiredSkills = (input.requiredSkills ?? []).filter(Boolean);
    await this.rpc("environment/add", {
      environmentId: input.environmentId,
      execServerUrl: input.execServerUrl,
      ...(input.authBearerToken
        ? { authBearerToken: input.authBearerToken }
        : {}),
      ...(input.connectTimeoutMs
        ? { connectTimeoutMs: input.connectTimeoutMs }
        : {}),
      ...(requiredSkills.length
        ? { skills: { required: requiredSkills } }
        : {}),
    });
    const registration: EnvironmentRegistration = {
      environmentId: input.environmentId,
      execServerUrl: input.execServerUrl,
      hasAuthToken: !!input.authBearerToken,
      connectTimeoutMs: input.connectTimeoutMs ?? null,
      requiredSkills,
      registeredAt: this.now(),
    };
    this.registrations.set(input.environmentId, registration);
    this.notify(null);
    return registration;
  }

  /** Selects environments for the next turn Deck starts on this thread. */
  public setPendingSelection(
    threadId: string,
    selection: TurnEnvironmentSelection[] | null,
  ): void {
    if (selection?.length) this.pending.set(threadId, selection);
    else this.pending.delete(threadId);
    this.notify(threadId);
  }

  /** Adds a pending selection to `turn/start` params; upstream keeps it sticky. */
  public applyPendingSelection(
    threadId: string,
    params: Record<string, unknown>,
  ): void {
    const selection = this.pending.get(threadId);
    if (selection && params.environments === undefined)
      params.environments = selection;
  }

  /** Clears the pending selection once a turn carrying it was accepted. */
  public confirmSelection(
    threadId: string,
    params: Record<string, unknown>,
  ): void {
    const selection = this.pending.get(threadId);
    if (!selection || params.environments !== selection) return;
    this.pending.delete(threadId);
    this.notify(threadId);
  }

  public handleNotification(method: string, params: unknown): boolean {
    if (
      method !== "thread/environment/connected" &&
      method !== "thread/environment/disconnected"
    )
      return false;
    const record =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : null;
    if (
      typeof record?.threadId !== "string" ||
      typeof record.environmentId !== "string"
    )
      return true;
    this.events.push({
      threadId: record.threadId,
      environmentId: record.environmentId,
      connected: method === "thread/environment/connected",
      at: this.now(),
    });
    this.events = this.events.slice(-MAX_EVENTS);
    this.notify(record.threadId);
    return true;
  }
}

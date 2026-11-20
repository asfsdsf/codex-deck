import { nativePages, nativeRecord, type NativeRpc } from "./codex-native";

// Upstream named projects (`project/*`) and thread sections
// (`threadSection/*`, `thread/section/move`). These complement, and never
// replace, Deck's directory-based project grouping.

export interface CodexProject {
  id: string;
  name: string;
  roots: string[];
  position: number;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
}

export interface CodexThreadSection {
  id: string;
  name: string;
  appearance: { icon: string | null; color: string | null } | null;
}

export interface ThreadOrganization {
  projectId: string | null;
  sectionId: string | null;
  cwd: string | null;
}

export interface ProjectsSnapshot {
  available: boolean;
  unavailableReason: string | null;
  projects: CodexProject[];
  /** Null when the server does not expose sections. */
  sections: CodexThreadSection[] | null;
  /** Recent threads' assignments keyed by thread ID. */
  threads: Record<string, ThreadOrganization>;
}

const THREAD_PAGE_SIZE = 100;
const THREAD_MAX_PAGES = 3;
const CACHE_MS = 1_000;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function isProjectApiUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === -32601 ||
    /unknown variant|method not found|requires experimentalApi|not supported/i.test(
      message(error),
    )
  );
}

const optionalNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function parseProject(value: unknown): CodexProject {
  const record = nativeRecord(value);
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    !Array.isArray(record.roots)
  )
    throw new Error("Invalid project");
  return {
    id: record.id,
    name: record.name,
    roots: record.roots
      .map((root) =>
        root && typeof root === "object"
          ? (root as Record<string, unknown>).path
          : null,
      )
      .filter((path): path is string => typeof path === "string"),
    position: optionalNumber(record.position) ?? 0,
    createdAt: optionalNumber(record.createdAt) ?? 0,
    updatedAt: optionalNumber(record.updatedAt) ?? 0,
    recencyAt: optionalNumber(record.recencyAt),
  };
}

export function parseSection(value: unknown): CodexThreadSection {
  const record = nativeRecord(value);
  if (typeof record.id !== "string" || typeof record.name !== "string")
    throw new Error("Invalid thread section");
  const appearance =
    record.appearance && typeof record.appearance === "object"
      ? (record.appearance as Record<string, unknown>)
      : null;
  return {
    id: record.id,
    name: record.name,
    appearance: appearance
      ? {
          icon: typeof appearance.icon === "string" ? appearance.icon : null,
          color: typeof appearance.color === "string" ? appearance.color : null,
        }
      : null,
  };
}

const roots = (paths: string[]) => paths.map((path) => ({ path }));

export class ProjectService {
  private cache: { at: number; snapshot: ProjectsSnapshot } | null = null;
  private inFlight: Promise<ProjectsSnapshot> | null = null;
  private generation = 0;

  public constructor(
    private readonly rpc: NativeRpc,
    private readonly notify: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  public snapshot(): Promise<ProjectsSnapshot> {
    if (this.cache && this.now() - this.cache.at < CACHE_MS)
      return Promise.resolve(this.cache.snapshot);
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const load = this.load()
      .then((snapshot) => {
        if (generation === this.generation)
          this.cache = { at: this.now(), snapshot };
        return snapshot;
      })
      .finally(() => {
        if (this.inFlight === load) this.inFlight = null;
      });
    this.inFlight = load;
    return load;
  }

  private async load(): Promise<ProjectsSnapshot> {
    let projects: CodexProject[];
    try {
      projects = (await nativePages<unknown>(this.rpc, "project/list", {})).map(
        parseProject,
      );
    } catch (error) {
      if (!isProjectApiUnsupported(error)) throw error;
      return {
        available: false,
        unavailableReason: message(error),
        projects: [],
        sections: null,
        threads: {},
      };
    }
    projects.sort((a, b) => a.position - b.position);
    let sections: CodexThreadSection[] | null = null;
    try {
      sections = (
        await nativePages<unknown>(this.rpc, "threadSection/list", {})
      ).map(parseSection);
    } catch (error) {
      if (!isProjectApiUnsupported(error)) throw error;
    }
    return {
      available: true,
      unavailableReason: null,
      projects,
      sections,
      threads: await this.readThreads(),
    };
  }

  private async readThreads(): Promise<Record<string, ThreadOrganization>> {
    const threads: Record<string, ThreadOrganization> = {};
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < THREAD_MAX_PAGES; page++) {
      const result = nativeRecord(
        await this.rpc("thread/list", {
          limit: THREAD_PAGE_SIZE,
          sortKey: "updated_at",
          useStateDbOnly: true,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (!Array.isArray(result.data)) break;
      for (const entry of result.data) {
        if (!entry || typeof entry !== "object") continue;
        const thread = entry as Record<string, unknown>;
        if (typeof thread.id !== "string") continue;
        const section =
          thread.section && typeof thread.section === "object"
            ? (thread.section as Record<string, unknown>)
            : null;
        threads[thread.id] = {
          projectId:
            typeof thread.projectId === "string" && thread.projectId
              ? thread.projectId
              : null,
          sectionId: typeof section?.id === "string" ? section.id : null,
          cwd: typeof thread.cwd === "string" ? thread.cwd : null,
        };
      }
      const next = result.nextCursor;
      if (typeof next !== "string" || !next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return threads;
  }

  private changed() {
    this.generation += 1;
    this.cache = null;
    this.inFlight = null;
    this.notify();
  }

  private async mutate<T>(work: () => Promise<T>): Promise<T> {
    const result = await work();
    this.changed();
    return result;
  }

  public createProject(input: {
    name: string;
    roots: string[];
    idempotencyKey: string;
    threadIds?: string[] | null;
  }): Promise<CodexProject> {
    return this.mutate(async () =>
      parseProject(
        nativeRecord(
          await this.rpc(
            input.threadIds?.length ? "project/import" : "project/create",
            {
              name: input.name,
              roots: roots(input.roots),
              idempotencyKey: input.idempotencyKey,
              ...(input.threadIds?.length ? { threads: input.threadIds } : {}),
            },
          ),
        ).project,
      ),
    );
  }

  public updateProject(
    projectId: string,
    patch: { name?: string | null; roots?: string[] | null },
  ): Promise<CodexProject> {
    return this.mutate(async () =>
      parseProject(
        nativeRecord(
          await this.rpc("project/update", {
            projectId,
            ...(patch.name ? { name: patch.name } : {}),
            ...(patch.roots ? { roots: roots(patch.roots) } : {}),
          }),
        ).project,
      ),
    );
  }

  public moveProject(
    projectId: string,
    beforeProjectId: string | null,
  ): Promise<void> {
    return this.mutate(async () => {
      await this.rpc("project/move", { projectId, beforeProjectId });
    });
  }

  public deleteProject(projectId: string): Promise<void> {
    return this.mutate(async () => {
      await this.rpc("project/delete", { projectId });
    });
  }

  public assignThread(
    threadId: string,
    projectId: string | null,
  ): Promise<void> {
    return this.mutate(async () => {
      // An empty string clears the assignment upstream.
      await this.rpc("thread/metadata/update", {
        threadId,
        projectId: projectId ?? "",
      });
    });
  }

  public createSection(name: string): Promise<CodexThreadSection> {
    return this.mutate(async () =>
      parseSection(
        nativeRecord(await this.rpc("threadSection/create", { name })).section,
      ),
    );
  }

  public renameSection(
    sectionId: string,
    name: string,
  ): Promise<CodexThreadSection> {
    // Omitting appearance preserves it.
    return this.mutate(async () =>
      parseSection(
        nativeRecord(
          await this.rpc("threadSection/update", { sectionId, name }),
        ).section,
      ),
    );
  }

  public deleteSection(sectionId: string): Promise<void> {
    return this.mutate(async () => {
      await this.rpc("threadSection/delete", { sectionId });
    });
  }

  public moveThreadToSection(
    threadId: string,
    sectionId: string | null,
  ): Promise<void> {
    return this.mutate(async () => {
      await this.rpc("thread/section/move", { threadId, sectionId });
    });
  }

  public handleNotification(method: string): boolean {
    if (method !== "project/changed" && method !== "thread/project/updated")
      return false;
    this.changed();
    return true;
  }
}

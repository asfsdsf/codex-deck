import { Hono } from "hono";
import type { DeckPluginStore } from "./deck-plugin-store";
import {
  DeckPluginServices,
  type DeckPluginServiceHandler,
} from "./deck-plugin-services";

export interface DeckBuiltinContext {
  /** Routes are mounted only while this plugin is enabled and ready. */
  routes: Hono;
  signal: AbortSignal;
  services: {
    provide(name: string, handler: DeckPluginServiceHandler): void;
    call(name: string, method: string, params: unknown): Promise<unknown>;
    list(): Array<{ name: string; pluginId: string }>;
  };
  effect(dispose: () => void | Promise<void>): void;
  onEvent(listener: (event: unknown) => void): void;
}
export interface DeckBuiltinModule {
  id: string;
  apply(context: DeckBuiltinContext): void | Promise<void>;
}
type Instance = {
  routes: Hono;
  abort: AbortController;
  dispose: Array<() => void | Promise<void>>;
  events: Set<(event: unknown) => void>;
};

/** Dynamic composition over stable dispatch routes; no Hono routes accumulate on reload. */
export class DeckBuiltinRuntime {
  private instances = new Map<string, Instance>();
  private pending: Promise<unknown> = Promise.resolve();
  private errors = new Map<string, string>();
  private closed = false;
  private serviceRevision = 0;
  private lastStoreRevision = -1;
  private lastServiceRevision = -1;
  private unsubscribe: () => void;
  constructor(
    private store: DeckPluginStore,
    readonly services: DeckPluginServices,
    private modules: DeckBuiltinModule[],
  ) {
    this.unsubscribe = services.subscribe(() => {
      this.serviceRevision++;
      void this.reconcile().catch(() => {});
    });
  }

  reconcile(): Promise<void> {
    const work = this.pending
      .catch(() => {})
      .then(async () => {
        if (this.closed) return;
        if (
          this.lastStoreRevision === this.store.revision &&
          this.lastServiceRevision === this.serviceRevision
        )
          return;
        const storeRevision = this.store.revision;
        const serviceRevision = this.serviceRevision;
        const { plugins } = await this.store.list();
        for (const [id] of this.instances) {
          const plugin = plugins.find((p) => p.id === id);
          if (
            !plugin?.enabled ||
            plugin.requires?.some((s) => !this.services.has(s))
          )
            await this.unload(id);
        }
        for (const module of this.modules) {
          const plugin = plugins.find((p) => p.id === module.id && p.enabled);
          if (
            !plugin ||
            this.instances.has(module.id) ||
            plugin.requires?.some((s) => !this.services.has(s))
          )
            continue;
          const instance: Instance = {
            routes: new Hono(),
            abort: new AbortController(),
            dispose: [],
            events: new Set(),
          };
          this.instances.set(module.id, instance);
          try {
            await module.apply({
              routes: instance.routes,
              signal: instance.abort.signal,
              services: {
                provide: (name, handler) => {
                  if (
                    !plugin.capabilities.includes("services.provide") ||
                    !plugin.services?.provides?.includes(name)
                  )
                    throw new Error(
                      `Service ${name} is not declared in services.provides.`,
                    );
                  instance.dispose.push(
                    this.services.register(module.id, name, handler),
                  );
                },
                call: (name, method, params) =>
                  this.services.call(
                    plugin,
                    name,
                    method,
                    params,
                    instance.abort.signal,
                  ),
                list: () =>
                  this.services
                    .list()
                    .filter((entry) =>
                      plugin.services?.uses?.includes(entry.name),
                    ),
              },
              effect: (dispose) => {
                instance.dispose.push(dispose);
              },
              onEvent: (listener) => {
                instance.events.add(listener);
              },
            });
            // Bundled route providers use exactly the same JSON service call contract as workers.
            for (const name of plugin.services?.provides ?? []) {
              if (this.services.has(name)) continue;
              instance.dispose.push(
                this.services.register(
                  module.id,
                  name,
                  async (method, value, call) => {
                    if (method !== "request")
                      throw new Error(
                        "Unsupported service method. Use request.",
                      );
                    const params = value as {
                      path?: unknown;
                      method?: unknown;
                      body?: unknown;
                    } | null;
                    if (
                      !params ||
                      typeof params.path !== "string" ||
                      !params.path.startsWith("/api/") ||
                      params.path.includes("#")
                    )
                      throw new Error("An absolute API path is required.");
                    const url = new URL(params.path, "http://deck.internal");
                    if (
                      url.origin !== "http://deck.internal" ||
                      url.searchParams.has("codexHome")
                    )
                      throw new Error(
                        "Service requests are scoped to their original Codex home.",
                      );
                    const verb = params.method ?? "GET";
                    if (
                      typeof verb !== "string" ||
                      !["GET", "POST", "PUT", "DELETE"].includes(verb)
                    )
                      throw new Error("Unsupported request method.");
                    const response = await instance.routes.request(url.href, {
                      method: verb,
                      signal: call.signal,
                      ...(verb === "GET"
                        ? {}
                        : {
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(params.body ?? {}),
                          }),
                    });
                    return {
                      status: response.status,
                      body: await response.json(),
                    };
                  },
                ),
              );
            }
            this.errors.delete(module.id);
          } catch (error) {
            await this.unload(module.id);
            this.errors.set(
              module.id,
              error instanceof Error
                ? error.message
                : "Built-in plugin failed.",
            );
          }
        }
        this.lastStoreRevision = storeRevision;
        this.lastServiceRevision = serviceRevision;
      });
    this.pending = work;
    return work;
  }

  async unload(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) return;
    this.instances.delete(id); // Revoke access before asynchronous teardown.
    instance.abort.abort();
    this.services.unload(id);
    for (const dispose of instance.dispose.reverse())
      await Promise.resolve()
        .then(dispose)
        .catch(() => {});
    instance.events.clear();
  }

  event(event: unknown): void {
    for (const instance of this.instances.values())
      for (const listener of instance.events) {
        try {
          listener(event);
        } catch {
          /* Isolate feature listeners. */
        }
      }
  }

  error(id: string): string | undefined {
    return this.errors.get(id);
  }

  async fetch(request: Request): Promise<Response | null> {
    await this.reconcile();
    const url = new URL(request.url);
    for (const instance of this.instances.values()) {
      const match = instance.routes.routes.some(
        (route) =>
          (route.method === request.method ||
            (request.method === "HEAD" && route.method === "GET") ||
            route.method === "ALL") &&
          new RegExp(
            `^${route.path
              .split("/")
              .map((part) =>
                part.startsWith(":")
                  ? "[^/]+"
                  : part === "*"
                    ? ".*"
                    : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              )
              .join("/")}$`,
          ).test(url.pathname),
      );
      if (match) return instance.routes.fetch(request);
    }
    return null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    await this.pending.catch(() => {});
    for (const id of [...this.instances.keys()]) await this.unload(id);
  }
}

import type { DeckPluginManifest } from "./deck-plugin-manifest";

export interface DeckPluginServiceCall {
  caller: string;
  signal: AbortSignal;
}
export type DeckPluginServiceHandler = (
  method: string,
  params: unknown,
  call: DeckPluginServiceCall,
) => unknown | Promise<unknown>;

type Provider = {
  owner: string;
  handler: DeckPluginServiceHandler;
  abort: AbortController;
  calls: Set<AbortController>;
};

const MAX_SERVICE_BYTES = 1024 * 1024;

function assertJsonBounded(value: unknown): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    /* report below */
  }
  if (json === undefined || Buffer.byteLength(json, "utf8") > MAX_SERVICE_BYTES)
    throw new Error(
      "Plugin service JSON must be serializable and at most 1 MiB.",
    );
}

/** Home-local, transport-independent services. Registrations have one owner. */
export class DeckPluginServices {
  private providers = new Map<string, Provider>();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  register(
    owner: string,
    name: string,
    handler: DeckPluginServiceHandler,
  ): () => void {
    if (name !== owner && !name.startsWith(`${owner}.`))
      throw new Error("A service must use its provider's plugin ID namespace.");
    if (this.providers.has(name))
      throw new Error(`Service ${name} is already registered.`);
    const provider = {
      owner,
      handler,
      abort: new AbortController(),
      calls: new Set<AbortController>(),
    };
    this.providers.set(name, provider);
    this.changed();
    return () => {
      if (this.providers.get(name) !== provider) return;
      this.providers.delete(name);
      provider.abort.abort(new Error(`Service ${name} was unloaded.`));
      for (const call of provider.calls)
        call.abort(provider.abort.signal.reason);
      provider.calls.clear();
      this.changed();
    };
  }

  unload(owner: string): void {
    let changed = false;
    for (const [name, provider] of this.providers) {
      if (provider.owner !== owner) continue;
      this.providers.delete(name);
      changed = true;
      provider.abort.abort(new Error(`Service ${name} was unloaded.`));
      for (const call of provider.calls)
        call.abort(provider.abort.signal.reason);
      provider.calls.clear();
    }
    if (changed) this.changed();
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): Array<{ name: string; pluginId: string }> {
    return [...this.providers]
      .map(([name, p]) => ({ name, pluginId: p.owner }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async call(
    manifest: Pick<DeckPluginManifest, "id" | "capabilities" | "services">,
    name: string,
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!manifest.capabilities.includes("services.call"))
      throw new Error("services.call is not granted.");
    if (
      !manifest.services?.uses?.includes(name) &&
      !manifest.services?.provides?.includes(name)
    )
      throw new Error(`Service ${name} is not declared in services.uses.`);
    if (typeof method !== "string" || !method.trim() || method.length > 128)
      throw new Error(
        "A service method of at most 128 characters is required.",
      );
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Service ${name} is unavailable.`);
    assertJsonBounded(params);
    const call = new AbortController();
    provider.calls.add(call);
    const combined = AbortSignal.any([
      provider.abort.signal,
      call.signal,
      AbortSignal.timeout(120_000),
      ...(signal ? [signal] : []),
    ]);
    combined.throwIfAborted();
    let abort: () => void = () => {};
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          combined.throwIfAborted();
          return provider.handler(method, params, {
            caller: manifest.id,
            signal: combined,
          });
        }),
        new Promise<never>((_, reject) => {
          abort = () => reject(combined.reason);
          combined.addEventListener("abort", abort, { once: true });
        }),
      ]);
      assertJsonBounded(result);
      return result;
    } finally {
      combined.removeEventListener("abort", abort);
      provider.calls.delete(call);
    }
  }
}

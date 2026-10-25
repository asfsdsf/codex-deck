export type NativeScope = "mcp";
export type NativeRpc = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;
export interface McpServerInventory {
  name: string;
  runtimeStatus: string | null;
  authStatus: string;
  tools: Record<
    string,
    { name?: string; description?: string; inputSchema?: unknown }
  >;
  toolsError?: string | null;
  resources: unknown[];
  resourceTemplates: unknown[];
}
export interface McpRuntimeUpdate {
  name: string;
  threadId: string | null;
  status?: string;
  success?: boolean;
  error?: string | null;
  loginId?: string | null;
}
export interface McpInventorySnapshot {
  servers: McpServerInventory[];
  updates: McpRuntimeUpdate[];
}
export function nativeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid app-server response");
  return value as Record<string, unknown>;
}
export async function nativePages<T>(
  rpc: NativeRpc,
  method: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  const entries: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result = nativeRecord(
      await rpc(method, { ...params, cursor, limit: 100 }),
    );
    if (!Array.isArray(result.data))
      throw new Error(`Invalid ${method} inventory`);
    entries.push(...(result.data as T[]));
    if (result.nextCursor == null) return entries;
    if (typeof result.nextCursor !== "string" || seen.has(result.nextCursor))
      throw new Error(`Invalid or repeated ${method} cursor`);
    cursor = result.nextCursor;
    seen.add(cursor);
  }
  throw new Error(`${method} pagination limit exceeded`);
}

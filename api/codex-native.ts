export type NativeScope = "mcp" | "usage";
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

export interface UsageWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
export interface UsageLimit {
  limitName?: string | null;
  limitId?: string | null;
  primary?: UsageWindow | null;
  secondary?: UsageWindow | null;
  credits?: {
    unlimited: boolean;
    hasCredits: boolean;
    balance: string | null;
  } | null;
  rateLimitReachedType?: string | null;
}
export interface ResetCredit {
  id: string;
  title: string | null;
  description: string | null;
  status: string;
  resetType: string;
  grantedAt: number;
  expiresAt: number | null;
}
export interface UsageRates {
  rateLimits: UsageLimit;
  rateLimitsByLimitId?: Record<string, UsageLimit> | null;
  ordinaryUsageAllowed?: boolean | null;
  rateLimitResetCredits?: {
    availableCount: number;
    credits: ResetCredit[] | null;
  } | null;
}
export interface UsageActivity {
  summary: {
    lifetimeTokens: number | null;
    peakDailyTokens: number | null;
    longestRunningTurnSec: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
  };
  dailyUsageBuckets?: { startDate: string; tokens: number }[] | null;
}
export interface ThreadUsageEstimate {
  threadId: string;
  estimatedUsageCreditsMicros: number;
  estimatedUsageUsdMicros: number | null;
  groups: {
    model: string | null;
    reasoningEffort: string | null;
    speed: string | null;
    estimatedUsageCreditsMicros: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  }[];
}
export interface UsageDashboardSnapshot {
  rates: UsageRates | null;
  activity: UsageActivity | null;
  thread: ThreadUsageEstimate | null;
  errors: string[];
}
export async function readUsageDashboard(
  rpc: NativeRpc,
  threadId?: string | null,
): Promise<UsageDashboardSnapshot> {
  const results = await Promise.allSettled([
    rpc("account/rateLimits/read", {}),
    rpc("account/usage/read", {}),
    threadId ? rpc("account/usage/read", { threadId }) : Promise.resolve(null),
  ]);
  const errors: string[] = [];
  const values = results.map((result, index) => {
    if (result.status === "rejected") {
      errors.push(
        `${["Rate limits", "Usage history", "Conversation estimate"][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
      return null;
    }
    return result.value;
  });
  return {
    rates: values[0] as UsageRates | null,
    activity: values[1] as UsageActivity | null,
    thread: values[2]
      ? ((nativeRecord(values[2]).threadUsage as ThreadUsageEstimate | null) ??
        null)
      : null,
    errors,
  };
}

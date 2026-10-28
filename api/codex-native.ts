export type NativeScope =
  | "mcp"
  | "usage"
  | "recap"
  | "experimental"
  | "daybreak"
  | "diagnostics"
  | "queue"
  | "presets"
  | "account"
  | "import"
  | "apps"
  | "plugins"
  | "permissions"
  | "guardian"
  | "worktrees"
  | "voice";
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

export interface ExperimentalFeature {
  name: string;
  stage: string;
  displayName: string | null;
  description: string | null;
  announcement: string | null;
  enabled: boolean;
  defaultEnabled: boolean;
}
export interface ExperimentalWriteResult {
  features: ExperimentalFeature[];
  warning: string | null;
}
export async function readExperimentalFeatures(
  rpc: NativeRpc,
  threadId?: string | null,
): Promise<ExperimentalFeature[]> {
  const entries = await nativePages<ExperimentalFeature>(
    rpc,
    "experimentalFeature/list",
    threadId ? { threadId } : {},
  );
  if (
    entries.some(
      (feature) =>
        typeof feature?.name !== "string" ||
        typeof feature.enabled !== "boolean" ||
        typeof feature.stage !== "string",
    )
  )
    throw new Error("Invalid experimental feature catalog");
  return [
    ...new Map(entries.map((feature) => [feature.name, feature])).values(),
  ];
}
export async function writeExperimentalFeatures(
  rpc: NativeRpc,
  threadId: string | null,
  updates: Record<string, boolean>,
  changed: () => void,
): Promise<ExperimentalWriteResult> {
  const features = await readExperimentalFeatures(rpc, threadId);
  const edits = Object.entries(updates).map(([name, enabled]) => {
    const feature = features.find((entry) => entry.name === name);
    if (
      !feature ||
      ["removed", "deprecated"].includes(feature.stage) ||
      typeof enabled !== "boolean"
    )
      throw new Error(`The server does not support changing feature ${name}`);
    return {
      keyPath: `features.${JSON.stringify(name)}`,
      value:
        enabled || feature.defaultEnabled || name === "daemon_auto_start"
          ? enabled
          : null,
      mergeStrategy: "replace",
    };
  });
  if (!edits.length) return { features, warning: null };
  const response = nativeRecord(
    await rpc("config/batchWrite", { edits, reloadUserConfig: true }),
  );
  changed();
  const readback = await readExperimentalFeatures(rpc, threadId);
  const overridden =
    response.status === "okOverridden" ||
    Object.entries(updates).some(
      ([name, enabled]) =>
        !readback.some(
          (feature) => feature.name === name && feature.enabled === enabled,
        ),
    );
  return {
    features: readback,
    warning: overridden
      ? "Settings were saved, but higher-priority configuration overrides one or more selections."
      : null,
  };
}

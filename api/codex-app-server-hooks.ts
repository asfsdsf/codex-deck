import type {
  CodexHookEventName,
  CodexHookHandlerType,
  CodexHookMetadata,
  CodexHookSource,
  CodexHookTrustStatus,
} from "./storage";
import type { CodexHooksListInput } from "./codex-app-server";

interface CodexHooksListEntry {
  cwd: string;
  hooks: CodexHookMetadata[];
  warnings: string[];
  errors: Array<{ path: string; message: string }>;
}

interface CodexHookStateUpdate {
  key: string;
  enabled?: boolean;
  trustedHash?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asTrimmedString(value: unknown): string | null {
  const normalized = asString(value)?.trim();
  return normalized ? normalized : null;
}

function asNullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return asString(value);
}

function asNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "bigint" && value >= 0n) {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

export function toHookTrustStatus(
  value: unknown,
): CodexHookTrustStatus | null {
  switch (value) {
    case "managed":
    case "untrusted":
    case "trusted":
    case "modified":
      return value;
    default:
      return null;
  }
}

export function toHookSource(value: unknown): CodexHookSource | null {
  switch (value) {
    case "system":
    case "user":
    case "project":
    case "mdm":
    case "sessionFlags":
    case "plugin":
    case "cloudRequirements":
    case "cloudManagedConfig":
    case "legacyManagedConfigFile":
    case "legacyManagedConfigMdm":
    case "unknown":
      return value;
    default:
      return null;
  }
}

export function toHookEventName(
  value: unknown,
): CodexHookEventName | null {
  switch (value) {
    case "preToolUse":
    case "permissionRequest":
    case "postToolUse":
    case "preCompact":
    case "postCompact":
    case "sessionStart":
    case "userPromptSubmit":
    case "subagentStart":
    case "subagentStop":
    case "stop":
      return value;
    default:
      return null;
  }
}

export function toHookHandlerType(
  value: unknown,
): CodexHookHandlerType | null {
  switch (value) {
    case "command":
    case "prompt":
    case "agent":
      return value;
    default:
      return null;
  }
}

export function parseHooksListResult(
  data: unknown,
  cwd: string,
): CodexHooksListEntry[] {
  if (!Array.isArray(data)) {
    return [];
  }

  const entries: CodexHooksListEntry[] = [];
  for (const entryValue of data) {
    const entryRecord = asRecord(entryValue);
    if (!entryRecord) {
      continue;
    }

    const hooks: CodexHookMetadata[] = [];
    const hookValues = Array.isArray(entryRecord.hooks) ? entryRecord.hooks : [];
    for (const hookValue of hookValues) {
      const hookRecord = asRecord(hookValue);
      if (!hookRecord) {
        continue;
      }

      const key = asTrimmedString(hookRecord.key);
      const eventName = toHookEventName(
        hookRecord.eventName ?? hookRecord.event_name,
      );
      const handlerType = toHookHandlerType(
        hookRecord.handlerType ?? hookRecord.handler_type,
      );
      const sourcePath = asTrimmedString(
        hookRecord.sourcePath ?? hookRecord.source_path,
      );
      const source = toHookSource(hookRecord.source);
      const currentHash = asTrimmedString(
        hookRecord.currentHash ?? hookRecord.current_hash,
      );
      const trustStatus = toHookTrustStatus(
        hookRecord.trustStatus ?? hookRecord.trust_status,
      );

      if (
        !key ||
        !eventName ||
        !handlerType ||
        !sourcePath ||
        !source ||
        !currentHash ||
        !trustStatus
      ) {
        continue;
      }

      hooks.push({
        key,
        eventName,
        handlerType,
        matcher: asNullableString(hookRecord.matcher),
        command: asNullableString(hookRecord.command),
        timeoutSec:
          asNonNegativeNumber(hookRecord.timeoutSec ?? hookRecord.timeout_sec) ??
          0,
        statusMessage: asNullableString(
          hookRecord.statusMessage ?? hookRecord.status_message,
        ),
        sourcePath,
        source,
        pluginId: asNullableString(hookRecord.pluginId ?? hookRecord.plugin_id),
        displayOrder:
          asNonNegativeNumber(
            hookRecord.displayOrder ?? hookRecord.display_order,
          ) ?? 0,
        enabled: hookRecord.enabled !== false,
        isManaged: hookRecord.isManaged === true,
        currentHash,
        trustStatus,
      });
    }

    const warnings = Array.isArray(entryRecord.warnings)
      ? entryRecord.warnings
          .map((value) => asTrimmedString(value))
          .filter((value): value is string => Boolean(value))
      : [];

    const errors =
      Array.isArray(entryRecord.errors) && entryRecord.errors.length > 0
        ? entryRecord.errors
            .map((errorValue) => {
              const errorRecord = asRecord(errorValue);
              if (!errorRecord) {
                return null;
              }
              const path = asTrimmedString(errorRecord.path);
              const message = asTrimmedString(errorRecord.message);
              if (!path || !message) {
                return null;
              }
              return { path, message };
            })
            .filter(
              (
                error,
              ): error is NonNullable<CodexHooksListEntry["errors"][number]> =>
                error !== null,
            )
        : [];

    entries.push({
      cwd: asTrimmedString(entryRecord.cwd) ?? cwd,
      hooks,
      warnings,
      errors,
    });
  }

  return entries;
}

export function buildHookStateBatchWriteInput(
  updates: CodexHookStateUpdate[],
): Record<string, unknown> {
  const normalizedUpdates = updates
    .map((update) => {
      const key = update.key.trim();
      if (!key) {
        return null;
      }

      const entry: Record<string, unknown> = {};
      if (typeof update.enabled === "boolean") {
        entry.enabled = update.enabled;
      }

      const trustedHash =
        typeof update.trustedHash === "string" ? update.trustedHash.trim() : "";
      if (trustedHash) {
        entry.trusted_hash = trustedHash;
      }

      if (Object.keys(entry).length === 0) {
        return null;
      }

      return [key, entry] as const;
    })
    .filter(
      (
        update,
      ): update is readonly [string, Record<string, unknown>] => update !== null,
    );

  if (normalizedUpdates.length === 0) {
    throw new Error("at least one hook update is required");
  }

  return {
    edits: [
      {
        keyPath: "hooks.state",
        value: Object.fromEntries(normalizedUpdates),
        mergeStrategy: "upsert",
      },
    ],
    reloadUserConfig: true,
  };
}

export type { CodexHooksListInput };

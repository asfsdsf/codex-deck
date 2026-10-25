import { nativeRecord, type NativeRpc } from "./codex-native";
import type { CodexOperationalNotification } from "./operational-notifications";

export interface ConfigDiagnosticLayer {
  name: Record<string, unknown>;
  version: string;
  config: unknown;
  disabledReason?: string;
}
export interface ConfigDiagnostics {
  cwd: string | null;
  config: Record<string, unknown> | null;
  origins: Record<string, unknown>;
  layers: ConfigDiagnosticLayer[] | null;
  requirements: Record<string, unknown> | null;
  requirementSources: unknown;
  supportsIndependentSpeedModes: boolean | null;
  errors: string[];
}
const REDACTED = "[redacted]";
const secretKey =
  /api[-_]?key|token|password|passwd|secret|authorization|credential|private[-_]?key|client[-_]?cert/i;
const valueMapKey =
  /^(env|environment|environmentVariables|environment_variables|headers|http_headers|httpHeaders|env_http_headers|envHttpHeaders)$/i;

/** Diagnostics cross the browser boundary; never send credential/config env values. */
export function redactDiagnostics(
  value: unknown,
  key = "",
  depth = 0,
): unknown {
  if (depth > 30) return "[depth limit]";
  if (secretKey.test(key)) return REDACTED;
  if (valueMapKey.test(key) && value && typeof value === "object") {
    if (Array.isArray(value)) return value.map(() => REDACTED);
    return Object.fromEntries(
      Object.keys(value).map((name) => [name, REDACTED]),
    );
  }
  if (typeof value === "string") {
    return value
      .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, (match) => {
        try {
          const url = new URL(match);
          if (url.username) url.username = REDACTED;
          if (url.password) url.password = REDACTED;
          // Query and fragment values can carry authentication under arbitrary names.
          for (const name of new Set(url.searchParams.keys()))
            url.searchParams.set(name, REDACTED);
          if (url.hash) url.hash = REDACTED;
          return url.toString();
        } catch {
          return "[redacted URL]";
        }
      })
      .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [redacted]")
      .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, REDACTED)
      .replace(
        /((?:api[-_]?key|access[-_]?token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi,
        "$1[redacted]",
      );
  }
  if (Array.isArray(value))
    return value.map((entry) => redactDiagnostics(entry, "", depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        redactDiagnostics(entry, name, depth + 1),
      ]),
    );
  return value;
}

export function retainedWarnings(
  notices: CodexOperationalNotification[],
): CodexOperationalNotification[] {
  return notices
    .filter((notice) =>
      ["warning", "configWarning", "deprecationNotice"].includes(notice.method),
    )
    .map((notice) => ({
      ...notice,
      summary: redactDiagnostics(notice.summary) as string,
      details: redactDiagnostics(notice.details) as Record<string, unknown>,
    }));
}

export async function readConfigDiagnostics(
  rpc: NativeRpc,
  threadId?: string | null,
): Promise<ConfigDiagnostics> {
  const snapshot: ConfigDiagnostics = {
    cwd: null,
    config: null,
    origins: {},
    layers: null,
    requirements: null,
    requirementSources: null,
    supportsIndependentSpeedModes: null,
    errors: [],
  };
  const error = (label: string, reason: unknown) =>
    snapshot.errors.push(
      `${label}: ${redactDiagnostics(reason instanceof Error ? reason.message : String(reason))}`,
    );
  if (threadId) {
    try {
      const thread = nativeRecord(
        nativeRecord(
          await rpc("thread/read", { threadId, includeTurns: false }),
        ).thread,
      );
      snapshot.cwd = typeof thread.cwd === "string" ? thread.cwd : null;
      if (!snapshot.cwd)
        snapshot.errors.push(
          "The conversation working directory was not reported; showing host defaults.",
        );
    } catch (reason) {
      error("Conversation scope unavailable; showing host defaults", reason);
    }
  }
  await Promise.all([
    (async () => {
      try {
        const result = nativeRecord(
          await rpc("config/read", {
            includeLayers: true,
            ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
          }),
        );
        snapshot.config = redactDiagnostics(
          nativeRecord(result.config),
        ) as Record<string, unknown>;
        if (result.origins != null)
          snapshot.origins = redactDiagnostics(
            nativeRecord(result.origins),
          ) as Record<string, unknown>;
        if (result.layers != null) {
          if (!Array.isArray(result.layers))
            throw new Error("Invalid configuration layer stack");
          snapshot.layers = result.layers.map((raw) => {
            const layer = nativeRecord(raw);
            return {
              name: redactDiagnostics(nativeRecord(layer.name)) as Record<
                string,
                unknown
              >,
              version:
                typeof layer.version === "string"
                  ? layer.version
                  : "Not reported",
              config: redactDiagnostics(layer.config),
              ...(typeof layer.disabledReason === "string"
                ? {
                    disabledReason: redactDiagnostics(
                      layer.disabledReason,
                    ) as string,
                  }
                : {}),
            };
          });
        }
      } catch (reason) {
        error("Configuration unavailable", reason);
      }
    })(),
    (async () => {
      try {
        const result = nativeRecord(await rpc("configRequirements/read", {}));
        if (!("requirements" in result))
          throw new Error(
            "Requirements were not reported by the connected server",
          );
        snapshot.requirements =
          result.requirements == null
            ? null
            : (redactDiagnostics(nativeRecord(result.requirements)) as Record<
                string,
                unknown
              >);
        snapshot.requirementSources = redactDiagnostics(
          result.sources ?? result.origins ?? result.provenance ?? null,
        );
        snapshot.supportsIndependentSpeedModes =
          typeof result.supportsIndependentSpeedModes === "boolean"
            ? result.supportsIndependentSpeedModes
            : null;
      } catch (reason) {
        error("Requirements unavailable", reason);
      }
    })(),
  ]);
  return snapshot;
}

export const SESSION_STATUS_STORAGE_KEY = "codex-deck:session-status:v1";

export type SessionStatus = "completed" | "running" | "unreviewed";

export interface TrackedSessionStatus {
  status: "running" | "unreviewed";
  turnId: string | null;
}

export type TrackedSessionStatusMap = Record<string, TrackedSessionStatus>;

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function readTrackedSessionStatuses(
  storage?: ReadableStorage | null,
): TrackedSessionStatusMap {
  const targetStorage =
    storage ?? (typeof window === "undefined" ? null : window.localStorage);
  if (!targetStorage) {
    return {};
  }

  try {
    const raw = targetStorage.getItem(SESSION_STATUS_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const result: TrackedSessionStatusMap = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      const normalizedSessionId = sessionId.trim();
      if (
        !normalizedSessionId ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        continue;
      }

      const candidate = value as Record<string, unknown>;
      if (candidate.status !== "running" && candidate.status !== "unreviewed") {
        continue;
      }

      result[normalizedSessionId] = {
        status: candidate.status,
        turnId:
          typeof candidate.turnId === "string" && candidate.turnId.trim()
            ? candidate.turnId.trim()
            : null,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function persistTrackedSessionStatuses(
  value: TrackedSessionStatusMap,
  storage?: WritableStorage | null,
): void {
  const targetStorage =
    storage ?? (typeof window === "undefined" ? null : window.localStorage);
  if (!targetStorage) {
    return;
  }

  try {
    targetStorage.setItem(SESSION_STATUS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage write errors (private mode, quota, etc.).
  }
}

export function getSessionStatus(
  statuses: TrackedSessionStatusMap,
  sessionId: string,
): SessionStatus {
  return statuses[sessionId]?.status ?? "completed";
}

export function trackSessionRunning(
  statuses: TrackedSessionStatusMap,
  sessionId: string,
  turnId?: string | null,
): TrackedSessionStatusMap {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return statuses;
  }
  const normalizedTurnId =
    typeof turnId === "string" && turnId.trim() ? turnId.trim() : null;
  const current = statuses[normalizedSessionId];
  if (current?.status === "running" && current.turnId === normalizedTurnId) {
    return statuses;
  }
  return {
    ...statuses,
    [normalizedSessionId]: {
      status: "running",
      turnId: normalizedTurnId,
    },
  };
}

export function settleTrackedSession(
  statuses: TrackedSessionStatusMap,
  sessionId: string,
  reviewed: boolean,
): TrackedSessionStatusMap {
  const normalizedSessionId = sessionId.trim();
  const current = statuses[normalizedSessionId];
  if (!normalizedSessionId || current?.status !== "running") {
    return statuses;
  }

  if (reviewed) {
    const next = { ...statuses };
    delete next[normalizedSessionId];
    return next;
  }

  return {
    ...statuses,
    [normalizedSessionId]: {
      status: "unreviewed",
      turnId: current.turnId,
    },
  };
}

export function markTrackedSessionReviewed(
  statuses: TrackedSessionStatusMap,
  sessionId: string,
): TrackedSessionStatusMap {
  const normalizedSessionId = sessionId.trim();
  if (
    !normalizedSessionId ||
    statuses[normalizedSessionId]?.status !== "unreviewed"
  ) {
    return statuses;
  }
  const next = { ...statuses };
  delete next[normalizedSessionId];
  return next;
}

export function removeTrackedSessionStatus(
  statuses: TrackedSessionStatusMap,
  sessionId: string,
): TrackedSessionStatusMap {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId || !(normalizedSessionId in statuses)) {
    return statuses;
  }
  const next = { ...statuses };
  delete next[normalizedSessionId];
  return next;
}

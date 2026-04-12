import type { CodexThreadStateResponse } from "@codex-deck/api";

export interface WaitStatePendingTurn {
  sessionId: string;
  turnId: string | null;
}

export function reconcilePendingTurnWithThreadState(
  current: WaitStatePendingTurn | null,
  sessionId: string,
  requestedTurnId: string | null | undefined,
  state: CodexThreadStateResponse,
): WaitStatePendingTurn | null {
  const normalizedRequestedTurnId =
    typeof requestedTurnId === "string" && requestedTurnId.trim().length > 0
      ? requestedTurnId.trim()
      : null;
  const requestedTurnReachedTerminalState =
    normalizedRequestedTurnId !== null &&
    state.requestedTurnId === normalizedRequestedTurnId &&
    state.requestedTurnStatus !== null &&
    state.requestedTurnStatus !== "inProgress";

  const trackedTurnDone =
    requestedTurnReachedTerminalState &&
    current?.sessionId === sessionId &&
    current.turnId === normalizedRequestedTurnId;

  if (state.isGenerating) {
    const nextTurnId =
      state.activeTurnId ??
      state.requestedTurnId ??
      (!trackedTurnDone && current?.sessionId === sessionId
        ? current.turnId
        : null) ??
      null;

    if (
      !trackedTurnDone &&
      current &&
      current.sessionId === sessionId &&
      current.turnId === nextTurnId
    ) {
      return current;
    }

    return {
      sessionId,
      turnId: nextTurnId,
    };
  }

  return current?.sessionId === sessionId ? null : current;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) {
    return "Just now";
  }
  if (diffMins < 60) {
    return `${diffMins}m`;
  }
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  if (diffDays < 7) {
    return `${diffDays}d`;
  }
  return date.toLocaleDateString();
}

function padTimestampSegment(value: number, length: number = 2): string {
  return String(value).padStart(length, "0");
}

function getUtcOffsetLabel(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) {
    return "UTC";
  }

  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${padTimestampSegment(hours)}:${padTimestampSegment(minutes)}`;
}

function getLocalTimeZoneAbbreviation(date: Date): string {
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      timeZoneName: "short",
    });
    const abbreviation = formatter
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")
      ?.value.trim();
    if (abbreviation && abbreviation.length > 0) {
      return abbreviation;
    }
  } catch {
    // Fall back to a deterministic offset label when platform Intl data is unavailable.
  }

  return getUtcOffsetLabel(date);
}

export function formatLocalTimestamp(
  timestamp: string | null | undefined,
): string | null {
  if (!timestamp) {
    return null;
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return `${parsed.getFullYear()}-${padTimestampSegment(parsed.getMonth() + 1)}-${padTimestampSegment(parsed.getDate())} ${padTimestampSegment(parsed.getHours())}:${padTimestampSegment(parsed.getMinutes())}:${padTimestampSegment(parsed.getSeconds())} ${getLocalTimeZoneAbbreviation(parsed)}`;
}

export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0ms";
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }

  if (durationMs < 60_000) {
    const seconds = durationMs / 1000;
    const text =
      seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString();
    return `${text.replace(/\.0$/, "")}s`;
  }

  if (durationMs < 3_600_000) {
    const minutes = Math.floor(durationMs / 60_000);
    const seconds = Math.floor((durationMs % 60_000) / 1000);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(durationMs / 3_600_000);
  const minutes = Math.floor((durationMs % 3_600_000) / 60_000);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function formatDurationFromTimestamps(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string | null {
  if (!startedAt || !endedAt) {
    return null;
  }

  const startedAtMs = new Date(startedAt).getTime();
  const endedAtMs = new Date(endedAt).getTime();
  if (Number.isNaN(startedAtMs) || Number.isNaN(endedAtMs)) {
    return null;
  }

  const durationMs = endedAtMs - startedAtMs;
  if (durationMs < 0) {
    return null;
  }

  return formatDurationMs(durationMs);
}

export function getTotalPages(totalItems: number, pageSize: number): number {
  if (totalItems <= 0 || pageSize <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

export function clampPage(page: number, totalPages: number): number {
  if (totalPages <= 1) {
    return 1;
  }
  if (page < 1) {
    return 1;
  }
  if (page > totalPages) {
    return totalPages;
  }
  return page;
}

export function getPageSliceBounds(
  page: number,
  pageSize: number,
  totalItems: number,
): { start: number; end: number } {
  if (pageSize <= 0 || totalItems <= 0) {
    return { start: 0, end: 0 };
  }

  const totalPages = getTotalPages(totalItems, pageSize);
  const safePage = clampPage(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const end = Math.min(start + pageSize, totalItems);
  return { start, end };
}

export const USER_INPUT_OTHER_OPTION_LABEL = "None of the above";
export const USER_INPUT_NOTE_PREFIX = "user_note: ";

export interface UserInputAnswerDraft {
  optionLabel: string;
  otherText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function getAnswerList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  }

  if (isRecord(value) && Array.isArray(value.answers)) {
    return value.answers.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  }

  return [];
}

export function parseResolvedUserInputAnswers(
  value: unknown,
): Record<string, UserInputAnswerDraft> | null {
  const parsed = parseJsonIfString(value);
  if (!isRecord(parsed)) {
    return null;
  }

  const answersRoot = isRecord(parsed.answers) ? parsed.answers : parsed;
  const resolved: Record<string, UserInputAnswerDraft> = {};

  for (const [questionId, entry] of Object.entries(answersRoot)) {
    if (!questionId.trim()) {
      continue;
    }

    const answerList = getAnswerList(entry);
    if (answerList.length === 0) {
      continue;
    }

    const optionLabel =
      answerList.find((item) => !item.startsWith(USER_INPUT_NOTE_PREFIX)) ?? "";
    if (!optionLabel) {
      continue;
    }

    const otherText = (
      answerList.find((item) => item.startsWith(USER_INPUT_NOTE_PREFIX)) ?? ""
    ).slice(USER_INPUT_NOTE_PREFIX.length);

    resolved[questionId] = {
      optionLabel,
      otherText,
    };
  }

  return Object.keys(resolved).length > 0 ? resolved : null;
}

const SANITIZE_PATTERNS = [
  /<command-name>[^<]*<\/command-name>/g,
  /<command-message>[^<]*<\/command-message>/g,
  /<command-args>[^<]*<\/command-args>/g,
  /<local-command-stdout>[^<]*<\/local-command-stdout>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /^\s*Caveat:.*?unless the user explicitly asks you to\./s,
];

export function sanitizeText(text: string): string {
  let result = text;
  for (const pattern of SANITIZE_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.trim();
}

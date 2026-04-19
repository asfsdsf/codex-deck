import assert from "node:assert/strict";
import test from "node:test";
import {
  clampPage,
  formatDurationFromTimestamps,
  formatDurationMs,
  formatLocalTimestamp,
  formatTime,
  getPageSliceBounds,
  getTotalPages,
  parseResolvedUserInputAnswers,
  reconcilePendingTurnWithThreadState,
  sanitizeText,
  USER_INPUT_NOTE_PREFIX,
} from "../../web/utils";
import { getConversationActivityDetails } from "../../web/components/session-view";

test("formatTime formats recent relative timestamps", () => {
  const now = Date.now();

  assert.equal(formatTime(now - 30 * 1000), "Just now");
  assert.equal(formatTime(now - 5 * 60 * 1000), "5m");
  assert.equal(formatTime(now - 2 * 60 * 60 * 1000), "2h");
  assert.equal(formatTime(now - 3 * 24 * 60 * 60 * 1000), "3d");
});

test("formatLocalTimestamp formats ISO timestamp in local timezone", () => {
  const isoTimestamp = "2026-01-02T03:04:05.067Z";
  const localDate = new Date(isoTimestamp);
  const timeZoneAbbreviation =
    new Intl.DateTimeFormat(undefined, {
      timeZoneName: "short",
    })
      .formatToParts(localDate)
      .find((part) => part.type === "timeZoneName")
      ?.value.trim() || "UTC";
  const expected = `${localDate.getFullYear()}-${String(
    localDate.getMonth() + 1,
  ).padStart(2, "0")}-${String(localDate.getDate()).padStart(2, "0")} ${String(
    localDate.getHours(),
  ).padStart(
    2,
    "0",
  )}:${String(localDate.getMinutes()).padStart(2, "0")}:${String(
    localDate.getSeconds(),
  ).padStart(2, "0")} ${timeZoneAbbreviation}`;

  assert.equal(formatLocalTimestamp(isoTimestamp), expected);
  assert.equal(formatLocalTimestamp("not-a-date"), null);
});

test("formatLocalTimestamp falls back to UTC offset when timezone part is unavailable", () => {
  const isoTimestamp = "2026-01-02T03:04:05.067Z";
  const localDate = new Date(isoTimestamp);
  const offsetMinutes = -localDate.getTimezoneOffset();
  const fallbackTimeZoneLabel =
    offsetMinutes === 0
      ? "UTC"
      : `UTC${offsetMinutes >= 0 ? "+" : "-"}${String(
          Math.floor(Math.abs(offsetMinutes) / 60),
        ).padStart(2, "0")}:${String(Math.abs(offsetMinutes) % 60).padStart(
          2,
          "0",
        )}`;

  const originalDateTimeFormat = Intl.DateTimeFormat;
  Object.defineProperty(Intl, "DateTimeFormat", {
    configurable: true,
    writable: true,
    value: function mockDateTimeFormat(): Pick<
      Intl.DateTimeFormat,
      "formatToParts"
    > {
      return {
        formatToParts() {
          return [];
        },
      };
    },
  });

  try {
    const expected = `${localDate.getFullYear()}-${String(
      localDate.getMonth() + 1,
    ).padStart(2, "0")}-${String(localDate.getDate()).padStart(
      2,
      "0",
    )} ${String(localDate.getHours()).padStart(2, "0")}:${String(
      localDate.getMinutes(),
    ).padStart(2, "0")}:${String(localDate.getSeconds()).padStart(
      2,
      "0",
    )} ${fallbackTimeZoneLabel}`;
    assert.equal(formatLocalTimestamp(isoTimestamp), expected);
  } finally {
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      writable: true,
      value: originalDateTimeFormat,
    });
  }
});

test("formatDurationMs formats durations across unit boundaries", () => {
  assert.equal(formatDurationMs(320), "320ms");
  assert.equal(formatDurationMs(1500), "1.5s");
  assert.equal(formatDurationMs(12_000), "12s");
  assert.equal(formatDurationMs(65_000), "1m 5s");
  assert.equal(formatDurationMs(3_610_000), "1h");
});

test("formatDurationFromTimestamps returns duration when timestamps are valid", () => {
  assert.equal(
    formatDurationFromTimestamps(
      "2026-01-02T03:04:05.000Z",
      "2026-01-02T03:04:06.500Z",
    ),
    "1.5s",
  );
  assert.equal(
    formatDurationFromTimestamps(
      "2026-01-02T03:04:05.000Z",
      "2026-01-02T03:03:05.000Z",
    ),
    null,
  );
  assert.equal(formatDurationFromTimestamps(undefined, undefined), null);
});

test("sanitizeText removes internal command and reminder tags", () => {
  const input = [
    "hello",
    "<command-name>run</command-name>",
    "<command-message>ignore</command-message>",
    "<command-args>--debug</command-args>",
    "<local-command-stdout>stdout</local-command-stdout>",
    "<terminal-command-output><content><![CDATA[hidden]]></content></terminal-command-output>",
    "<system-reminder>hidden</system-reminder>",
  ].join("\n");

  assert.equal(sanitizeText(input), "hello");
});

test("sanitizeText removes caveat prefix block", () => {
  const input =
    "Caveat: this message should be removed unless the user explicitly asks you to.\nVisible text";

  assert.equal(sanitizeText(input), "Visible text");
});

test("getTotalPages returns expected values across boundaries", () => {
  assert.equal(getTotalPages(0, 100), 1);
  assert.equal(getTotalPages(1, 100), 1);
  assert.equal(getTotalPages(99, 100), 1);
  assert.equal(getTotalPages(100, 100), 1);
  assert.equal(getTotalPages(101, 100), 2);
  assert.equal(getTotalPages(250, 100), 3);
});

test("clampPage constrains page to valid range", () => {
  assert.equal(clampPage(0, 3), 1);
  assert.equal(clampPage(1, 3), 1);
  assert.equal(clampPage(2, 3), 2);
  assert.equal(clampPage(4, 3), 3);
  assert.equal(clampPage(3, 1), 1);
});

test("getPageSliceBounds returns expected slices", () => {
  assert.deepEqual(getPageSliceBounds(1, 100, 250), { start: 0, end: 100 });
  assert.deepEqual(getPageSliceBounds(2, 100, 250), { start: 100, end: 200 });
  assert.deepEqual(getPageSliceBounds(3, 100, 250), { start: 200, end: 250 });
  assert.deepEqual(getPageSliceBounds(4, 100, 250), { start: 200, end: 250 });
  assert.deepEqual(getPageSliceBounds(1, 100, 0), { start: 0, end: 0 });
});

test("parseResolvedUserInputAnswers parses JSON string payload", () => {
  const parsed = parseResolvedUserInputAnswers(
    JSON.stringify({
      answers: {
        q1: { answers: ["Option A"] },
      },
    }),
  );

  assert.deepEqual(parsed, {
    q1: {
      optionLabel: "Option A",
      otherText: "",
    },
  });
});

test("parseResolvedUserInputAnswers parses other option and user note", () => {
  const parsed = parseResolvedUserInputAnswers({
    answers: {
      q2: {
        answers: ["None of the above", `${USER_INPUT_NOTE_PREFIX}Custom note`],
      },
    },
  });

  assert.deepEqual(parsed, {
    q2: {
      optionLabel: "None of the above",
      otherText: "Custom note",
    },
  });
});

test("parseResolvedUserInputAnswers returns null for malformed payload", () => {
  assert.equal(parseResolvedUserInputAnswers("not json"), null);
  assert.equal(parseResolvedUserInputAnswers({ output: "ok" }), null);
});

test("reconcilePendingTurnWithThreadState clears pending turn when generation has ended", () => {
  assert.equal(
    reconcilePendingTurnWithThreadState(
      {
        sessionId: "session-1",
        turnId: "turn-1",
      },
      "session-1",
      "turn-1",
      {
        threadId: "session-1",
        activeTurnId: null,
        isGenerating: false,
        requestedTurnId: "turn-1",
        requestedTurnStatus: null,
      },
    ),
    null,
  );
});

test("reconcilePendingTurnWithThreadState preserves other-session pending turn when generation has ended", () => {
  const current = {
    sessionId: "session-2",
    turnId: "turn-2",
  };

  assert.equal(
    reconcilePendingTurnWithThreadState(current, "session-1", "turn-1", {
      threadId: "session-1",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: "turn-1",
      requestedTurnStatus: null,
    }),
    current,
  );
});

test("reconcilePendingTurnWithThreadState clears a latched pending turn after a later idle retry", () => {
  const pendingTurn = {
    sessionId: "session-1",
    turnId: "turn-1",
  };

  const stillGenerating = reconcilePendingTurnWithThreadState(
    pendingTurn,
    "session-1",
    "turn-1",
    {
      threadId: "session-1",
      activeTurnId: null,
      isGenerating: true,
      requestedTurnId: "turn-1",
      requestedTurnStatus: "inProgress",
    },
  );
  assert.deepEqual(stillGenerating, pendingTurn);

  assert.equal(
    reconcilePendingTurnWithThreadState(
      stillGenerating,
      "session-1",
      "turn-1",
      {
        threadId: "session-1",
        activeTurnId: null,
        isGenerating: false,
        requestedTurnId: "turn-1",
        requestedTurnStatus: null,
      },
    ),
    null,
  );
});

test("getConversationActivityDetails ignores bootstrap-only visible messages", () => {
  assert.deepEqual(
    getConversationActivityDetails(
      [
        {
          type: "assistant",
          uuid: "msg-1",
          timestamp: "2026-03-20T00:00:00.000Z",
        },
      ],
      "bootstrap",
    ),
    {
      hasVisibleMessageIncrease: false,
      turnLifecycleEvents: undefined,
    },
  );
});

test("getConversationActivityDetails ignores prepended lifecycle events from older history", () => {
  assert.deepEqual(
    getConversationActivityDetails(
      [
        {
          type: "task_started",
          uuid: "msg-1",
          timestamp: "2026-03-20T00:00:00.000Z",
          turnId: "turn-old",
        },
        {
          type: "assistant",
          uuid: "msg-2",
          timestamp: "2026-03-20T00:00:01.000Z",
        },
      ],
      "incremental",
      "prepend",
    ),
    {
      hasVisibleMessageIncrease: false,
      turnLifecycleEvents: undefined,
    },
  );
});

test("getConversationActivityDetails keeps appended incremental lifecycle events", () => {
  assert.deepEqual(
    getConversationActivityDetails(
      [
        {
          type: "task_started",
          uuid: "msg-1",
          timestamp: "2026-03-20T00:00:00.000Z",
          turnId: "turn-live",
        },
        {
          type: "assistant",
          uuid: "msg-2",
          timestamp: "2026-03-20T00:00:01.000Z",
        },
      ],
      "incremental",
      "append",
    ),
    {
      hasVisibleMessageIncrease: true,
      turnLifecycleEvents: [
        {
          type: "task_started",
          turnId: "turn-live",
        },
      ],
    },
  );
});

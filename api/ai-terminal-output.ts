import { sanitizeTerminalTranscriptChunk } from "./terminal-transcript";

function stripLikelyPromptPrefix(line: string): string {
  const trimmed = line.trim();
  const withoutContinuationPrompt = trimmed.replace(
    /^.*?\bcursh>\s*=?\s*/iu,
    "",
  );
  const withoutPrompt =
    withoutContinuationPrompt !== trimmed
      ? withoutContinuationPrompt
      : trimmed.replace(
          /^(?:\([^)]*\)\s*)?[^\r\n]{0,80}?\s[»>$#%]\s*=?\s*/u,
          "",
        );

  return withoutPrompt.replace(/^=\s*/u, "").replace(/>$/u, "").trim();
}

function normalizeShellLineForComparison(line: string): string {
  return stripLikelyPromptPrefix(line)
    .replace(/\s+/gu, " ")
    .trim();
}

function shouldDropWrapperLine(line: string, command: string): boolean {
  const rawTrimmed = line.trim();
  const normalized = normalizeShellLineForComparison(line);
  const normalizedCommand = command.replace(/\s+/gu, " ").trim();

  if (/^[{}][>»]?\s*$/u.test(rawTrimmed)) {
    return true;
  }
  if (!normalized) {
    return false;
  }
  if (normalized === "{" || normalized === "}") {
    return true;
  }
  if (normalized === normalizedCommand) {
    return true;
  }
  if (
    normalized.endsWith(normalizedCommand) &&
    /^cd\s+.+\s+&&\s+/u.test(normalized)
  ) {
    return true;
  }
  if (/^cd\s+.+\s+\|\|\s+exit\s+1$/u.test(normalized)) {
    return true;
  }

  return false;
}

export function cleanAiTerminalExecutionOutput(
  rawOutput: string,
  command: string,
): string {
  const sanitized = sanitizeTerminalTranscriptChunk(rawOutput);
  const lines = sanitized.split("\n");
  const keptLines = lines.filter(
    (line) => !shouldDropWrapperLine(line, command),
  );
  return keptLines
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd();
}

function stripPromptPrefixForLiveOutput(line: string): string {
  return line
    .replace(/^.*?\bcursh>\s*=?\s*/iu, "")
    .replace(/^(?:\([^)]*\)\s*)?[^\r\n]{0,80}?\s[»>$#%]\s*=?\s*/u, "")
    .replace(/^=\s*/u, "")
    .trim();
}

export function cleanLiveAiTerminalExecutionOutput(
  execution: {
    command: string;
    cwd: string;
    stepId: string;
  },
  rawOutput: string,
): string {
  const sanitized = sanitizeTerminalTranscriptChunk(rawOutput);
  const expectedLines = [execution.command]
    .map((line) => stripPromptPrefixForLiveOutput(line).replace(/\s+/gu, ""))
    .filter(
      (line, index, lines) => line.length > 0 && lines.indexOf(line) === index,
    );
  const lines = sanitized.split("\n");
  const keptLines: string[] = [];
  let sawMeaningfulOutput = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (sawMeaningfulOutput && keptLines[keptLines.length - 1] !== "") {
        keptLines.push("");
      }
      continue;
    }

    const strippedLine = stripPromptPrefixForLiveOutput(line);
    const compactLine = strippedLine.replace(/\s+/gu, "");
    const relaxedCompactLine = compactLine.replace(/^[&X>=-]+/u, "");
    const looksLikePromptLine =
      /\s[»>$#%]\s*$/u.test(trimmed) || /\bcursh>\s*$/iu.test(trimmed);
    const looksLikeEditingNoise = /^[=&X>%]+$/u.test(strippedLine);
    const looksLikeShellNoisePrefix = /^[&X>=-]/u.test(strippedLine);
    const looksLikeShellSyntaxFragment =
      /['"$;&=]/u.test(strippedLine) ||
      strippedLine.includes("&&");
    const matchesExpectedLine = (value: string) =>
      value.length > 0 &&
      expectedLines.some(
        (expectedLine) =>
          expectedLine === value ||
          expectedLine.startsWith(value) ||
          value.startsWith(expectedLine),
      );
    const matchesExpectedLinePrefix = (value: string) =>
      value.length > 0 &&
      expectedLines.some(
        (expectedLine) =>
          expectedLine === value || expectedLine.startsWith(value),
      );
    const looksLikeCommandEcho =
      compactLine.length > 0 &&
      matchesExpectedLine(compactLine) &&
      looksLikeShellSyntaxFragment;
    const looksLikeBrokenCommandEcho =
      !sawMeaningfulOutput &&
      relaxedCompactLine.length > 0 &&
      matchesExpectedLine(relaxedCompactLine) &&
      (looksLikeShellSyntaxFragment || looksLikeShellNoisePrefix);
    const looksLikeEarlyCommandFragment =
      !sawMeaningfulOutput &&
      compactLine.length > 0 &&
      matchesExpectedLinePrefix(relaxedCompactLine || compactLine);
    const looksLikePreOutputShellEditingNoise =
      !sawMeaningfulOutput &&
      strippedLine.length <= 240 &&
      (looksLikeShellSyntaxFragment ||
        looksLikeShellNoisePrefix ||
        strippedLine.includes("$user_value") ||
        strippedLine.endsWith(">"));

    if (
      looksLikePromptLine ||
      looksLikeEditingNoise ||
      looksLikeCommandEcho ||
      looksLikeBrokenCommandEcho ||
      looksLikeEarlyCommandFragment ||
      looksLikePreOutputShellEditingNoise
    ) {
      continue;
    }

    sawMeaningfulOutput = true;
    keptLines.push(trimmed);
  }

  return keptLines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export interface ReviewLocation {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ReviewFinding {
  title: string;
  body: string;
  priority: number | null;
  confidence: number | null;
  location: ReviewLocation | null;
}

export interface ReviewReport {
  format: "json" | "user-action";
  summary: string;
  findings: ReviewFinding[];
  verdict: "correct" | "incorrect" | null;
  confidence: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function confidence(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function priority(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 3
    ? value
    : null;
}

function findingTitle(title: string) {
  const match = title.trim().match(/^\[P([0-3])\]\s*(.+)$/s);
  return {
    title: match ? match[2].trim() : title.trim(),
    priority: match ? Number(match[1]) : null,
  };
}

function location(
  path: unknown,
  startLine: unknown,
  endLine: unknown,
): ReviewLocation | null {
  if (
    typeof path !== "string" ||
    !path.trim() ||
    typeof startLine !== "number" ||
    !Number.isSafeInteger(startLine) ||
    startLine < 1 ||
    typeof endLine !== "number" ||
    !Number.isSafeInteger(endLine) ||
    endLine < startLine
  )
    return null;
  return { path: path.trim(), startLine, endLine };
}

function parseJsonReview(text: string): ReviewReport | null {
  const fenced = text.match(/^(`{3,}|~{3,})(?:json)?\s*\n([\s\S]*?)\n\1\s*$/i);
  let value;
  try {
    value = record(JSON.parse(fenced ? fenced[2] : text));
  } catch {
    return null;
  }
  if (!value || !Array.isArray(value.findings)) return null;
  const findings: ReviewFinding[] = [];
  for (const candidate of value.findings) {
    const finding = record(candidate);
    if (
      !finding ||
      typeof finding.title !== "string" ||
      !finding.title.trim() ||
      typeof finding.body !== "string"
    )
      return null;
    const title = findingTitle(finding.title);
    const codeLocation = record(finding.code_location);
    const range = record(codeLocation?.line_range);
    findings.push({
      ...title,
      body: finding.body.trim(),
      priority: priority(finding.priority) ?? title.priority,
      confidence: confidence(finding.confidence_score),
      location: location(
        codeLocation?.absolute_file_path,
        range?.start,
        range?.end,
      ),
    });
  }
  const summary =
    typeof value.overall_explanation === "string"
      ? value.overall_explanation.trim()
      : "";
  const verdict =
    value.overall_correctness === "patch is correct"
      ? "correct"
      : value.overall_correctness === "patch is incorrect"
        ? "incorrect"
        : null;
  if (!findings.length && !summary && !verdict) return null;
  return {
    format: "json",
    summary,
    findings,
    verdict,
    confidence: confidence(value.overall_confidence_score),
  };
}

function parseReviewResults(results: string): ReviewReport {
  // Native review summaries use this heading both on separate lines and in
  // whitespace-flattened messages. Keep body Markdown intact between findings.
  const heading =
    /(?:^|\s)-[ \t]+\[P([0-3])\][ \t]+([^\n]+?)[ \t]+[—–][ \t]+([^\n]+?):(\d+)(?:-(\d+))?(?=\s|$)/g;
  const matches = [...results.matchAll(heading)];
  const findings = matches.map(
    (match, index): ReviewFinding => ({
      title: match[2].trim(),
      priority: Number(match[1]),
      confidence: null,
      location: location(
        match[3].trim().replace(/^`|`$/g, ""),
        Number(match[4]),
        Number(match[5] ?? match[4]),
      ),
      body: results
        .slice(
          match.index! + match[0].length,
          matches[index + 1]?.index ?? results.length,
        )
        .replace(/\n {2}/g, "\n")
        .trim(),
    }),
  );
  return {
    format: "user-action",
    summary: (matches.length ? results.slice(0, matches[0].index) : results)
      .replace(/Full review comments:\s*$/i, "")
      .trim(),
    findings,
    verdict: null,
    confidence: null,
  };
}

/** Recognize complete review payloads; unrelated or incomplete text stays Markdown. */
export function parseReviewReport(text: string): ReviewReport | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (/^<user_action>/i.test(normalized)) {
    const wrapped = normalized.match(
      /^<user_action>\s*(?:<context>[\s\S]*?<\/context>\s*)?<action>\s*review\s*<\/action>\s*<results>([\s\S]*?)<\/results>\s*<\/user_action>$/i,
    );
    const results = wrapped?.[1]?.trim();
    if (!results) return null;
    return parseJsonReview(results) ?? parseReviewResults(results);
  }
  if (!/^(?:\{|`{3,}|~{3,})/.test(normalized)) return null;
  return parseJsonReview(normalized);
}

export function reviewLocationHref(location: ReviewLocation): string {
  // Encode punctuation as well as spaces so model-provided paths cannot become
  // URL schemes. The existing file-link handler decodes this before resolving it.
  return `${encodeURIComponent(location.path).replace(/%2F|%5C/gi, "/")}#L${location.startLine}`;
}

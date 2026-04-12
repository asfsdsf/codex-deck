export type ParsedRgOutputLine =
  | {
      kind: "match_with_column";
      filePath: string;
      lineNumber: string;
      columnNumber: string;
      text: string;
    }
  | {
      kind: "match_with_line";
      filePath: string;
      lineNumber: string;
      text: string;
    }
  | {
      kind: "path_only";
      text: string;
    }
  | {
      kind: "plain";
      text: string;
    };

export function parseRgOutputLine(line: string): ParsedRgOutputLine {
  const withColumn = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
  if (withColumn) {
    return {
      kind: "match_with_column",
      filePath: withColumn[1],
      lineNumber: withColumn[2],
      columnNumber: withColumn[3],
      text: withColumn[4],
    };
  }

  const withLine = line.match(/^(.+?):(\d+):(.*)$/);
  if (withLine) {
    return {
      kind: "match_with_line",
      filePath: withLine[1],
      lineNumber: withLine[2],
      text: withLine[3],
    };
  }

  if (
    line.length > 0 &&
    !line.includes(" ") &&
    (line.includes("/") || line.includes("\\") || line.includes("."))
  ) {
    return {
      kind: "path_only",
      text: line,
    };
  }

  return {
    kind: "plain",
    text: line,
  };
}

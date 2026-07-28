export interface PatchSummaryRow {
  operation: "add" | "update" | "delete";
  path: string;
  movePath: string | null;
  added: number;
  removed: number;
}

const PATCH_FILE_HEADER_REGEX = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_TO_HEADER_REGEX = /^\*\*\* Move to: (.+)$/;

export function parsePatchSummaryRows(raw: string): PatchSummaryRow[] {
  const rows: PatchSummaryRow[] = [];
  let currentRow: PatchSummaryRow | null = null;

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const headerMatch = line.match(PATCH_FILE_HEADER_REGEX);
    if (headerMatch) {
      currentRow = {
        operation:
          headerMatch[1].toLowerCase() === "add"
            ? "add"
            : headerMatch[1].toLowerCase() === "delete"
              ? "delete"
              : "update",
        path: headerMatch[2].trim(),
        movePath: null,
        added: 0,
        removed: 0,
      };
      rows.push(currentRow);
      continue;
    }

    if (!currentRow) {
      continue;
    }

    const moveMatch = line.match(PATCH_MOVE_TO_HEADER_REGEX);
    if (moveMatch) {
      currentRow.movePath = moveMatch[1].trim();
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentRow.added += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      currentRow.removed += 1;
    }
  }

  return rows;
}

export function getPatchLineTotals(rows: PatchSummaryRow[]): {
  added: number;
  removed: number;
} {
  return rows.reduce(
    (totals, row) => ({
      added: totals.added + row.added,
      removed: totals.removed + row.removed,
    }),
    { added: 0, removed: 0 },
  );
}

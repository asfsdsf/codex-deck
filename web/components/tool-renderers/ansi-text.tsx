import type { CSSProperties } from "react";

interface AnsiState {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  inverse: boolean;
}

interface AnsiSegment {
  text: string;
  state: AnsiState;
}

const ANSI_ESCAPE_REGEX = /\x1b\[([0-9;]*)m/g;
const ANSI_BASE_COLORS = [
  "#27272a",
  "#ef4444",
  "#22c55e",
  "#facc15",
  "#60a5fa",
  "#c084fc",
  "#22d3ee",
  "#e4e4e7",
];
const ANSI_BRIGHT_COLORS = [
  "#52525b",
  "#f87171",
  "#4ade80",
  "#fde047",
  "#93c5fd",
  "#d8b4fe",
  "#67e8f9",
  "#f4f4f5",
];
const ANSI_DEFAULT_INVERSE_FG = "#0a0a0a";
const ANSI_DEFAULT_INVERSE_BG = "#f4f4f5";

function getDefaultState(): AnsiState {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
    inverse: false,
  };
}

function cloneState(state: AnsiState): AnsiState {
  return {
    fg: state.fg,
    bg: state.bg,
    bold: state.bold,
    dim: state.dim,
    italic: state.italic,
    underline: state.underline,
    strikethrough: state.strikethrough,
    inverse: state.inverse,
  };
}

function normalizeSgrCodes(codesPart: string): number[] {
  if (!codesPart) {
    return [0];
  }

  const parsed = codesPart.split(";").map((value) => {
    if (value === "") {
      return 0;
    }
    const numeric = Number.parseInt(value, 10);
    return Number.isFinite(numeric) ? numeric : 0;
  });

  return parsed.length > 0 ? parsed : [0];
}

function colorFrom256(index: number): string {
  if (index < 0) {
    return ANSI_BASE_COLORS[0];
  }

  if (index <= 7) {
    return ANSI_BASE_COLORS[index];
  }

  if (index <= 15) {
    return ANSI_BRIGHT_COLORS[index - 8];
  }

  if (index >= 16 && index <= 231) {
    const normalized = index - 16;
    const r = Math.floor(normalized / 36);
    const g = Math.floor((normalized % 36) / 6);
    const b = normalized % 6;
    const map = [0, 95, 135, 175, 215, 255];
    return `rgb(${map[r]}, ${map[g]}, ${map[b]})`;
  }

  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }

  return ANSI_BRIGHT_COLORS[7];
}

function applySgrCode(state: AnsiState, codes: number[]): AnsiState {
  const next = cloneState(state);

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];

    if (code === 0) {
      const resetState = getDefaultState();
      next.fg = resetState.fg;
      next.bg = resetState.bg;
      next.bold = resetState.bold;
      next.dim = resetState.dim;
      next.italic = resetState.italic;
      next.underline = resetState.underline;
      next.strikethrough = resetState.strikethrough;
      next.inverse = resetState.inverse;
      continue;
    }

    if (code === 1) {
      next.bold = true;
      continue;
    }

    if (code === 2) {
      next.dim = true;
      continue;
    }

    if (code === 3) {
      next.italic = true;
      continue;
    }

    if (code === 4) {
      next.underline = true;
      continue;
    }

    if (code === 7) {
      next.inverse = true;
      continue;
    }

    if (code === 9) {
      next.strikethrough = true;
      continue;
    }

    if (code === 22) {
      next.bold = false;
      next.dim = false;
      continue;
    }

    if (code === 23) {
      next.italic = false;
      continue;
    }

    if (code === 24) {
      next.underline = false;
      continue;
    }

    if (code === 27) {
      next.inverse = false;
      continue;
    }

    if (code === 29) {
      next.strikethrough = false;
      continue;
    }

    if (code >= 30 && code <= 37) {
      next.fg = ANSI_BASE_COLORS[code - 30];
      continue;
    }

    if (code >= 90 && code <= 97) {
      next.fg = ANSI_BRIGHT_COLORS[code - 90];
      continue;
    }

    if (code === 39) {
      next.fg = undefined;
      continue;
    }

    if (code >= 40 && code <= 47) {
      next.bg = ANSI_BASE_COLORS[code - 40];
      continue;
    }

    if (code >= 100 && code <= 107) {
      next.bg = ANSI_BRIGHT_COLORS[code - 100];
      continue;
    }

    if (code === 49) {
      next.bg = undefined;
      continue;
    }

    if (code === 38 || code === 48) {
      const isForeground = code === 38;
      const mode = codes[index + 1];

      if (mode === 5 && typeof codes[index + 2] === "number") {
        const color = colorFrom256(codes[index + 2]);
        if (isForeground) {
          next.fg = color;
        } else {
          next.bg = color;
        }
        index += 2;
        continue;
      }

      if (
        mode === 2 &&
        typeof codes[index + 2] === "number" &&
        typeof codes[index + 3] === "number" &&
        typeof codes[index + 4] === "number"
      ) {
        const r = Math.max(0, Math.min(255, codes[index + 2]));
        const g = Math.max(0, Math.min(255, codes[index + 3]));
        const b = Math.max(0, Math.min(255, codes[index + 4]));
        const color = `rgb(${r}, ${g}, ${b})`;
        if (isForeground) {
          next.fg = color;
        } else {
          next.bg = color;
        }
        index += 4;
      }
    }
  }

  return next;
}

function parseAnsiSegments(text: string): AnsiSegment[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const segments: AnsiSegment[] = [];
  let state = getDefaultState();
  let lastIndex = 0;
  ANSI_ESCAPE_REGEX.lastIndex = 0;
  let match = ANSI_ESCAPE_REGEX.exec(normalized);

  while (match) {
    const startIndex = match.index;
    if (startIndex > lastIndex) {
      segments.push({
        text: normalized.slice(lastIndex, startIndex),
        state: cloneState(state),
      });
    }

    const sgrCodes = normalizeSgrCodes(match[1] ?? "");
    state = applySgrCode(state, sgrCodes);
    lastIndex = startIndex + match[0].length;
    match = ANSI_ESCAPE_REGEX.exec(normalized);
  }

  if (lastIndex < normalized.length) {
    segments.push({
      text: normalized.slice(lastIndex),
      state: cloneState(state),
    });
  }

  return segments;
}

function getSegmentStyle(state: AnsiState): CSSProperties | undefined {
  const originalForeground = state.fg;
  const originalBackground = state.bg;
  let foreground = originalForeground;
  let background = originalBackground;

  if (state.inverse) {
    foreground = originalBackground ?? ANSI_DEFAULT_INVERSE_FG;
    background = originalForeground ?? ANSI_DEFAULT_INVERSE_BG;
  }

  const textDecorations: string[] = [];
  if (state.underline) {
    textDecorations.push("underline");
  }
  if (state.strikethrough) {
    textDecorations.push("line-through");
  }

  const style: CSSProperties = {};
  if (foreground) {
    style.color = foreground;
  }
  if (background) {
    style.backgroundColor = background;
  }
  if (state.bold) {
    style.fontWeight = 600;
  }
  if (state.italic) {
    style.fontStyle = "italic";
  }
  if (state.dim) {
    style.opacity = 0.75;
  }
  if (textDecorations.length > 0) {
    style.textDecoration = textDecorations.join(" ");
  }

  return Object.keys(style).length > 0 ? style : undefined;
}

export function AnsiText(props: { text: string }) {
  const segments = parseAnsiSegments(props.text);

  if (segments.length === 0) {
    return null;
  }

  return (
    <>
      {segments.map((segment, index) => (
        <span key={index} style={getSegmentStyle(segment.state)}>
          {segment.text}
        </span>
      ))}
    </>
  );
}

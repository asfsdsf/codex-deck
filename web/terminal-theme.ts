import type { ResolvedTheme } from "./theme";

// Colors for the xterm surfaces (live terminal and frozen snapshot blocks).
// background/foreground/cursor match --app-terminal-* in index.css. The ANSI
// palette and selection colors are set explicitly because xterm's defaults are
// tuned for dark backgrounds: on the light surface its white/yellow text and
// its translucent white selection are invisible.
export interface TerminalThemePalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const LIGHT_TERMINAL_THEME: TerminalThemePalette = {
  background: "#fafafa",
  foreground: "#1f1f1f",
  cursor: "#111111",
  cursorAccent: "#fafafa",
  selectionBackground: "rgba(31, 134, 240, 0.24)",
  selectionInactiveBackground: "rgba(0, 0, 0, 0.1)",
  black: "#1f1f1f",
  red: "#c72e2e",
  green: "#107c10",
  yellow: "#8a6a00",
  blue: "#0451a5",
  magenta: "#a626a4",
  cyan: "#0b7f9e",
  white: "#6b6b6b",
  brightBlack: "#6e6e6e",
  brightRed: "#d93f3f",
  brightGreen: "#138a13",
  brightYellow: "#9c7700",
  brightBlue: "#1a6fd6",
  brightMagenta: "#b23ab0",
  brightCyan: "#0e8fb0",
  brightWhite: "#8c8c8c",
};

const DARK_TERMINAL_THEME: TerminalThemePalette = {
  background: "#141414",
  foreground: "#e4e4e4",
  cursor: "#d4d4d4",
  cursorAccent: "#141414",
  selectionBackground: "rgba(255, 255, 255, 0.24)",
  selectionInactiveBackground: "rgba(255, 255, 255, 0.12)",
  black: "#1f1f1f",
  red: "#e5534b",
  green: "#3fb950",
  yellow: "#d4a72c",
  blue: "#4493f8",
  magenta: "#c678dd",
  cyan: "#39c5cf",
  white: "#d0d0d0",
  brightBlack: "#767676",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#6cb6ff",
  brightMagenta: "#d8a0f0",
  brightCyan: "#56d4dd",
  brightWhite: "#f5f5f5",
};

export function getTerminalTheme(
  resolvedTheme: ResolvedTheme,
): TerminalThemePalette {
  return resolvedTheme === "light"
    ? { ...LIGHT_TERMINAL_THEME }
    : { ...DARK_TERMINAL_THEME };
}

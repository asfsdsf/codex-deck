import type { ResolvedTheme } from "./theme";

export interface TerminalThemePalette {
  background: string;
  foreground: string;
  cursor: string;
}

export function getTerminalTheme(
  resolvedTheme: ResolvedTheme,
): TerminalThemePalette {
  if (resolvedTheme === "light") {
    return {
      background: "#f8fafc",
      foreground: "#1f2937",
      cursor: "#0f172a",
    };
  }

  return {
    background: "#09090b",
    foreground: "#e4e4e7",
    cursor: "#d4d4d8",
  };
}

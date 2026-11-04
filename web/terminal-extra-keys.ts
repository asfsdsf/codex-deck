// Keys that phone and tablet keyboards do not offer, shown as a row of buttons
// under the terminal on touch devices. "Ctrl" is sticky: it applies to the
// next character typed on the on-screen keyboard.

export type TerminalExtraKeyId =
  | "esc"
  | "tab"
  | "ctrl"
  | "ctrl-c"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pipe"
  | "slash"
  | "dash"
  | "tilde";

export interface TerminalExtraKey {
  id: TerminalExtraKeyId;
  label: string;
  ariaLabel: string;
}

export const TERMINAL_EXTRA_KEYS: readonly TerminalExtraKey[] = [
  { id: "esc", label: "Esc", ariaLabel: "Escape" },
  { id: "tab", label: "Tab", ariaLabel: "Tab" },
  { id: "ctrl", label: "Ctrl", ariaLabel: "Control modifier" },
  { id: "ctrl-c", label: "^C", ariaLabel: "Control C" },
  { id: "up", label: "↑", ariaLabel: "Arrow up" },
  { id: "down", label: "↓", ariaLabel: "Arrow down" },
  { id: "left", label: "←", ariaLabel: "Arrow left" },
  { id: "right", label: "→", ariaLabel: "Arrow right" },
  { id: "home", label: "Home", ariaLabel: "Home" },
  { id: "end", label: "End", ariaLabel: "End" },
  { id: "pipe", label: "|", ariaLabel: "Pipe" },
  { id: "slash", label: "/", ariaLabel: "Slash" },
  { id: "dash", label: "-", ariaLabel: "Dash" },
  { id: "tilde", label: "~", ariaLabel: "Tilde" },
];

// Returns the bytes to send for a key, or null for the Ctrl modifier, which
// does not send anything by itself.
export function getTerminalExtraKeySequence(
  id: TerminalExtraKeyId,
  options: { applicationCursorKeys: boolean },
): string | null {
  // Full-screen apps switch the cursor keys to "application" mode (ESC O x).
  const cursorPrefix = options.applicationCursorKeys ? "\u001bO" : "\u001b[";
  switch (id) {
    case "esc":
      return "\u001b";
    case "tab":
      return "\t";
    case "ctrl":
      return null;
    case "ctrl-c":
      return "\u0003";
    case "up":
      return `${cursorPrefix}A`;
    case "down":
      return `${cursorPrefix}B`;
    case "right":
      return `${cursorPrefix}C`;
    case "left":
      return `${cursorPrefix}D`;
    case "home":
      return `${cursorPrefix}H`;
    case "end":
      return `${cursorPrefix}F`;
    case "pipe":
      return "|";
    case "slash":
      return "/";
    case "dash":
      return "-";
    case "tilde":
      return "~";
  }
}

const CONTROL_SYMBOLS: Record<string, string> = {
  " ": "\u0000",
  "@": "\u0000",
  "2": "\u0000",
  "[": "\u001b",
  "3": "\u001b",
  "\\": "\u001c",
  "4": "\u001c",
  "]": "\u001d",
  "5": "\u001d",
  "^": "\u001e",
  "6": "\u001e",
  _: "\u001f",
  "/": "\u001f",
  "7": "\u001f",
  "?": "\u007f",
  "8": "\u007f",
};

// Turns one typed character into its Ctrl combination (c -> ^C). Input that
// is not a single character, or has no Ctrl form, is returned unchanged.
export function applyTerminalCtrlModifier(data: string): string {
  if (data.length !== 1) {
    return data;
  }
  const code = data.charCodeAt(0);
  const isLetter =
    (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
  if (isLetter) {
    return String.fromCharCode(code & 0x1f);
  }
  return CONTROL_SYMBOLS[data] ?? data;
}

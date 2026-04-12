export const VIBETUNNEL_TERMINAL_FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace';

export const VIBETUNNEL_NERD_FONT_STACK =
  '"Hack Nerd Font Mono", "Fira Code", ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace';

export type TerminalFontPreset = "vibetunnel-system" | "vibetunnel-nerd";

const TERMINAL_FONT_PRESET_TO_STACK: Record<TerminalFontPreset, string> = {
  "vibetunnel-system": VIBETUNNEL_TERMINAL_FONT_STACK,
  "vibetunnel-nerd": VIBETUNNEL_NERD_FONT_STACK,
};

// Developer toggle: change this constant to switch local terminal font stack.
export const TERMINAL_FONT_PRESET: TerminalFontPreset = "vibetunnel-nerd";

export const TERMINAL_FONT_FAMILY =
  TERMINAL_FONT_PRESET_TO_STACK[TERMINAL_FONT_PRESET];

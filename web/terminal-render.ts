export interface TerminalFitContainerLike {
  clientWidth: number;
  clientHeight: number;
}

export interface TerminalFitAddonLike {
  fit: () => void;
  proposeDimensions?: () => { cols: number; rows: number } | undefined;
}

export interface TerminalFitTerminalLike {
  cols: number;
  rows: number;
}

// A pane this small is collapsed, animating, or squeezed behind an overlay
// (for example the sidebar on a phone). Fitting to it would reflow the
// terminal into a sliver, and resizing the PTY to it would make the shell
// rewrap everything it draws at that width.
export const MIN_USABLE_TERMINAL_COLS = 20;
export const MIN_USABLE_TERMINAL_ROWS = 4;

export function isUsableTerminalSize(size: {
  cols: number;
  rows: number;
}): boolean {
  return (
    Number.isFinite(size.cols) &&
    Number.isFinite(size.rows) &&
    size.cols >= MIN_USABLE_TERMINAL_COLS &&
    size.rows >= MIN_USABLE_TERMINAL_ROWS
  );
}

// Fits the terminal grid to its container. Hidden, collapsed, or too-small
// containers are skipped so the terminal keeps its last real size.
export function fitTerminalViewport(input: {
  container: TerminalFitContainerLike;
  fitAddon: TerminalFitAddonLike;
  terminal: TerminalFitTerminalLike;
}): {
  didFit: boolean;
  sizeChanged: boolean;
} {
  const width = Math.floor(input.container.clientWidth);
  const height = Math.floor(input.container.clientHeight);
  if (width <= 0 || height <= 0) {
    return { didFit: false, sizeChanged: false };
  }

  const proposed = input.fitAddon.proposeDimensions?.();
  if (proposed && !isUsableTerminalSize(proposed)) {
    return { didFit: false, sizeChanged: false };
  }

  const previousCols = input.terminal.cols;
  const previousRows = input.terminal.rows;
  input.fitAddon.fit();

  return {
    didFit: true,
    sizeChanged:
      input.terminal.cols !== previousCols ||
      input.terminal.rows !== previousRows,
  };
}

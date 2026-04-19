export interface TerminalFitContainerLike {
  clientWidth: number;
  clientHeight: number;
}

export interface TerminalFitAddonLike {
  fit: () => void;
}

export interface TerminalFitTerminalLike {
  cols: number;
  rows: number;
  reset: () => void;
  write: (data: string) => void;
}

export function fitTerminalViewport(input: {
  container: TerminalFitContainerLike;
  fitAddon: TerminalFitAddonLike;
  terminal: TerminalFitTerminalLike;
  replayOutput?: string;
}): {
  didFit: boolean;
  sizeChanged: boolean;
} {
  const width = Math.floor(input.container.clientWidth);
  const height = Math.floor(input.container.clientHeight);
  if (width <= 0 || height <= 0) {
    return { didFit: false, sizeChanged: false };
  }

  const previousCols = input.terminal.cols;
  const previousRows = input.terminal.rows;
  input.fitAddon.fit();

  const sizeChanged =
    input.terminal.cols !== previousCols ||
    input.terminal.rows !== previousRows;

  if (sizeChanged && (input.replayOutput?.length ?? 0) > 0) {
    input.terminal.reset();
    input.terminal.write(input.replayOutput ?? "");
  }

  return {
    didFit: true,
    sizeChanged,
  };
}

import xtermHeadless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type {
  TerminalSerializedSnapshot,
  TerminalSnapshotFormat,
} from "./storage";

export const TERMINAL_SNAPSHOT_FORMAT: TerminalSnapshotFormat =
  "xterm-serialize-v1";

const { Terminal: HeadlessTerminal } = xtermHeadless as {
  Terminal: new (options: {
    allowProposedApi: boolean;
    cols: number;
    rows: number;
    scrollback: number;
  }) => {
    write: (data: string, callback?: () => void) => void;
    resize: (cols: number, rows: number) => void;
    loadAddon: (addon: unknown) => void;
  };
};

function normalizeTerminalSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized >= 2 ? normalized : fallback;
}

function createHeadlessSnapshotTerminal(
  cols: number,
  rows: number,
): {
  terminal: InstanceType<typeof HeadlessTerminal>;
  serializeAddon: SerializeAddon;
} {
  const terminal = new HeadlessTerminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 10_000,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon as never);
  return { terminal, serializeAddon };
}

export class TerminalSnapshotCapture {
  private cols: number;
  private rows: number;
  private terminal: InstanceType<typeof HeadlessTerminal>;
  private serializeAddon: SerializeAddon;
  private pendingWrites: Promise<void> = Promise.resolve();
  private hasContent = false;

  public constructor(cols: number, rows: number) {
    this.cols = normalizeTerminalSize(cols, 80);
    this.rows = normalizeTerminalSize(rows, 24);
    const created = createHeadlessSnapshotTerminal(this.cols, this.rows);
    this.terminal = created.terminal;
    this.serializeAddon = created.serializeAddon;
  }

  public write(data: string): void {
    if (!data) {
      return;
    }
    this.hasContent = true;
    this.pendingWrites = this.pendingWrites.then(
      () =>
        new Promise<void>((resolve) => {
          this.terminal.write(data, () => resolve());
        }),
    );
  }

  public resize(cols: number, rows: number): void {
    this.cols = normalizeTerminalSize(cols, this.cols);
    this.rows = normalizeTerminalSize(rows, this.rows);
    this.terminal.resize(this.cols, this.rows);
  }

  public async consume(): Promise<TerminalSerializedSnapshot | null> {
    await this.pendingWrites;
    if (!this.hasContent) {
      return null;
    }

    const snapshot: TerminalSerializedSnapshot = {
      format: TERMINAL_SNAPSHOT_FORMAT,
      cols: this.cols,
      rows: this.rows,
      data: this.serializeAddon.serialize(),
    };

    this.reset();
    return snapshot;
  }

  public reset(): void {
    const created = createHeadlessSnapshotTerminal(this.cols, this.rows);
    this.terminal = created.terminal;
    this.serializeAddon = created.serializeAddon;
    this.pendingWrites = Promise.resolve();
    this.hasContent = false;
  }
}

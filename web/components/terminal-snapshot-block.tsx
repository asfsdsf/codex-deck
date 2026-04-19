import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSerializedSnapshot } from "@codex-deck/api";
import { TERMINAL_FONT_FAMILY } from "../terminal-font";
import { getTerminalTheme } from "../terminal-theme";
import type { ResolvedTheme } from "../theme";

const MIN_VISIBLE_SNAPSHOT_ROWS = 1;
const MAX_VISIBLE_SNAPSHOT_ROWS = 18;
const FALLBACK_SNAPSHOT_ROW_HEIGHT_PX = 17;

interface SnapshotViewportLayout {
  height: number;
  overflowX: "auto" | "hidden";
  overflowY: "auto" | "hidden";
}

export const TerminalSnapshotBlock = memo(
  function TerminalSnapshotBlock(props: {
    snapshot: TerminalSerializedSnapshot;
    resolvedTheme: ResolvedTheme;
  }) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const maxVisibleRows = Math.min(
      Math.max(props.snapshot.rows, MIN_VISIBLE_SNAPSHOT_ROWS),
      MAX_VISIBLE_SNAPSHOT_ROWS,
    );
    const terminalTheme = useMemo(
      () => getTerminalTheme(props.resolvedTheme),
      [props.resolvedTheme],
    );
    const fallbackViewportHeight = useMemo(
      () => Math.ceil(maxVisibleRows * FALLBACK_SNAPSHOT_ROW_HEIGHT_PX),
      [maxVisibleRows],
    );
    const frameClasses =
      props.resolvedTheme === "light"
        ? {
            outer:
              "shrink-0 rounded-xl border border-slate-500/20 bg-slate-500/10 px-3 py-2",
            viewport: "",
          }
        : {
            outer:
              "shrink-0 rounded-xl border border-dashed border-zinc-700/70 bg-zinc-900/62 px-3 py-2 shadow-[0_0_0_1px_rgba(63,63,70,0.18)]",
            viewport: "",
          };
    const [layout, setLayout] = useState<SnapshotViewportLayout>({
      height: fallbackViewportHeight,
      overflowX: "hidden",
      overflowY: "hidden",
    });

    useEffect(() => {
      setLayout({
        height: fallbackViewportHeight,
        overflowX: "hidden",
        overflowY: "hidden",
      });
    }, [fallbackViewportHeight]);

    useEffect(() => {
      const container = containerRef.current;
      const viewport = viewportRef.current;
      if (!container || !viewport) {
        return;
      }

      let cancelled = false;
      let rafId = 0;
      let resizeObserver: ResizeObserver | null = null;

      const terminal = new Terminal({
        allowTransparency: true,
        convertEol: false,
        cursorBlink: false,
        cursorInactiveStyle: "none",
        cursorStyle: "block",
        disableStdin: true,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: 13,
        rows: props.snapshot.rows,
        cols: props.snapshot.cols,
        scrollback: Math.max(props.snapshot.rows * 10, 1_000),
        theme: terminalTheme,
      });

      const measureViewportLayout = () => {
        const rows = Array.from(
          container.querySelectorAll<HTMLElement>(".xterm-rows > div"),
        );
        const firstRow = rows[0];
        const rowHeight = firstRow?.getBoundingClientRect().height;
        if (!rowHeight || !Number.isFinite(rowHeight)) {
          return;
        }

        let usedRowCount = 0;
        let maxContentWidth = 0;

        for (const [index, row] of rows.entries()) {
          const normalizedText = (row.textContent ?? "")
            .replace(/\u00a0/g, " ")
            .trimEnd();
          if (normalizedText.trim().length === 0) {
            continue;
          }

          usedRowCount = index + 1;
          const rowRect = row.getBoundingClientRect();
          let rowContentWidth = 0;
          for (const child of Array.from(row.children)) {
            const childRect = child.getBoundingClientRect();
            rowContentWidth = Math.max(
              rowContentWidth,
              childRect.right - rowRect.left,
            );
          }
          if (rowContentWidth === 0) {
            rowContentWidth = row.scrollWidth;
          }
          maxContentWidth = Math.max(
            maxContentWidth,
            Math.ceil(rowContentWidth),
          );
        }

        const contentRows = Math.max(usedRowCount, MIN_VISIBLE_SNAPSHOT_ROWS);
        const contentHeight = Math.ceil(contentRows * rowHeight);
        const maxViewportHeight = Math.ceil(maxVisibleRows * rowHeight);
        const nextHeight = Math.min(contentHeight, maxViewportHeight);
        const overflowY = contentHeight > maxViewportHeight ? "auto" : "hidden";
        const overflowX =
          maxContentWidth > viewport.clientWidth + 1 ? "auto" : "hidden";

        setLayout((current) => {
          if (
            current.height === nextHeight &&
            current.overflowX === overflowX &&
            current.overflowY === overflowY
          ) {
            return current;
          }

          return {
            height: nextHeight,
            overflowX,
            overflowY,
          };
        });
      };

      const scheduleMeasure = () => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          if (!cancelled) {
            measureViewportLayout();
          }
        });
      };

      terminal.open(container);
      terminal.write(props.snapshot.data, () => {
        terminal.scrollToBottom();
        scheduleMeasure();

        const fontsReady = document.fonts?.ready;
        if (fontsReady) {
          void fontsReady
            .then(() => {
              if (!cancelled) {
                scheduleMeasure();
              }
            })
            .catch(() => {});
        }
      });

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          scheduleMeasure();
        });
        resizeObserver.observe(viewport);
      }

      return () => {
        cancelled = true;
        cancelAnimationFrame(rafId);
        resizeObserver?.disconnect();
        terminal.dispose();
      };
    }, [maxVisibleRows, props.snapshot, terminalTheme]);

    return (
      <div className={frameClasses.outer}>
        <div
          ref={viewportRef}
          className={frameClasses.viewport}
          style={{
            height: `${layout.height}px`,
            overflowX: layout.overflowX,
            overflowY: layout.overflowY,
          }}
        >
          <div ref={containerRef} />
        </div>
      </div>
    );
  },
);

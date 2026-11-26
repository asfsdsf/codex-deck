import type { PointerEvent } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose } from "lucide-react";
import type { PaneEntry } from "./pane-entries";
import type { DeckPluginViewContext } from "../../builtin-plugins/client-types";
import DeckPluginRuntime from "../components/deck-plugin-runtime";
import PaneMore from "./pane-more";

export default function PackagePane({
  side,
  entry,
  homeId,
  context,
  collapsed,
  width,
  onToggle,
  onBrowse,
  onCreate,
  onResize,
}: {
  side: "left" | "right";
  entry: PaneEntry;
  homeId: string;
  context: DeckPluginViewContext;
  collapsed: boolean;
  width: number;
  onToggle: () => void;
  onBrowse: () => void;
  onCreate: () => void;
  onResize: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  if (side === "right" && collapsed) return null;
  const Icon =
    side === "right"
      ? PanelRightClose
      : collapsed
        ? PanelLeftOpen
        : PanelLeftClose;
  const toggle = `${collapsed ? "Expand" : "Collapse"} ${side} pane`;
  return (
    <aside
      aria-label={entry.view.title}
      className={`pane-${side} relative flex min-h-0 shrink-0 flex-col`}
      style={{ width }}
    >
      <div
        className={`flex shrink-0 items-center gap-1 p-1 ${collapsed ? "flex-col" : ""}`}
      >
        <button
          type="button"
          className="p-2"
          title={toggle}
          aria-label={toggle}
          onClick={onToggle}
        >
          <Icon size={16} />
        </button>
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate text-sm">
            {entry.view.title}
          </span>
        )}
        <PaneMore side={side} compact onBrowse={onBrowse} onCreate={onCreate} />
      </div>
      {!collapsed && (
        <>
          <DeckPluginRuntime
            embedded
            fillPane
            key={homeId + ":" + entry.key}
            homeId={homeId}
            pluginId={entry.pluginId}
            viewId={entry.view.id}
            context={context}
            onClose={onToggle}
          />
          <div
            role="separator"
            aria-label={`Resize ${side} pane`}
            aria-orientation="vertical"
            className={`absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none ${side === "left" ? "right-0" : "left-0"}`}
            onPointerDown={onResize}
          />
        </>
      )}
    </aside>
  );
}

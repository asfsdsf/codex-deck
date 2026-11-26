import type { ReactNode, PointerEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Code2,
  GripVertical,
  Puzzle,
  Settings,
  Terminal,
  Workflow,
} from "lucide-react";
import type { PaneEntry } from "../../web/plugins/pane-entries";
import PaneMore from "../../web/plugins/pane-more";

interface LeftPaneProps {
  collapsed: boolean;
  width: number;
  isMobilePhone: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onResize: (event: PointerEvent<HTMLDivElement>) => void;
  entries: PaneEntry[];
  activeKey: string;
  onSelect: (entry: PaneEntry) => void;
  onBrowse: () => void;
  onCreate: () => void;
  onSettings: () => void;
  connection: ReactNode;
  home: ReactNode;
  machine: ReactNode;
  controls: ReactNode;
  railActions: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}
export default function LeftPane(props: LeftPaneProps) {
  const navigation = (
    <div
      role="group"
      aria-label="Primary views"
      className={
        props.collapsed
          ? "flex flex-col gap-1"
          : "grid grid-cols-[repeat(auto-fit,minmax(min(64px,100%),1fr))] items-center gap-0.5 rounded-[10px] bg-zinc-800/50 p-[3px]"
      }
    >
      {props.entries.map((entry) => {
        const active = entry.key === props.activeKey;
        const Icon =
          entry.key === "sessions"
            ? Code2
            : entry.key === "terminal"
              ? Terminal
              : entry.key === "workflow"
                ? Workflow
                : Puzzle;
        return (
          <button
            key={entry.key}
            type="button"
            aria-pressed={active}
            title={entry.view.title}
            aria-label={entry.view.title}
            className={`flex min-w-0 flex-1 items-center justify-center rounded-[7px] px-1.5 py-1 text-xs font-medium ${props.collapsed ? "min-h-9" : ""} ${active ? "bg-zinc-700/80 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100"}`}
            onClick={() => props.onSelect(entry)}
          >
            {props.collapsed ? (
              <Icon size={16} />
            ) : (
              <span className="truncate">{entry.view.title}</span>
            )}
          </button>
        );
      })}
    </div>
  );
  const more = (
    <PaneMore
      side="left"
      compact={props.collapsed}
      onBrowse={props.onBrowse}
      onCreate={props.onCreate}
    />
  );
  return props.collapsed ? (
    <aside
      aria-label="Collapsed left pane"
      className="pane-left relative flex shrink-0 flex-col border-r border-zinc-800/60 bg-zinc-950"
      style={{ width: `${props.width}px` }}
    >
      <div className="pane-header-left flex h-[50px] shrink-0 items-center justify-center border-b border-zinc-800/60 px-1.5 py-2">
        <button
          type="button"
          onClick={props.onExpand}
          className="flex h-8 w-full items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/60"
          aria-label="Expand left pane"
          title="Expand left pane"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {navigation}
        {more}
        {props.railActions}
      </div>
      <div className="shrink-0 space-y-1 p-1.5">
        <button
          type="button"
          onClick={props.onBrowse}
          aria-haspopup="dialog"
          className="flex h-9 w-full items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/60"
          aria-label="plugins"
          title="plugins"
        >
          <Puzzle className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={props.onSettings}
          className="flex h-9 w-full items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/60"
          title="Codex Deck settings"
          aria-label="Codex Deck settings"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </aside>
  ) : (
    <aside
      className="pane-left relative shrink-0 border-r border-zinc-800/60 flex flex-col bg-zinc-950"
      style={{ width: `${props.width}px` }}
    >
      <div className="pane-header-left">
        <div className="flex min-h-[50px] items-center gap-1.5 px-3 py-2">
          <button
            type="button"
            onClick={props.onCollapse}
            className="h-8 w-8 shrink-0 rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-100"
            aria-label="Collapse left pane"
            title="Collapse left pane"
          >
            <ChevronLeft className="mx-auto h-4 w-4" />
          </button>
          {props.connection}
        </div>
        {props.home}
        <div className="space-y-2 px-2 pb-2">
          {props.machine}
          {navigation}
          {props.controls}
        </div>
      </div>
      <div className="min-h-0 flex-1">{props.children}</div>
      {props.footer}
      <div className="shrink-0 p-2">
        {more}
        <button
          type="button"
          onClick={props.onBrowse}
          aria-haspopup="dialog"
          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/60"
        >
          <Puzzle className="size-4 shrink-0" />
          <span>plugins</span>
        </button>
        <button
          type="button"
          onClick={props.onSettings}
          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/60"
          title="Codex Deck settings"
          aria-label="Codex Deck settings"
        >
          <Settings className="h-4 w-4 shrink-0" />
          <span>Settings</span>
        </button>
      </div>
      <div
        role="separator"
        aria-label="Resize left pane"
        aria-orientation="vertical"
        onPointerDown={props.onResize}
        className={
          props.isMobilePhone
            ? "absolute top-1/2 right-0 z-20 -translate-y-1/2 translate-x-1/2 cursor-col-resize touch-none"
            : "absolute top-0 right-0 z-20 h-full w-2 translate-x-1/2 cursor-col-resize touch-none"
        }
      >
        {props.isMobilePhone && (
          <div className="flex h-10 w-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/95 text-zinc-400 shadow-lg">
            <GripVertical className="h-4 w-4" />
          </div>
        )}
      </div>
    </aside>
  );
}

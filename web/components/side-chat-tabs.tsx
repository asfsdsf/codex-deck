import { Eye, EyeOff, Funnel, Plus, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CodexThreadSummary, Session } from "@codex-deck/api";
import { listCodexSideThreads } from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

function sideChatLabel(
  thread: CodexThreadSummary | undefined,
  session?: Session,
) {
  const name = thread?.name || session?.display || thread?.preview;
  if (
    !name ||
    name.startsWith("Side conversation boundary.") ||
    name === "(no prompt text)"
  ) {
    return "Side chat";
  }
  return name;
}

function SideChatTabLabel({ name, suffix }: { name: string; suffix: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate">{name}</span>
      {suffix && <span className="shrink-0"> {suffix}</span>}
    </span>
  );
}

export default function SideChatTabs({
  parentId,
  activeId,
  sessions,
  onSelect,
  onStart,
  onDelete,
}: {
  parentId: string;
  activeId: string;
  sessions: Session[];
  onSelect: (id: string, thread?: CodexThreadSummary) => void;
  onStart: () => Promise<void>;
  onDelete: (id: string, thread?: CodexThreadSummary) => void;
}) {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const filterId = useId();
  const load = useCallback(() => listCodexSideThreads(parentId), [parentId]);
  const { data, refresh } = useNativeSnapshot("side-chats", parentId, load);
  const localIds = sessions
    .map((session) => session.id)
    .sort()
    .join(",");
  useEffect(() => refresh(), [localIds, refresh]);
  useLayoutEffect(() => {
    const button = filterButtonRef.current;
    const menu = filterMenuRef.current;
    const bar = menu?.offsetParent;
    if (!button || !menu || !(bar instanceof HTMLElement)) return;

    const positionMenu = () => {
      const maxLeft = bar.clientWidth - menu.offsetWidth - 8;
      menu.style.left = `${Math.max(8, Math.min(button.offsetLeft, maxLeft))}px`;
    };
    positionMenu();
    const observer = new ResizeObserver(positionMenu);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [activeId, data, filterOpen, hiddenIds, sessions]);
  useEffect(() => {
    if (!filterOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        filterRef.current
      ) {
        event.preventDefault();
        setFilterOpen(false);
        filterButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [filterOpen]);

  const tabs = new Map(
    sessions.map((session) => [
      session.id,
      {
        id: session.id,
        label: sideChatLabel(undefined, session),
        thread: undefined as CodexThreadSummary | undefined,
      },
    ]),
  );
  for (const thread of data?.threads ?? []) {
    tabs.set(thread.threadId, {
      id: thread.threadId,
      label: sideChatLabel(
        thread,
        sessions.find((session) => session.id === thread.threadId),
      ),
      thread,
    });
  }
  const labelCounts = new Map<string, number>();
  const allTabs = Array.from(tabs.values(), ({ label: name, ...tab }) => {
    const count = labelCounts.get(name) ?? 0;
    labelCounts.set(name, count + 1);
    const suffix = count > 0 ? `(${count})` : "";
    return { ...tab, name, suffix, label: suffix ? `${name} ${suffix}` : name };
  });
  const isVisible = (id: string) => id === activeId || !hiddenIds.has(id);
  if (!allTabs.length && activeId === parentId) return null;

  const setTabVisible = (id: string, visible: boolean) => {
    setHiddenIds((current) => {
      const next = new Set(current);
      if (visible) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!visible && activeId === id) onSelect(parentId);
  };

  const selectedClass = "border-sky-500/50 bg-sky-500/10";
  const tabClass = "rounded px-2 text-xs";
  const iconClass =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-zinc-500/15";
  return (
    <nav
      aria-label="Side chats"
      data-conversation-chrome
      className="relative flex min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-zinc-500/20 px-2 py-1 text-zinc-200"
    >
      <button
        type="button"
        className={`${tabClass} h-[34px] border ${activeId === parentId ? `${selectedClass} hover:bg-sky-500/15` : "border-transparent hover:bg-zinc-500/15"}`}
        aria-current={activeId === parentId ? "page" : undefined}
        onClick={() => onSelect(parentId)}
      >
        Main conversation
      </button>
      {allTabs
        .filter(({ id }) => isVisible(id))
        .map(({ id, name, suffix, label, thread }) => (
          <div
            key={id}
            className={`inline-flex min-w-0 max-w-full items-center rounded border ${
              activeId === id ? selectedClass : "border-zinc-500/25"
            }`}
          >
            <button
              type="button"
              className={`${tabClass} flex h-8 min-w-0 max-w-44 items-center hover:bg-zinc-500/15`}
              aria-label={label}
              title={label}
              aria-current={activeId === id ? "page" : undefined}
              onClick={() => onSelect(id, thread)}
            >
              <SideChatTabLabel name={name} suffix={suffix} />
            </button>
            <button
              type="button"
              className={iconClass}
              aria-label={`Hide ${label}`}
              title={`Hide ${label}`}
              onClick={() => {
                setTabVisible(id, false);
                filterButtonRef.current?.focus();
              }}
            >
              <Eye size={14} />
            </button>
            {activeId === id && (
              <button
                type="button"
                className={`${iconClass} text-red-400`}
                aria-label={`Delete ${label}`}
                title={`Delete ${label}`}
                onClick={() => onDelete(id, thread)}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      <div className="flex items-center gap-1">
        {allTabs.length > 0 && (
          <div ref={filterRef}>
            <button
              ref={filterButtonRef}
              type="button"
              aria-label="Filter side chats"
              title="Filter side chats"
              aria-expanded={filterOpen}
              aria-controls={filterOpen ? filterId : undefined}
              className={`${iconClass} aria-expanded:bg-sky-500/10`}
              onClick={() => setFilterOpen((open) => !open)}
            >
              <Funnel size={15} />
            </button>
            {filterOpen && (
              <div
                ref={filterMenuRef}
                id={filterId}
                role="group"
                aria-label="Side chat visibility"
                className="absolute top-full left-2 z-30 mt-1 flex max-h-[min(15rem,35dvh)] w-60 max-w-[calc(100%-1rem)] flex-col gap-1 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 p-1 text-xs shadow-lg"
              >
                {allTabs.map(({ id, name, suffix, label }) => {
                  const visible = isVisible(id);
                  const Icon = visible ? Eye : EyeOff;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-label={label}
                      aria-pressed={visible}
                      title={`${visible ? "Hide" : "Show"} ${label}`}
                      className={`flex min-h-8 shrink-0 items-center gap-2 rounded px-2 text-left focus-visible:outline-offset-[-2px] ${
                        visible
                          ? "bg-sky-500/10 hover:bg-sky-500/20"
                          : "text-zinc-400 hover:bg-zinc-500/10"
                      }`}
                      onClick={() => setTabVisible(id, !visible)}
                    >
                      <Icon size={14} className="shrink-0" />
                      <SideChatTabLabel name={name} suffix={suffix} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          aria-label="New side chat"
          title="New side chat"
          disabled={starting}
          className={`${iconClass} disabled:opacity-50`}
          onClick={() => {
            setStarting(true);
            void onStart().finally(() => setStarting(false));
          }}
        >
          <Plus size={15} />
        </button>
      </div>
    </nav>
  );
}

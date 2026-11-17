import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { CodexHomeDescriptor } from "@codex-deck/api";
import { Check, ChevronDown, House, Plus } from "lucide-react";

interface CodexHomeSelectorProps {
  homes: CodexHomeDescriptor[];
  selectedHomeId: string;
  loading: boolean;
  onSelectHome: (homeId: string) => void;
  onAddHome: () => void;
}

export default function CodexHomeSelector({
  homes,
  selectedHomeId,
  loading,
  onSelectHome,
  onAddHome,
}: CodexHomeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selectedHome = homes.find((home) => home.id === selectedHomeId);
  const label = loading ? "Loading homes…" : (selectedHome?.label ?? "Main");

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const menu = menuRef.current;
    const selected = menu?.querySelector<HTMLButtonElement>(
      '[aria-checked="true"]:not(:disabled)',
    );
    (
      selected ??
      menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    )?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      setIsOpen(false);
      triggerRef.current?.focus();
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    );
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let nextIndex: number;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % items.length;
        break;
      case "ArrowUp":
        nextIndex = (currentIndex - 1 + items.length) % items.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={loading}
        aria-label={`Codex home: ${label}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setIsOpen(true);
          }
        }}
        className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-zinc-300 transition-colors hover:bg-zinc-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50 disabled:cursor-wait disabled:opacity-60 ${isOpen ? "bg-zinc-800/60" : ""}`}
      >
        <House className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Codex homes"
          onKeyDown={handleMenuKeyDown}
          className="absolute left-0 right-0 z-40 mt-1.5 overflow-hidden rounded-xl border border-zinc-700/60 bg-zinc-900 p-1 shadow-xl"
        >
          <div
            className="px-2.5 pb-1.5 pt-2 text-[11px] font-medium text-zinc-500"
            aria-hidden="true"
          >
            Codex homes
          </div>
          <div
            role="group"
            aria-label="Available Codex homes"
            className="max-h-[min(20rem,calc(100dvh-12rem))] overflow-y-auto overscroll-contain"
          >
            {homes.map((home) => {
              const selected = home.id === selectedHomeId;
              return (
                <button
                  key={home.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={!home.available}
                  tabIndex={-1}
                  title={home.unavailableReason || home.label}
                  onClick={() => {
                    setIsOpen(false);
                    triggerRef.current?.focus();
                    onSelectHome(home.id);
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-zinc-800/70 focus:bg-zinc-800/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-9"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {selected && (
                      <Check
                        className="h-3.5 w-3.5 text-cyan-400"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-zinc-100">
                      {home.label}
                    </span>
                    {!home.available && (
                      <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
                        {home.unavailableReason || "Unavailable"}
                      </span>
                    )}
                  </span>
                  {home.isMain && (
                    <span className="shrink-0 text-[10px] text-zinc-500">
                      Default
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div
            role="separator"
            className="mx-1 my-1 border-t border-zinc-700/60"
          />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setIsOpen(false);
              onAddHome();
            }}
            className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-zinc-300 transition-colors hover:bg-zinc-800/70 hover:text-zinc-100 focus:bg-zinc-800/70 focus:text-zinc-100 focus:outline-none"
          >
            <Plus
              className="h-4 w-4 shrink-0 text-zinc-400"
              aria-hidden="true"
            />
            Add Codex home
          </button>
        </div>
      )}
    </div>
  );
}

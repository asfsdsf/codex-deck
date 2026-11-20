import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { GitFork } from "lucide-react";
import {
  getTurnActionItems,
  type ConversationTurnAction,
  type MessageTurnBusyState,
  type MessageTurnRole,
} from "../conversation-turn-actions";

/** Overflow menu for history operations anchored to one rendered message. */
export function MessageTurnActions({
  role,
  busy,
  onAction,
  buttonClassName,
}: {
  role: MessageTurnRole;
  busy: MessageTurnBusyState;
  onAction: (action: ConversationTurnAction) => void;
  buttonClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const items = getTurnActionItems(role, busy);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const button = buttonRef.current;
    if (!open || !menu || !button) return;
    const anchor = button.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(anchor.right - width, window.innerWidth - width - 8),
    );
    const below = anchor.bottom + 4;
    const top =
      below + height + 8 <= window.innerHeight
        ? below
        : Math.max(8, anchor.top - height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (menuRef.current?.contains(target) ||
          buttonRef.current?.contains(target))
      )
        return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    const dismiss = () => close();
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [close, open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        className={buttonClassName}
        title="Conversation history actions"
        aria-label="Conversation history actions"
        aria-haspopup="menu"
        aria-expanded={open}
        data-message-turn-actions={role}
      >
        <GitFork size={12} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Conversation history actions"
            className="fixed z-50 w-[min(18rem,calc(100vw-16px))] rounded-lg border border-zinc-700 bg-zinc-900 p-1 text-zinc-200 shadow-2xl"
          >
            {items.map((item) => (
              <button
                key={item.action}
                type="button"
                role="menuitem"
                disabled={item.disabledReason !== null}
                title={item.disabledReason ?? undefined}
                onClick={() => {
                  close();
                  onAction(item.action);
                }}
                className="flex min-h-11 w-full flex-col items-start justify-center rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-zinc-800 focus-visible:bg-zinc-800 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                data-turn-action={item.action}
              >
                <span className="font-medium text-zinc-100">{item.label}</span>
                <span className="text-[11px] text-zinc-400">
                  {item.disabledReason ?? item.description}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

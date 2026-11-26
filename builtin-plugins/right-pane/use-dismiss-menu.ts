import { useEffect, type RefObject } from "react";
export function useDismissMenu(
  ref: RefObject<HTMLDivElement | null>,
  close: (open: boolean) => void,
) {
  useEffect(() => {
    function dismiss(event: PointerEvent | KeyboardEvent) {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !ref.current?.contains(event.target as Node)
      )
        close(false);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [ref, close]);
}
